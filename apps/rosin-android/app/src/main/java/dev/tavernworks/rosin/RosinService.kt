package dev.tavernworks.rosin

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import org.json.JSONObject

/**
 * Keeps Rosin on: the brain page (RosinHost) and the floating Rosin (RosinOverlay) live here, so Rosin keeps
 * chatting, talking and showing speech bubbles with the app closed. A quiet notification says Rosin is on;
 * its buttons hide or show the floating Rosin, or switch Rosin off.
 */
class RosinService : Service() {

    companion object {
        private const val ACTION_STOP = "dev.tavernworks.rosin.STOP"
        private const val ACTION_TOGGLE = "dev.tavernworks.rosin.TOGGLE_OVERLAY"
        const val ACTION_REFRESH = "dev.tavernworks.rosin.REFRESH"
        const val EXTRA_TEST_SAY = "rosin.test_say"
        var overlay: RosinOverlay? = null; private set

        /** Turns Rosin on (or just re-checks the floating Rosin if it's already on). */
        fun start(context: Context, extra: Intent.() -> Unit = {}) {
            try {
                context.startForegroundService(Intent(context, RosinService::class.java).setAction(ACTION_REFRESH).apply(extra))
            } catch (_: Exception) {
                // Android won't start it from the background right now; it starts next time the app opens.
            }
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private var greeted = false
    private val stateFn: (JSONObject) -> Unit = { s -> maybeGreet(s) }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        goForeground()
        RosinHost.ensure(this)
        overlay = RosinOverlay(this).also { it.start() }
        RosinHost.listen(stateFn)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        goForeground()
        when (intent?.action) {
            ACTION_STOP -> { stopSelf(); return START_NOT_STICKY }
            ACTION_TOGGLE -> {
                if (!RosinOverlay.allowed(this)) {
                    try {
                        startActivity(Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                            android.net.Uri.parse("package:$packageName")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    } catch (_: Exception) {}
                } else RosinOverlay.setEnabled(this, !RosinOverlay.enabled(this))
                goForeground()
            }
        }
        RosinHost.ensure(this)
        overlay?.refresh()
        // For automatic tests on emulators only (never on a real phone): show a line in the bubble.
        intent?.getStringExtra(EXTRA_TEST_SAY)?.takeIf { Build.TYPE != "user" }?.let { line ->
            RosinHost.onState(JSONObject().put("face", "happy").put("subs", line).put("talking", true), pinMs = 20_000)
            main.postDelayed({ RosinHost.onState(JSONObject().put("face", "normal")) }, 20_500)
        }
        return START_STICKY
    }

    /** Once the laptop answers after Rosin switches on, Rosin speaks up by itself instead of waiting minutes. */
    private fun maybeGreet(s: JSONObject) {
        if (greeted || !s.optString("status").startsWith("Ready")) return
        greeted = true
        main.postDelayed({
            RosinHost.js("window.RosinBrain && window.RosinBrain.settings.chatter && window.RosinBrain.chatterNow()")
        }, 12_000)
    }

    private fun goForeground() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("rosin", getString(R.string.notif_channel), NotificationManager.IMPORTANCE_MIN))
        fun pi(code: Int, i: Intent, activity: Boolean = false) =
            if (activity) PendingIntent.getActivity(this, code, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            else PendingIntent.getService(this, code, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val open = pi(0, Intent(this, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN), activity = true)
        val toggle = pi(1, Intent(this, RosinService::class.java).setAction(ACTION_TOGGLE))
        val stop = pi(2, Intent(this, RosinService::class.java).setAction(ACTION_STOP))
        val floating = RosinOverlay.allowed(this) && RosinOverlay.enabled(this)
        val n = Notification.Builder(this, "rosin")
            .setSmallIcon(R.drawable.ic_notif)
            .setContentTitle("Rosin is on")
            .setContentText(getString(if (floating) R.string.notif_text else R.string.notif_text_hidden))
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, if (floating) "Hide from screen" else "Show on screen", toggle).build())
            .addAction(Notification.Action.Builder(null, "Switch off", stop).build())
            .build()
        try {
            when {
                Build.VERSION.SDK_INT >= 34 -> startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
                Build.VERSION.SDK_INT >= 29 -> startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
                else -> startForeground(1, n)
            }
        } catch (_: Exception) {}
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        RosinHost.unlisten(stateFn)
        overlay?.stop(); overlay = null
        RosinHost.destroy()
        super.onDestroy()
    }
}
