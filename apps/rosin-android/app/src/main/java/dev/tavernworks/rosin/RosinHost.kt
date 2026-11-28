package dev.tavernworks.rosin

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.MutableContextWrapper
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * Rosin's brain: the one tavernworks.dev/rosin/ page, kept alive by RosinService for as long as Rosin is on,
 * whether the app is open or not. That page does the thinking, the idle chatter and the talking. When the app
 * is open, MainActivity shows this same page; when it's closed, the page keeps running here and the floating
 * Rosin (RosinOverlay) shows what Rosin says in speech bubbles.
 */
@SuppressLint("StaticFieldLeak")   // holds only the application context (or the open activity, cleared on close)
object RosinHost {
    const val HOST = "tavernworks.dev"
    private const val BASE_URL = "https://tavernworks.dev/rosin/?app=android"
    // Spotify's sign-in pages, on spotify.com and its subdomains (accounts, challenge, www…).
    private fun isSpotify(host: String?) = host == "spotify.com" || host?.endsWith(".spotify.com") == true

    private val main = Handler(Looper.getMainLooper())
    private lateinit var app: Context
    private var ctx: MutableContextWrapper? = null
    var web: WebView? = null; private set
    var bridge: NativeBridge? = null; private set

    /** The open app screen, if any: it asks for the microphone and shows the page's pop-ups. */
    var activity: MainActivity? = null; private set
    val appOnScreen get() = activity?.isOnScreen == true

    /** What Rosin is doing now (face, subs, talking, thinking…), as last reported by the page. */
    var state: JSONObject = JSONObject(); private set
    private val listeners = mutableListOf<(JSONObject) -> Unit>()
    fun listen(fn: (JSONObject) -> Unit) { listeners += fn; fn(state) }
    fun unlisten(fn: (JSONObject) -> Unit) { listeners -= fn }

    private var showingError = false
    private var device = "android-widget"

    val running get() = web != null

    /** Creates the page if it isn't running yet. Main thread only. */
    @SuppressLint("SetJavaScriptEnabled")
    fun ensure(context: Context): WebView {
        web?.let { return it }
        app = context.applicationContext
        val c = MutableContextWrapper(activity ?: app)
        ctx = c
        val w = WebView(c)
        w.setBackgroundColor(0xFF0D130B.toInt())
        with(w.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            @Suppress("DEPRECATION")
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            setSupportZoom(false)
            // RosinApp/Android tells the page it's in the app; Rosin/<version> is shown at the bottom of the ⋯ menu.
            val ver = try { app.packageManager.getPackageInfo(app.packageName, 0).versionName } catch (_: Exception) { null } ?: "?"
            userAgentString = "$userAgentString RosinApp/Android Rosin/$ver"
        }
        // Rosin keeps going while the app is closed, so don't let Android drop the page first.
        w.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)

