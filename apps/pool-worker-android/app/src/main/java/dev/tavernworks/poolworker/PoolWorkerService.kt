package dev.tavernworks.poolworker

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/** Keeps the worker running with the screen off, behind a notification that shows its state. */
class PoolWorkerService : Service() {
    private var worker: Worker? = null
    private var thread: Thread? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    @Volatile private var foreground = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Pool worker", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Shows while this phone works for the AI pool"
            setShowBadge(false)
        })
        scope.launch {
            WorkerState.ui.map { it.phase to it.detail + "|" + it.streams }.distinctUntilChanged().collect {
                if (foreground) nm.notify(NOTIFY_ID, buildNotification())
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            Config(this).wantRunning = false
            foreground = false
            stopWorker()
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        ServiceCompat.startForeground(this, NOTIFY_ID, buildNotification(), type)
        foreground = true
        if (thread?.isAlive != true) startWorker()
        return START_STICKY
    }

    private fun startWorker() {
        val pm = getSystemService(PowerManager::class.java)
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PoolWorker:serve").apply {
            setReferenceCounted(false); acquire()
        }
        val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        @Suppress("DEPRECATION")
        wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "PoolWorker:relay").apply {
            setReferenceCounted(false); acquire()
        }
        val w = Worker(applicationContext)
        worker = w
        WorkerState.set { it.copy(serviceRunning = true) }
        thread = Thread({
            w.run()
            WorkerState.set { it.copy(serviceRunning = false) }
        }, "pool-worker").apply { start() }
    }

    private fun stopWorker() {
        val w = worker ?: return
        val t = thread
        val wl = wakeLock
        val fl = wifiLock
        worker = null; thread = null; wakeLock = null; wifiLock = null
        w.stop()
        // The worker drains and stops rpc-server on its own thread; release the locks after it.
        Thread({
            t?.join(15_000)
            runCatching { wl?.release() }
            runCatching { fl?.release() }
            WorkerState.set { it.copy(serviceRunning = false) }
        }, "pool-worker-stop").start()
    }

    override fun onDestroy() {
        stopWorker()
        scope.cancel()
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        val ui = WorkerState.ui.value
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 1, Intent(this, PoolWorkerService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val title = ui.phase.label + if (ui.phase == Phase.Serving && ui.streams > 0) " · working on a split" else ""
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(title)
            .setContentText(ui.detail.ifEmpty { "AI Pool worker" })
            .setStyle(NotificationCompat.BigTextStyle().bigText(ui.detail.ifEmpty { "AI Pool worker" }))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .addAction(0, "Leave the pool", stop)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    companion object {
        const val CHANNEL = "pool"
        const val NOTIFY_ID = 7
        const val ACTION_STOP = "dev.tavernworks.poolworker.STOP"

        fun start(context: Context) {
            Config(context).wantRunning = true
            context.startForegroundService(Intent(context, PoolWorkerService::class.java))
        }

        fun stop(context: Context) {
            context.startService(Intent(context, PoolWorkerService::class.java).setAction(ACTION_STOP))
        }
    }
}
