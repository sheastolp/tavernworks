package dev.tavernworks.rosin

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import kotlin.math.abs

/**
 * Rosin floating over the home screen and other apps, with no box around it. While Rosin talks, its words
 * show in a speech bubble above it, and the bubble goes away when Rosin stops. Tapping Rosin opens the app;
 * dragging moves Rosin. The bubble takes no touches at all, so whatever is under it still works.
 *
 * It needs "Display over other apps", which the app asks for. It hides while the app itself is open.
 */
class RosinOverlay(private val context: Context) {

    companion object {
        private const val PREFS = "rosin_overlay"
        fun allowed(context: Context) = Settings.canDrawOverlays(context)
        fun enabled(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("on", true)
        fun setEnabled(context: Context, on: Boolean) =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("on", on).apply()
    }

    private val wm = context.getSystemService(WindowManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private fun dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, context.resources.displayMetrics).toInt()

    private val size = dp(128f)   // Rosin is 118 dp; the rest is room to turn in
    private val rosin = RosinFace(context) { turned() }.apply {
        setFace("normal", R.drawable.rosin_normal)
        scaleType = ImageView.ScaleType.FIT_CENTER
        setPadding(dp(5f), dp(5f), dp(5f), dp(5f))
        contentDescription = "Rosin. Tap to open the app."
    }
    private val bubbleText = TextView(context).apply {
        setBackgroundResource(R.drawable.bubble)
        setTextColor(0xFF2A1308.toInt())
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        maxLines = 6
        ellipsize = android.text.TextUtils.TruncateAt.END
    }
    private val tail = ImageView(context).apply { setImageResource(R.drawable.bubble_tail_down) }
    private val bubble = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        addView(bubbleText, LinearLayout.LayoutParams(-2, -2))
        addView(tail, LinearLayout.LayoutParams(dp(18f), dp(12f)).apply { topMargin = -dp(2f) })
    }

    private fun params(touchable: Boolean, w: Int, h: Int) = WindowManager.LayoutParams(
        w, h,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
            (if (touchable) 0 else WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE),
        PixelFormat.TRANSLUCENT
    ).apply { gravity = Gravity.TOP or Gravity.START }

    private val rosinLp = params(true, size, size)
    // The ✕ at the bottom of the screen while Rosin is dragged: drop Rosin on it to close floating Rosin.
    private val closeSize = dp(64f)
    private val closeTarget = ImageView(context).apply { setImageResource(R.drawable.close_target); contentDescription = "Drop Rosin here to close it" }
    private val closeLp = params(false, closeSize, closeSize)
    private var closeShown = false
    private val bubbleLp = params(false, WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT)
    private var rosinShown = false
    private var bubbleShown = false
    private var bob: ObjectAnimator? = null
    private var lastWords = ""
    private val stateFn: (JSONObject) -> Unit = { render(it) }

    fun start() {
        val dm = context.resources.displayMetrics
        rosinLp.x = prefs.getInt("x", dm.widthPixels - size - dp(8f))
        rosinLp.y = prefs.getInt("y", (dm.heightPixels * 0.55f).toInt())
        clamp()
        rosin.setOnTouchListener(Dragger())
        RosinHost.listen(stateFn)
    }

    fun stop() {
        RosinHost.unlisten(stateFn)
        hideClose()
        main.removeCallbacksAndMessages(null)
        hideBubble()
        if (rosinShown) { try { wm.removeView(rosin) } catch (_: Exception) {}; rosinShown = false }
        bob?.cancel(); bob = null
    }

    /** Re-checks whether Rosin should be on screen (permission, the on/off switch, the app being open). */
    fun refresh() = render(RosinHost.state)

