package dev.tavernworks.rosin

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * Rosin for Android: tavernworks.dev/rosin/ in a WebView, with the phone's own speech-to-text and
 * text-to-speech plugged in (see NativeBridge and assets/rosin-bridge.js), and the home screen widget fed
 * with Rosin's face and what Rosin is saying.
 *
 * The laptop key is entered once under ⋯ → Laptop key, the same as in a browser. It stays in this app's
 * own storage on this phone.
 */
class MainActivity : Activity() {

    companion object {
        const val HOST = "tavernworks.dev"
        const val START_URL = "https://tavernworks.dev/rosin/?app=android&device=android-app"
        const val ACTION_TALK = "dev.tavernworks.rosin.TALK"
        const val ACTION_TYPE = "dev.tavernworks.rosin.TYPE"
        const val ACTION_OPEN = "dev.tavernworks.rosin.OPEN"
        private const val REQ_MIC = 7
        @Volatile var visible = false
    }

    private lateinit var web: WebView
    lateinit var bridge: NativeBridge
        private set
    private val main = Handler(Looper.getMainLooper())
    private var pendingAction: String? = null
    private var actionTries = 0
    private val micWaiters = mutableListOf<(Boolean) -> Unit>()
    private var showingError = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT

        val box = FrameLayout(this)
        box.setBackgroundColor(0xFF0D130B.toInt())
        web = WebView(this)
        web.setBackgroundColor(0xFF0D130B.toInt())
        box.addView(web, FrameLayout.LayoutParams(-1, -1))
        setContentView(box)
        // Keep the page clear of the status bar, the gesture bar, a notch and the keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(box) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
            )
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            setSupportZoom(false)
            userAgentString = "$userAgentString RosinApp/Android"
        }
        // Rosin keeps answering while the app is in the background, so don't let Android drop the page first.
        web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)

        bridge = NativeBridge(this, web)
        web.addJavascriptInterface(bridge, "RosinNative")
        val shim = assets.open("rosin-bridge.js").bufferedReader().use { it.readText() }
        val startScript = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        if (startScript) WebViewCompat.addDocumentStartJavaScript(web, shim, setOf("https://$HOST"))

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (uri.scheme == "https" && uri.host == HOST) return false
                openOutside(uri)
                return true
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                // Older WebViews without document-start scripts: best effort, early in the load.
                if (!startScript && Uri.parse(url).host == HOST) view.evaluateJavascript(shim, null)
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (!showingError) runPendingAction()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showOffline(error.description?.toString() ?: "")
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val fromRosin = request.origin?.host == HOST
                val wantsMic = request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
                if (!fromRosin || !wantsMic) { request.deny(); return }
                withMic { ok ->
                    if (ok) request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else request.deny()
                }
            }
        }

        if (savedInstanceState != null) web.restoreState(savedInstanceState)
        if (web.url == null) web.loadUrl(START_URL)
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        val action = intent?.action ?: return
        if (action == ACTION_TALK || action == ACTION_TYPE) {
            pendingAction = action
            actionTries = 0
            runPendingAction()
        }
    }

    /** Waits for the page's brain (window.RosinBrain), then starts listening or opens the keyboard. */
    private fun runPendingAction() {
        val action = pendingAction ?: return
        web.evaluateJavascript("!!(window.RosinBrain && window.Rosin)") { ready ->
            if (pendingAction != action) return@evaluateJavascript
            if (ready != "true") {
                if (++actionTries < 40) main.postDelayed({ runPendingAction() }, 400) else pendingAction = null
                return@evaluateJavascript
            }
            pendingAction = null
            when (action) {
                ACTION_TALK -> web.evaluateJavascript("window.RosinBrain.micStart(); true", null)
                ACTION_TYPE -> {
                    web.evaluateJavascript(
                        "(() => { const b = document.getElementById('say-text'); if (b) { b.focus(); b.scrollIntoView({block:'nearest'}); } return true; })()"
                    ) {
                        web.requestFocus(View.FOCUS_DOWN)
                        val imm = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
                        imm.showSoftInput(web, InputMethodManager.SHOW_IMPLICIT)
                    }
                }
            }
        }
    }

    /**
     * Tells the page which device Rosin is on, so replies fit it: "android-app" while the app is on screen,
     * "android-widget" while it's in the background and Rosin's words only reach the home screen widget's
     * speech bubbles (very short replies). The page sees it as ?device=… in its address, window.RosinDevice,
     * and a "rosin-device" event.
     */
    private fun tellDevice(name: String) {
        if (::web.isInitialized) web.evaluateJavascript("window.__rosinNative && window.__rosinNative.device('$name')", null)
    }

    /** Asks for the microphone once, then tells every waiter. */
    fun withMic(done: (Boolean) -> Unit) {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) { done(true); return }
        micWaiters += done
        if (micWaiters.size == 1) requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_MIC) return
        val ok = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
        val waiters = micWaiters.toList(); micWaiters.clear()
        waiters.forEach { it(ok) }
    }

    private fun openOutside(uri: Uri) {
        try { startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) {}
    }

    private fun showOffline(why: String) {
        showingError = true
        val html = """
            <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
            <body style="margin:0;background:#0d130b;color:#f3dcc0;font:16px/1.5 system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center">
            <div style="padding:24px;max-width:420px"><p style="font-size:20px;margin:0 0 8px">Rosin can't load right now.</p>
            <p style="opacity:.75;margin:0 0 20px">Check this phone's internet, then try again.<br><small>${why.replace("<", "&lt;")}</small></p>
            <a href="$START_URL" style="display:inline-block;padding:14px 28px;border-radius:14px;background:#3a1309;border:1px solid #8c2c14;color:#f3dcc0;text-decoration:none">Try again</a></div></body>
        """.trimIndent()
        web.loadDataWithBaseURL("https://$HOST/rosin/offline", html, "text/html", "utf-8", null)
        main.postDelayed({ showingError = false }, 500)
    }

    override fun onResume() {
        super.onResume()
        visible = true
        web.onResume()
        web.resumeTimers()
        tellDevice("android-app")
    }

    override fun onPause() {
        // The page keeps running in the background on purpose (no web.onPause / pauseTimers), so a reply that
        // is under way finishes and Rosin keeps reading Twitch chat if that's on.
        visible = false
        tellDevice("android-widget")   // what Rosin says now only shows in the widget's speech bubbles
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    @Deprecated("Back goes back in the page, then leaves Rosin running in the background.")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
    }

    override fun onDestroy() {
        bridge.shutdown()
        WidgetState.quiet(this)        // Rosin stopped, so no speech bubble should stay on the home screen
        RosinWidget.refreshAll(this)
        RosinService.stop(this)
        web.destroy()
        super.onDestroy()
    }
}
