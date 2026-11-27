package dev.tavernworks.rosin

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Rosin for Android. Opening the app switches Rosin on (RosinService) and shows the full Rosin page, where you
 * talk or type to Rosin. Leaving the app leaves Rosin on: it floats over the home screen and other apps with no
 * box around it, chats by itself now and then, and talks in speech bubbles. Tap the floating Rosin to come back
 * here. The notification switches Rosin off.
 *
 * The laptop key is entered once under ⋯ → Laptop key, the same as in a browser. It stays in this app's
 * own storage on this phone.
 */
class MainActivity : Activity() {

    companion object {
        const val ACTION_OPEN = "dev.tavernworks.rosin.OPEN"
        private const val REQ_MIC = 7
        private const val REQ_NOTIF = 8
    }

    private lateinit var box: FrameLayout
    private val micWaiters = mutableListOf<(Boolean) -> Unit>()
    var isOnScreen = false; private set

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT

        box = FrameLayout(this)
        box.setBackgroundColor(0xFF0D130B.toInt())
        setContentView(box)
        // Keep the page clear of the status bar, the gesture bar, a notch and the keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(box) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
            )
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        RosinHost.attach(this, box)
        RosinService.start(this) { copyTestLine(intent) }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            !prefs().getBoolean("askedNotif", false)) {
            prefs().edit().putBoolean("askedNotif", true).apply()
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIF)
        } else askToFloat()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        RosinService.start(this) { copyTestLine(intent) }
    }

    private fun Intent.copyTestLine(from: Intent?) {
        from?.getStringExtra(RosinService.EXTRA_TEST_SAY)?.let { putExtra(RosinService.EXTRA_TEST_SAY, it) }
    }

    private fun prefs() = getSharedPreferences("rosin_app", MODE_PRIVATE)

    /** Once: ask for "Display over other apps", which lets Rosin float over the home screen. */
    private fun askToFloat() {
        if (RosinOverlay.allowed(this) || prefs().getBoolean("askedFloat", false) || isFinishing) return
        prefs().edit().putBoolean("askedFloat", true).apply()
        AlertDialog.Builder(this)
            .setTitle("Let Rosin float on your screen?")
            .setMessage("Rosin can sit over your home screen and other apps, with no box around it, and talk in speech bubbles. " +
                "Tap Rosin to come back here. Android calls this \"Display over other apps\": turn it on for Rosin on the next screen.")
            .setPositiveButton("Turn it on") { _, _ ->
                try { startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))) } catch (_: Exception) {}
            }
            .setNegativeButton("Not now", null)
            .show()
    }

    /** The page finished loading (called by RosinHost). */
    fun pageReady() {}

    /** Asks for the microphone once, then tells every waiter. */
    fun withMic(done: (Boolean) -> Unit) {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) { done(true); return }
        micWaiters += done
        if (micWaiters.size == 1) requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_NOTIF) { RosinService.start(this); askToFloat(); return }
        if (requestCode != REQ_MIC) return
        val ok = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
        val waiters = micWaiters.toList(); micWaiters.clear()
        waiters.forEach { it(ok) }
    }

    override fun onResume() {
        super.onResume()
        isOnScreen = true
        RosinHost.setOnScreen(true)      // the floating Rosin hides while the app is open
        RosinService.overlay?.refresh()
    }

    override fun onPause() {
        // The page keeps running on purpose (no web.onPause / pauseTimers): Rosin stays on after you leave.
        isOnScreen = false
        RosinHost.setOnScreen(false)
        RosinService.overlay?.refresh()
        super.onPause()
    }

    @Deprecated("Back goes back in the page, then leaves the app with Rosin still on.")
    override fun onBackPressed() {
        val w = RosinHost.web
        if (w != null && w.canGoBack()) w.goBack() else moveTaskToBack(true)
    }

    override fun onDestroy() {
        RosinHost.detach(this)
        super.onDestroy()
    }
}