    private fun render(s: JSONObject) {
        val show = allowed(context) && enabled(context) && !RosinHost.appOnScreen
        if (!show) { hideBubble(); if (rosinShown) { try { wm.removeView(rosin) } catch (_: Exception) {}; rosinShown = false; bob?.cancel() }; return }
        if (!rosinShown) {
            try { wm.addView(rosin, rosinLp); rosinShown = true } catch (_: Exception) { return }
            aim()
            bob = ObjectAnimator.ofFloat(rosin, View.TRANSLATION_Y, -dp(3f).toFloat(), dp(3f).toFloat()).apply {
                duration = 3000; repeatMode = ValueAnimator.REVERSE; repeatCount = ValueAnimator.INFINITE; start()
            }
        }
        val thinking = s.optBoolean("thinking")
        val f = if (thinking) "stoned" else s.optString("face", "normal")
        rosin.setFace(f, face(f))

        val talking = s.optBoolean("talking") || s.optBoolean("busy")
        val heard = s.optBoolean("listening") || s.optBoolean("heard")
        val words = s.optString("subs", "").replace(Regex("\\s+"), " ").trim()
        if (talking && !thinking && !heard && words.isNotEmpty()) {
            main.removeCallbacksAndMessages(HIDE)
            if (words != lastWords || !bubbleShown) { lastWords = words; bubbleText.text = tailOf(words, 220); showBubble() }
        } else if (bubbleShown) {
            // Linger a moment after the last word, then go.
            main.removeCallbacksAndMessages(HIDE)
            main.postAtTime({ hideBubble() }, HIDE, android.os.SystemClock.uptimeMillis() + 1500)
        }
    }
    private val HIDE = Any()

    private fun tailOf(t: String, max: Int): String {
        if (t.length <= max) return t
        val cut = t.substring(t.length - max)
        val sp = cut.indexOf(' ')
        return "…" + (if (sp in 1..24) cut.substring(sp + 1) else cut)
    }

    private fun showBubble() {
        if (!rosinShown) return
        measureBubble()
        if (!bubbleShown) {
            bubble.alpha = 0f
            placeBubble(update = false)
            try { wm.addView(bubble, bubbleLp); bubbleShown = true } catch (_: Exception) { return }
            bubble.animate().alpha(1f).setDuration(150).start()
        } else placeBubble()
    }

    /** Sizes the bubble's window to its words ourselves; left to Android, the window can come out a word wide. */
    private fun measureBubble() {
        val dm = context.resources.displayMetrics
        val maxW = minOf(dp(240f), dm.widthPixels - dp(8f))
        bubbleText.maxWidth = maxW
        bubble.measure(
            View.MeasureSpec.makeMeasureSpec(maxW, View.MeasureSpec.AT_MOST),
            View.MeasureSpec.makeMeasureSpec(dm.heightPixels / 2, View.MeasureSpec.AT_MOST)
        )
        bubbleLp.width = bubble.measuredWidth
        bubbleLp.height = bubble.measuredHeight
    }

    private fun hideBubble() {
        main.removeCallbacksAndMessages(HIDE)
        if (!bubbleShown) return
        bubbleShown = false; lastWords = ""
        try { wm.removeView(bubble) } catch (_: Exception) {}
    }

    /** Above Rosin, centred on it, kept on screen; below Rosin if there's no room above. */
    private fun placeBubble(update: Boolean = true) {
        if (update && !bubbleShown) return
        val dm = context.resources.displayMetrics
        val bw = bubbleLp.width.takeIf { it > 0 } ?: return
        val bh = bubbleLp.height
        val above = rosinLp.y + dp(15f) - bh
        tail.visibility = if (above >= 0) View.VISIBLE else View.INVISIBLE
        val x = (rosinLp.x + size / 2 - bw / 2).coerceIn(dp(4f), (dm.widthPixels - bw - dp(4f)).coerceAtLeast(dp(4f)))
        val y = if (above >= 0) above else rosinLp.y + size - dp(6f)
        bubbleLp.x = x; bubbleLp.y = y
        if (update) try { wm.updateViewLayout(bubble, bubbleLp) } catch (_: Exception) {}
    }

    private fun screen(): Pair<Int, Int> {
        if (android.os.Build.VERSION.SDK_INT >= 30) wm.currentWindowMetrics.bounds.let { return it.width() to it.height() }
        val dm = context.resources.displayMetrics
        return dm.widthPixels to dm.heightPixels
    }

    private fun clamp() {
        val (w, h) = screen()
        rosinLp.x = rosinLp.x.coerceIn(-size / 3, w - size * 2 / 3)
        rosinLp.y = rosinLp.y.coerceIn(0, h - size * 2 / 3)
    }

    /** Rosin's eye turns toward the middle of the screen from wherever Rosin floats. */
    private fun aim() {
        val (w, h) = screen()
        val pad = dp(5f); val img = size - 2 * pad
        val ex = rosinLp.x + pad + img * (if (rosin.facingLeft) 1f - RosinFace.EYE_X else RosinFace.EYE_X)
        val ey = rosinLp.y + pad + img * RosinFace.EYE_Y
        var vx = (w / 2f - ex) / (w / 2f)
        var vy = (h / 2f - ey) / (h / 2f)
        val len = kotlin.math.hypot(vx, vy)
        if (len > 1f) { vx /= len; vy /= len }
        rosin.lookAt(vx, vy)
    }

