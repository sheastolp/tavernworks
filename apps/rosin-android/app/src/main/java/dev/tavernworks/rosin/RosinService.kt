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

/**
 * While Rosin is listening, thinking or talking, this keeps the app running (with a quiet notification)
 * so a reply finishes even if you switch apps or lock the phone. It stops about 20 seconds after Rosin
 * goes quiet.
 */
class RosinService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("talking", getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val n = Notification.Builder(this, "talking")
            .setSmallIcon(R.drawable.ic_notif)
            .setContentTitle("Rosin")
            .setContentText(getString(R.string.notif_text))
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            else startForeground(1, n)
        } catch (_: Exception) { stopSelf() }
        return START_NOT_STICKY
    }

    companion object {
        private val main = Handler(Looper.getMainLooper())
        private var running = false

        fun start(context: Context) {
            main.removeCallbacksAndMessages(STOP_TOKEN)
            if (running) return
            try {
                context.startForegroundService(Intent(context, RosinService::class.java))
                running = true
            } catch (_: Exception) {
                // Android won't start it from the background; the reply still runs, it just has less protection.
            }
        }

        fun stopLater(context: Context) {
            if (!running) return
            main.removeCallbacksAndMessages(STOP_TOKEN)
            main.postAtTime({ stop(context) }, STOP_TOKEN, android.os.SystemClock.uptimeMillis() + 20_000)
        }

        fun stop(context: Context) {
            main.removeCallbacksAndMessages(STOP_TOKEN)
            if (!running) return
            running = false
            context.stopService(Intent(context, RosinService::class.java))
        }

        private val STOP_TOKEN = Any()
    }
}
