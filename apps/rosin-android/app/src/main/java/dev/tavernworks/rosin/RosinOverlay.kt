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
 * While Spotify has a song on, a small bar under Rosin shows it with back, play/pause, skip and like buttons, and the
 * top antennae glow with the song (gold for liked songs), as in the main app. The bar stays while the song plays and
 * for 5 minutes after it's paused; holding Rosin down shows or hides it.
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

    // ---------- the music bar ----------
    private val songText = TextView(context).apply {
        setTextColor(0xFFF6E7D2.toInt())
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        maxLines = 1
        ellipsize = android.text.TextUtils.TruncateAt.END
        gravity = Gravity.CENTER
        setPadding(dp(12f), dp(6f), dp(12f), 0)
    }
    private fun musicButton(label: String, desc: String, cmd: String) = TextView(context).apply {
        text = label; contentDescription = desc
        gravity = Gravity.CENTER
        setTextColor(0xFFF6E7D2.toInt())
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
        context.obtainStyledAttributes(intArrayOf(android.R.attr.selectableItemBackgroundBorderless)).let { a -> background = a.getDrawable(0); a.recycle() }
        isClickable = true
        setOnClickListener { music(cmd) }
    }
    private val bPrev = musicButton("⏮", "Previous song", "prev")
    private val bPlay = musicButton("▶", "Play", "toggle")
    private val bNext = musicButton("⏭", "Next song", "next")
    private val bLike = musicButton("♡", "Save to Liked Songs", "like")
    private val barBg = android.graphics.drawable.GradientDrawable().apply {
        setColor(0xEB1C120C.toInt()); cornerRadius = dp(22f).toFloat(); setStroke(dp(1.5f), 0x66FFBF3F)
    }
    private val bar = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        background = barBg
        setPadding(dp(4f), 0, dp(4f), dp(2f))
        addView(songText, LinearLayout.LayoutParams(-1, -2))
        val row = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        for (b in listOf(bPrev, bPlay, bNext, bLike)) row.addView(b, LinearLayout.LayoutParams(dp(48f), dp(48f)))
        addView(row, LinearLayout.LayoutParams(-2, -2).apply { gravity = Gravity.CENTER_HORIZONTAL })
    }
    private var barShown = false
    private var barPinned: Boolean? = null   // held down: true shows the bar even when paused, false hides it
    private var music: JSONObject? = null
    private var pausedAt = 0L

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
    private val barLp = params(true, WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT)
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
        hideBubble(); hideBar()
        if (rosinShown) { try { wm.removeView(rosin) } catch (_: Exception) {}; rosinShown = false }
        bob?.cancel(); bob = null
    }

    /** Re-checks whether Rosin should be on screen (permission, the on/off switch, the app being open). */
    fun refresh() = render(RosinHost.state)

    private fun render(s: JSONObject) {
        val show = allowed(context) && enabled(context) && !RosinHost.appOnScreen
        if (!show) { hideBubble(); hideBar(); if (rosinShown) { try { wm.removeView(rosin) } catch (_: Exception) {}; rosinShown = false; bob?.cancel() }; return }
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

        showMusic(s.optJSONObject("music"))

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

    /** What Spotify is playing (from the page; null with nothing on): the antennae glow and the music bar. */
    private fun showMusic(m: JSONObject?) {
        val was = music
        music = m
        val playing = m?.optBoolean("playing") == true
        val color = m?.optString("color", "")?.let { c -> try { if (c.isEmpty()) null else android.graphics.Color.parseColor(c) } catch (_: Exception) { null } }
        if (m != null && color != null) rosin.setSong(color, if (playing) 1f else 0.45f, playing) else rosin.setSong(0, 0f, false)
        if (m == null) { barPinned = null; pausedAt = 0L; hideBar(); return }
        if (playing) pausedAt = 0L else if (pausedAt == 0L || was == null) pausedAt = android.os.SystemClock.uptimeMillis()
        // A new song coming on brings the bar back after it was hidden by hand.
        if (playing && barPinned == false && was != null && was.optString("title") != m.optString("title")) barPinned = null
        val title = m.optString("title"); val by = m.optString("by")
        songText.text = if (by.isNotEmpty()) "$title · $by" else title
        bPlay.text = if (playing) "⏸" else "▶"; bPlay.contentDescription = if (playing) "Pause" else "Play"
        val liked = m.optBoolean("liked")
        bLike.text = if (liked) "♥" else "♡"; bLike.contentDescription = if (liked) "In your Liked Songs, tap to remove" else "Save to Liked Songs"
        bLike.setTextColor(if (liked) 0xFFFFBF3F.toInt() else 0xFFF6E7D2.toInt())
        bLike.visibility = if (m.optBoolean("canLike", true)) View.VISIBLE else View.GONE
        barBg.setStroke(dp(1.5f), ((color ?: 0xFFBF3F) and 0xFFFFFF) or 0x88000000.toInt())
        val recent = playing || android.os.SystemClock.uptimeMillis() - pausedAt < PAUSED_SHOW_MS
        if (barPinned ?: recent) showBar() else hideBar()
        // Paused: check back once the 5 minutes are up, in case nothing else changes by then.
        main.removeCallbacksAndMessages(BAR_TIMEOUT)
        if (!playing && barPinned == null && recent)
            main.postAtTime({ render(RosinHost.state) }, BAR_TIMEOUT, pausedAt + PAUSED_SHOW_MS + 100)
    }
    private val BAR_TIMEOUT = Any()
    private val PAUSED_SHOW_MS = 5 * 60_000L

    /** A tap on the bar: the page does it with Spotify; the button changes at once, and the page's answer confirms it. */
    private fun music(cmd: String) {
        val m = music ?: return
        when (cmd) {
            "toggle" -> { val p = !m.optBoolean("playing"); bPlay.text = if (p) "⏸" else "▶"; bPlay.contentDescription = if (p) "Pause" else "Play" }
            "like" -> { val l = !m.optBoolean("liked"); bLike.text = if (l) "♥" else "♡"; bLike.setTextColor(if (l) 0xFFFFBF3F.toInt() else 0xFFF6E7D2.toInt()) }
        }
        RosinHost.js("window.RosinMusic && window.RosinMusic.cmd('$cmd')")
    }

    private fun measureBar() {
        val dm = context.resources.displayMetrics
        val maxW = minOf(dp(260f), dm.widthPixels - dp(8f))
        songText.maxWidth = maxW - dp(8f)
        bar.measure(View.MeasureSpec.makeMeasureSpec(maxW, View.MeasureSpec.AT_MOST), View.MeasureSpec.makeMeasureSpec(dm.heightPixels / 3, View.MeasureSpec.AT_MOST))
        // At least as wide as its buttons, and wide enough for a short title to show in full.
        barLp.width = maxOf(bar.measuredWidth, dp(210f)).coerceAtMost(maxW)
        barLp.height = bar.measuredHeight
    }

    private fun showBar() {
        if (!rosinShown) return
        measureBar()
        if (!barShown) {
            placeBar(update = false)
            bar.alpha = 0f
            try { wm.addView(bar, barLp); barShown = true } catch (_: Exception) { return }
            bar.animate().alpha(1f).setDuration(150).start()
        } else { placeBar(update = false); try { wm.updateViewLayout(bar, barLp) } catch (_: Exception) {} }
        placeBubble()
    }

    private fun hideBar() {
        if (!barShown) return
        barShown = false
        try { wm.removeView(bar) } catch (_: Exception) {}
        placeBubble()
    }

    /** Under Rosin, centred on it, kept on screen; above Rosin if there's no room below. */
    private fun placeBar(update: Boolean = true) {
        if (update && !barShown) return
        val (w, h) = screen()
        val bw = barLp.width.takeIf { it > 0 } ?: return
        val bh = barLp.height
        val below = rosinLp.y + size - dp(10f)
        barLp.x = (rosinLp.x + size / 2 - bw / 2).coerceIn(dp(4f), (w - bw - dp(4f)).coerceAtLeast(dp(4f)))
        barLp.y = if (below + bh <= h - dp(8f)) below else (rosinLp.y + dp(10f) - bh).coerceAtLeast(0)
        if (update) try { wm.updateViewLayout(bar, barLp) } catch (_: Exception) {}
    }
    private fun barAbove() = barShown && barLp.y < rosinLp.y

    /** Holding Rosin down shows the music bar, or hides it if it's showing. */
    private fun toggleBar() {
        if (music == null) {
            android.widget.Toast.makeText(context, "Nothing's playing on Spotify.", android.widget.Toast.LENGTH_SHORT).show()
            return
        }
        barPinned = !barShown
        render(RosinHost.state)
    }

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
        val top = if (barAbove()) minOf(rosinLp.y + dp(15f), barLp.y + dp(4f)) else rosinLp.y + dp(15f)
        val above = top - bh
        tail.visibility = if (above >= 0) View.VISIBLE else View.INVISIBLE
        val x = (rosinLp.x + size / 2 - bw / 2).coerceIn(dp(4f), (dm.widthPixels - bw - dp(4f)).coerceAtLeast(dp(4f)))
        val y = if (above >= 0) above else (if (barShown && !barAbove()) barLp.y + barLp.height else rosinLp.y + size - dp(6f))
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
        val ex = rosinLp.x + pad + img * RosinFace.EYE_X
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
        if (barShown) { measureBar(); placeBar() }
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
        android.widget.Toast.makeText(context, "Rosin's closed. Bring it back from Rosin's notification.",
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
        private var held = false
        private val hold = Runnable {
            if (!dragging) { held = true; rosin.performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS); toggleBar() }
        }
        override fun onTouch(v: View, e: MotionEvent): Boolean {
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX; downY = e.rawY; startX = rosinLp.x; startY = rosinLp.y; dragging = false; held = false
                    main.postDelayed(hold, ViewConfiguration.getLongPressTimeout().toLong())
                }
                MotionEvent.ACTION_CANCEL -> { main.removeCallbacks(hold); if (dragging) { hideClose(); prefs.edit().putInt("x", rosinLp.x).putInt("y", rosinLp.y).apply() } }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - downX; val dy = e.rawY - downY
                    if (!dragging && !held && (abs(dx) > slop || abs(dy) > slop)) { dragging = true; main.removeCallbacks(hold); showClose() }
                    if (dragging) {
                        rosinLp.x = startX + dx.toInt(); rosinLp.y = startY + dy.toInt(); clamp()
                        try { wm.updateViewLayout(rosin, rosinLp) } catch (_: Exception) {}
                        placeBar(); placeBubble(); aim()
                        markClose(overClose())
                    }
                }
                MotionEvent.ACTION_UP -> {
                    main.removeCallbacks(hold)
                    if (held) return true   // held down: the music bar was shown or hidden, nothing else
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