    /** The screen turned: keep Rosin on it, the bubble by it, and the eye on the new middle. */
    private fun turned() {
        if (!rosinShown) return
        clamp()
        try { wm.updateViewLayout(rosin, rosinLp) } catch (_: Exception) {}
        placeBubble(); aim()
    }

    private fun showClose() {
        if (closeShown) return
        val (w, h) = screen()
        closeLp.x = w / 2 - closeSize / 2
        closeLp.y = h - closeSize - dp(72f)
        closeTarget.scaleX = 1f; closeTarget.scaleY = 1f; closeTarget.alpha = 0f
        try { wm.addView(closeTarget, closeLp); closeShown = true } catch (_: Exception) { return }
        closeTarget.animate().alpha(1f).setDuration(150).start()
    }

    private fun hideClose() {
        if (!closeShown) return
        closeShown = false
        try { wm.removeView(closeTarget) } catch (_: Exception) {}
    }

    /** Whether Rosin's middle is over the ✕ (with some room, since a finger covers it). */
    private fun overClose(): Boolean {
        if (!closeShown) return false
        val cx = rosinLp.x + size / 2f - (closeLp.x + closeSize / 2f)
        val cy = rosinLp.y + size / 2f - (closeLp.y + closeSize / 2f)
        return kotlin.math.hypot(cx, cy) < closeSize * 1.1f
    }

    private fun markClose(over: Boolean) {
        val s = if (over) 1.25f else 1f
        if (closeTarget.scaleX != s) closeTarget.animate().scaleX(s).scaleY(s).setDuration(120).start()
    }

    /** Dropped on the ✕: floating Rosin goes away until it's switched back on (notification or the app's ⋯ menu). */
    private fun closeFloating() {
        setEnabled(context, false)
        render(RosinHost.state)
        // Next time it's switched on, Rosin comes back where it was before the drag, not on the ✕.
        val dm = context.resources.displayMetrics
        rosinLp.x = prefs.getInt("x", dm.widthPixels - size - dp(8f))
        rosinLp.y = prefs.getInt("y", (dm.heightPixels * 0.55f).toInt())
        clamp()
        RosinService.start(context)   // the notification's button now says "Show on screen"
        android.widget.Toast.makeText(context, "Floating Rosin is closed. Tap \"Show on screen\" in Rosin's notification to bring it back.",
            android.widget.Toast.LENGTH_LONG).show()
    }

    private fun face(f: String) = when (f) {
        "stoned" -> R.drawable.rosin_stoned
        "happy" -> R.drawable.rosin_happy
        "laugh" -> R.drawable.rosin_laugh
        "surprise" -> R.drawable.rosin_surprise
        "anger" -> R.drawable.rosin_anger
        "confused" -> R.drawable.rosin_confused
        else -> R.drawable.rosin_normal
    }

    /** Tap opens the app; drag moves Rosin (and remembers where). */
    private inner class Dragger : View.OnTouchListener {
        private val slop = ViewConfiguration.get(context).scaledTouchSlop
        private var downX = 0f; private var downY = 0f; private var startX = 0; private var startY = 0; private var dragging = false
        override fun onTouch(v: View, e: MotionEvent): Boolean {
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { downX = e.rawX; downY = e.rawY; startX = rosinLp.x; startY = rosinLp.y; dragging = false }
                MotionEvent.ACTION_CANCEL -> { if (dragging) { hideClose(); prefs.edit().putInt("x", rosinLp.x).putInt("y", rosinLp.y).apply() } }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - downX; val dy = e.rawY - downY
                    if (!dragging && (abs(dx) > slop || abs(dy) > slop)) { dragging = true; showClose() }
                    if (dragging) {
                        rosinLp.x = startX + dx.toInt(); rosinLp.y = startY + dy.toInt(); clamp()
                        try { wm.updateViewLayout(rosin, rosinLp) } catch (_: Exception) {}
                        placeBubble(); aim()
                        markClose(overClose())
                    }
                }
                MotionEvent.ACTION_UP -> {
                    if (dragging) {
                        val close = overClose()
                        hideClose()
                        if (close) { closeFloating(); return true }
                        prefs.edit().putInt("x", rosinLp.x).putInt("y", rosinLp.y).apply()
                    }
                    else {
                        v.performClick()
                        context.startActivity(Intent(context, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
                    }
                }
            }
            return true
        }
    }
}
