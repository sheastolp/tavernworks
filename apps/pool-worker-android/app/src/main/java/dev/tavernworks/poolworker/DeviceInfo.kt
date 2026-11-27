package dev.tavernworks.poolworker

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.GLES20
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager

/** What the phone is, as far as Android lets an app see. */
object DeviceInfo {

    fun model(): String = (Build.MANUFACTURER.replaceFirstChar { it.uppercase() } + " " + Build.MODEL).trim()

    /** A pool-friendly machine name: 'Pixel-8', 'SM-S921U'. */
    fun defaultName(): String =
        Build.MODEL.replace(Regex("[^A-Za-z0-9_-]+"), "-").trim('-').take(32).ifEmpty { "android-phone" }

    fun soc(): String =
        if (Build.VERSION.SDK_INT >= 31 && Build.SOC_MODEL.isNotBlank() && Build.SOC_MODEL != Build.UNKNOWN)
            (Build.SOC_MANUFACTURER + " " + Build.SOC_MODEL).trim()
        else Build.HARDWARE

    /** The GPU's name from OpenGL ES ('Adreno (TM) 750', 'Mali-G715'), read once and saved. */
    fun gpuRenderer(cfg: Config): String {
        cfg.gpuRenderer.takeIf { it.isNotEmpty() }?.let { return it }
        val r = runCatching { queryRenderer() }.getOrNull().orEmpty()
        if (r.isNotEmpty()) cfg.gpuRenderer = r
        return r
    }

    private fun queryRenderer(): String {
        val display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        val ver = IntArray(2)
        if (!EGL14.eglInitialize(display, ver, 0, ver, 1)) return ""
        try {
            val attribs = intArrayOf(
                EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
                EGL14.EGL_SURFACE_TYPE, EGL14.EGL_PBUFFER_BIT,
                EGL14.EGL_NONE)
            val configs = arrayOfNulls<EGLConfig>(1)
            val n = IntArray(1)
            if (!EGL14.eglChooseConfig(display, attribs, 0, configs, 0, 1, n, 0) || n[0] == 0) return ""
            val ctx = EGL14.eglCreateContext(display, configs[0], EGL14.EGL_NO_CONTEXT,
                intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0)
            val surf = EGL14.eglCreatePbufferSurface(display, configs[0],
                intArrayOf(EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE), 0)
            try {
                EGL14.eglMakeCurrent(display, surf, surf, ctx)
                return GLES20.glGetString(GLES20.GL_RENDERER).orEmpty()
            } finally {
                EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
                EGL14.eglDestroySurface(display, surf)
                EGL14.eglDestroyContext(display, ctx)
            }
        } finally {
            EGL14.eglTerminate(display)
        }
    }

    /** 'Adreno 750' from 'Adreno (TM) 750'. */
    fun gpuShortName(renderer: String): String {
        Regex("(?i)adreno\\D*(\\d{3})").find(renderer)?.let { return "Adreno " + it.groupValues[1] }
        return renderer.ifEmpty { "unknown GPU" }
    }

    /** 7 for an Adreno 750; 0 for anything that isn't an Adreno. */
    fun adrenoGen(renderer: String): Int =
        Regex("(?i)adreno\\D*(\\d)\\d\\d").find(renderer)?.groupValues?.get(1)?.toIntOrNull() ?: 0

    fun totalRamMb(context: Context): Long {
        val am = context.getSystemService(ActivityManager::class.java)
        val mi = ActivityManager.MemoryInfo()
        am.getMemoryInfo(mi)
        return mi.totalMem / (1024 * 1024)
    }

    /** Phones share one pool of RAM between the GPU, apps and Android, and Android kills big
     *  background processes under pressure: offer a third of RAM, 512 MB steps, 1-6 GB. */
    fun autoOfferedMb(ramMb: Long): Int {
        if (ramMb <= 0) return 2048
        val third = (ramMb / 3 / 512) * 512
        return third.coerceIn(1024, 6144).toInt()
    }

    data class Battery(val plugged: Boolean, val tempC: Float, val percent: Int)

    fun battery(context: Context): Battery {
        val i: Intent? = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val plugged = (i?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
        val temp = (i?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) ?: 0) / 10f
        val level = i?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = i?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
        return Battery(plugged, temp, if (level >= 0 && scale > 0) level * 100 / scale else -1)
    }

    /** Android's own heat level for the whole phone (0 none .. 6 shutdown), from the maker's
     *  sensors and rules. -1 when Android is older than 10 and doesn't say. Makers set their own
     *  trip points, and some report "severe" while the case still feels cool. */
    fun thermalStatus(context: Context): Int {
        if (Build.VERSION.SDK_INT < 29) return -1
        return runCatching { context.getSystemService(PowerManager::class.java).currentThermalStatus }.getOrDefault(-1)
    }

    fun thermalName(status: Int): String = when (status) {
        0 -> "none"; 1 -> "light"; 2 -> "moderate"; 3 -> "severe"
        4 -> "critical"; 5 -> "emergency"; 6 -> "shutdown"; else -> "not reported"
    }
}