        val b = NativeBridge(app, w)
        bridge = b
        w.addJavascriptInterface(b, "RosinNative")
        w.addJavascriptInterface(CalendarBridge(app), "RosinCalendar")
        val shim = app.assets.open("rosin-bridge.js").bufferedReader().use { it.readText() }
        val startScript = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        if (startScript) WebViewCompat.addDocumentStartJavaScript(w, shim, setOf("https://$HOST"))

        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (!request.isForMainFrame) return false   // frames inside the page (Spotify's player) stay in the page
                if (uri.scheme == "https" && uri.host == HOST) return false
                // Spotify's sign-in opens inside the app, so the sign-in comes back to Rosin here and not to a browser.
                if (uri.scheme == "https" && isSpotify(uri.host)) return false
                // An app link from a sign-in page (Spotify's "open the app"): open that app if it's here, otherwise its own
                // web fallback if that's Rosin's or Spotify's, and never a Play Store page.
                if (uri.scheme == "intent") { openIntent(view, uri.toString()); return true }
                // The Play Store only when it was tapped, not when a page jumps there by itself.
                if ((uri.scheme == "market" || uri.host == "play.google.com") && !request.hasGesture()) return true
                try { app.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) {}
                return true
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                // Older WebViews without document-start scripts: best effort, early in the load.
                if (!startScript && Uri.parse(url).host == HOST) view.evaluateJavascript(shim, null)
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (!showingError) activity?.pageReady()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showOffline(error.description?.toString() ?: "")
            }
        }

        w.webChromeClient = object : WebChromeClient() {
            // The page's file buttons (a picture for Rosin to look at, a calendar file): the gallery, files or the camera.
            override fun onShowFileChooser(view: WebView, callback: android.webkit.ValueCallback<Array<Uri>>,
                                           params: FileChooserParams): Boolean {
                val a = activity
                if (a == null || Uri.parse(view.url ?: "").host != HOST) { callback.onReceiveValue(null); return true }
                return a.chooseFiles(params, callback)
            }
            override fun onPermissionRequest(request: PermissionRequest) {
                val fromRosin = request.origin?.host == HOST
                // Spotify's player (Play music in Rosin) needs the DRM key system, from Rosin's page or Spotify's player frame.
                if (request.resources.all { it == PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID }) {
                    if (fromRosin || request.origin?.host == "sdk.scdn.co") request.grant(arrayOf(PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID)) else request.deny()
                    return
                }
                val wantsMic = request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
                val a = activity
                if (!fromRosin || !wantsMic || a == null) { request.deny(); return }
                a.withMic { ok -> if (ok) request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else request.deny() }
            }
            // Pop-ups need the app's screen; with the app closed, answer them quietly instead of crashing.
            override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean {
                if (activity != null) return false
                result.confirm(); return true
            }
            override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean {
                if (activity != null) return false
                result.cancel(); return true
            }
        }

        web = w
        device = if (appOnScreen) "android-app" else "android-widget"
        w.loadUrl("$BASE_URL&device=$device")
        return w
    }

    /** The app's screen opened: show the page there. */
    fun attach(a: MainActivity, box: ViewGroup) {
        activity = a
        val w = ensure(a)
        ctx?.baseContext = a
        (w.parent as? ViewGroup)?.removeView(w)
        box.addView(w, ViewGroup.LayoutParams(-1, -1))
        w.onResume(); w.resumeTimers()
    }

    /** The app's screen closed: the page keeps running here, off screen. */
    fun detach(a: Activity) {
        if (activity !== a) return
        activity = null
        val w = web ?: return
        (w.parent as? ViewGroup)?.removeView(w)
        ctx?.baseContext = app
        setOnScreen(false)
    }

    /** Tells the page whether the app is on screen, so Rosin fits its replies: full app, or short speech bubbles. */
    fun setOnScreen(on: Boolean) {
        val d = if (on) "android-app" else "android-widget"
        if (d == device) { notifyListeners(); return }
        device = d
        web?.evaluateJavascript("window.__rosinNative && window.__rosinNative.device('$d')", null)
        notifyListeners()
    }

    /** The app's screen, while it's open (asking for a permission needs it). */
    fun currentActivity(): MainActivity? = activity

    fun js(code: String) { main.post { web?.evaluateJavascript(code, null) } }

    private fun openIntent(view: WebView, url: String) {
        val i = try { Intent.parseUri(url, Intent.URI_INTENT_SCHEME) } catch (_: Exception) { return }
        val fallback = i.getStringExtra("browser_fallback_url")
        i.addCategory(Intent.CATEGORY_BROWSABLE); i.component = null; i.selector = null
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try { app.startActivity(i); return } catch (_: Exception) {}
        val f = fallback?.let { Uri.parse(it) } ?: return
        if (f.scheme == "https" && (f.host == HOST || isSpotify(f.host))) view.loadUrl(f.toString())
    }

    fun reload() { showingError = false; web?.loadUrl("$BASE_URL&device=$device") }

    /**
     * Spotify's answer handed back from a web browser (rosin://spotify-callback?code=…&state=…): when the sign-in left the
     * app (Spotify's "Continue with Google", the Spotify app), the browser's page sends it here, and Rosin's page, which
     * holds the sign-in's key, finishes it. Only code, state and error are passed on.
     */
    fun finishSpotifySignIn(uri: Uri) {
        if (uri.scheme != "rosin" || uri.host != "spotify-callback") return
        val state = uri.getQueryParameter("state") ?: return
        if (!Regex("^rosin[aw]-[A-Za-z0-9_-]{8,64}$").matches(state)) return
        val q = StringBuilder("$BASE_URL&device=$device&state=").append(Uri.encode(state))
        uri.getQueryParameter("code")?.let { q.append("&code=").append(Uri.encode(it)) }
        uri.getQueryParameter("error")?.let { q.append("&error=").append(Uri.encode(it)) }
        showingError = false
        web?.loadUrl(q.toString())
    }

    private var pinnedUntil = 0L

    /** A new state from the page. pinMs holds this one for a while (used only by the emulator test). */
    fun onState(s: JSONObject, pinMs: Long = 0) {
        val now = android.os.SystemClock.uptimeMillis()
        if (pinMs == 0L && now < pinnedUntil) return
        pinnedUntil = if (pinMs > 0) now + pinMs else 0
        state = s
        notifyListeners()
    }

    private fun notifyListeners() = listeners.toList().forEach { it(state) }

    private fun showOffline(why: String) {
        val w = web ?: return
        showingError = true
        val html = """
            <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
            <body style="margin:0;background:#0d130b;color:#f3dcc0;font:16px/1.5 system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center">
            <div style="padding:24px;max-width:420px"><p style="font-size:20px;margin:0 0 8px">Rosin can't load right now.</p>
            <p style="opacity:.75;margin:0 0 20px">Check this phone's internet. Rosin tries again by itself.<br><small>${why.replace("<", "&lt;")}</small></p>
            <a href="$BASE_URL&device=$device" style="display:inline-block;padding:14px 28px;border-radius:14px;background:#3a1309;border:1px solid #8c2c14;color:#f3dcc0;text-decoration:none">Try again</a></div></body>
        """.trimIndent()
        w.loadDataWithBaseURL("https://$HOST/rosin/offline", html, "text/html", "utf-8", null)
        onState(JSONObject())
        main.removeCallbacksAndMessages(RETRY)
        main.postAtTime({ if (showingError) reload() }, RETRY, android.os.SystemClock.uptimeMillis() + 60_000)
    }
    private val RETRY = Any()

    /** Rosin is switched off: the page goes away. */
    fun destroy() {
        main.removeCallbacksAndMessages(null)
        listeners.clear()
        activity?.finishAndRemoveTask()
        activity = null
        bridge?.shutdown(); bridge = null
        web?.let { (it.parent as? ViewGroup)?.removeView(it); it.destroy() }
        web = null
        ctx = null
        state = JSONObject()
    }
}
