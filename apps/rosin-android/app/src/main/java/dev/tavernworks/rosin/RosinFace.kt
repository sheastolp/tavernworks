package dev.tavernworks.rosin

import android.content.Context
import android.content.res.Configuration
import android.graphics.BlendMode
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.PorterDuffColorFilter
import android.graphics.PorterDuffXfermode
import android.graphics.RectF
import android.os.Build
import android.os.SystemClock
import android.widget.ImageView
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot

/**
 * Floating Rosin's picture, whose eye can turn. The faces are flat pictures, so the eye is drawn a second time,
 * shifted a little, inside the eye's own outline: the slit moves and the rim shows on the far side, as if the eye
 * turned. The whole picture turns that way too, in 3D, a little less than the eye, so Rosin faces the spot with its eye
 * leading. Rosin looks straight ahead, like the main app. lookAt() takes a direction from -1 to 1 on each axis; Rosin
 * eases there over a few frames.
 *
 * While Spotify plays, the crystals in the two top antennae take the song's colour and breathe with a glow, as in the
 * main app (rosin-spotify.js); liked songs are gold. setSong() sets that colour and how strong it shows.
 */
class RosinFace(context: Context, private val onTurned: () -> Unit) : ImageView(context) {

    companion object {
        // Where the eye sits in the 384 x 384 face pictures (made from the page by tools/render_overlay.js and
        // crop_overlay.py), and how far it turns.
        private const val CX = 198.6f; private const val CY = 220.4f
        private const val RX = 44.6f * 0.95f; private const val RY = 33.8f * 0.95f
        private const val MAX_X = 44.6f * 0.22f; private const val MAX_Y = 33.8f * 0.20f
        private val OPEN_EYES = setOf("normal", "surprise", "anger", "confused")
        /** Where Rosin's eye is in the picture, as a fraction of its width and height. */
        const val EYE_X = CX / 384f; const val EYE_Y = CY / 384f
        /** How far the whole of Rosin turns, in degrees, left-right and up-down. */
        private const val TURN_Y = 24f; private const val TURN_X = 14f
    }

    init {
        // The camera about 4.5 Rosins away, like a page's CSS perspective: near enough that the near side grows and
        // the far side shrinks, so the turn reads as a turn. Android counts this distance in its own way (pixels
        // over dpi, times 72), hence the sum.
        val dm = resources.displayMetrics
        cameraDistance = 4.5f * 118f * dm.density * dm.densityDpi / 72f
    }

    private var face = ""
    private var tx = 0f; private var ty = 0f   // where the eye is heading
    private var gx = 0f; private var gy = 0f   // where it is
    private val clip = Path()

    // ---------- the song's glow on the top crystals ----------
    private val gems = context.getDrawable(R.drawable.rosin_gems)!!.mutate()
    private val gemsGlow = context.getDrawable(R.drawable.rosin_gems_glow)!!.mutate()
    private var songColor = 0
    private var songOn = 0f        // 0 no music, 0.45 paused, 1 playing (as --song-on on the page)
    private var songPlaying = false
    private val tintPaint = Paint()
    private val glowPaint = Paint()
    private val start = SystemClock.uptimeMillis()

    fun setSong(color: Int, on: Float, playing: Boolean) {
        if (color == songColor && on == songOn && playing == songPlaying) return
        songColor = color; songOn = on; songPlaying = playing
        gems.colorFilter = PorterDuffColorFilter(color or 0xFF000000.toInt(), PorterDuff.Mode.SRC_IN)
        gemsGlow.colorFilter = PorterDuffColorFilter(color or 0xFF000000.toInt(), PorterDuff.Mode.SRC_IN)
        invalidate()
    }

    fun setFace(name: String, res: Int) {
        if (name == face) return
        face = name
        setImageResource(res)
    }

    fun lookAt(x: Float, y: Float) {
        tx = x.coerceIn(-1f, 1f); ty = y.coerceIn(-1f, 1f)
        // Android's 3D turns run the other way round from a page's CSS across (a positive rotationY brings the right
        // side nearer, so Rosin faces left), and the same way up and down (a positive rotationX faces up).
        animate().scaleX(1f).rotationY(-tx * TURN_Y).rotationX(-ty * TURN_X).setDuration(350).start()
        postInvalidateOnAnimation()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        post(onTurned)   // the screen turned: Rosin moves back onto it and looks to the new middle
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val d = drawable ?: return
        val k = d.intrinsicWidth / 384f
        if (face in OPEN_EYES) {
            gx += (tx - gx) * 0.18f; gy += (ty - gy) * 0.18f
            if (abs(tx - gx) + abs(ty - gy) > 0.01f) postInvalidateOnAnimation() else { gx = tx; gy = ty }
            if (hypot(gx, gy) >= 0.02f) {
                canvas.save()
                canvas.translate(paddingLeft.toFloat(), paddingTop.toFloat())
                canvas.concat(imageMatrix)
                clip.reset()
                clip.addOval(RectF((CX - RX) * k, (CY - RY) * k, (CX + RX) * k, (CY + RY) * k), Path.Direction.CW)
                canvas.clipPath(clip)
                canvas.translate(gx * MAX_X * k, gy * MAX_Y * k)
                d.draw(canvas)
                canvas.restore()
            }
        }
        if (songOn > 0f) drawSong(canvas, d.intrinsicWidth, d.intrinsicHeight)
    }

    /** The crystals take the song's colour (keeping their own light and shade) and a glow breathes around them. */
    private fun drawSong(canvas: Canvas, w: Int, h: Int) {
        canvas.save()
        canvas.translate(paddingLeft.toFloat(), paddingTop.toFloat())
        canvas.concat(imageMatrix)
        val bounds = RectF(0f, 0f, w.toFloat(), h.toFloat())
        // The colour, as the page's mix-blend-mode: color (older phones lack that blend, so they get overlay).
        if (Build.VERSION.SDK_INT >= 29) tintPaint.blendMode = BlendMode.COLOR
        else tintPaint.xfermode = PorterDuffXfermode(PorterDuff.Mode.OVERLAY)
        tintPaint.alpha = (255 * 0.95f * songOn).toInt()
        val c1 = canvas.saveLayer(bounds, tintPaint)
        gems.setBounds(0, 0, w, h); gems.draw(canvas)
        canvas.restoreToCount(c1)
        // The glow: steady while paused, breathing (every 1.8 s, as on the page) while it plays.
        val breathe = if (songPlaying) {
            val t = ((SystemClock.uptimeMillis() - start) % 1800L) / 1800f
            0.12f + 0.48f * (0.5f - 0.5f * cos(t * 2f * PI.toFloat()))
        } else 0.35f
        if (Build.VERSION.SDK_INT >= 29) glowPaint.blendMode = BlendMode.SCREEN
        else glowPaint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SCREEN)
        glowPaint.alpha = (255 * breathe * songOn).toInt().coerceIn(0, 255)
        val c2 = canvas.saveLayer(bounds, glowPaint)
        gemsGlow.setBounds(0, 0, w, h); gemsGlow.draw(canvas)
        canvas.restoreToCount(c2)
        canvas.restore()
        // About 20 frames a second is plenty for a slow breath, and easier on the battery than every frame.
        if (songPlaying) postInvalidateDelayed(50)
    }
}
