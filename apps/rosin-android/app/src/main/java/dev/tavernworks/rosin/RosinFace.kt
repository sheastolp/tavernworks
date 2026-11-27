package dev.tavernworks.rosin

import android.content.Context
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.Path
import android.graphics.RectF
import android.widget.ImageView
import kotlin.math.abs
import kotlin.math.hypot

/**
 * Floating Rosin's picture, whose eye can turn. The faces are flat pictures, so the eye is drawn a second time,
 * shifted a little, inside the eye's own outline: the slit moves and the rim shows on the far side, as if the eye
 * turned. The whole picture turns that way too, in 3D, a little less than the eye, so Rosin faces the spot with its eye
 * leading. lookAt() takes a direction from -1 to 1 on each axis; Rosin eases there over a few frames.
 */
class RosinFace(context: Context, private val onTurned: () -> Unit) : ImageView(context) {

    companion object {
        // Where the eye sits in the 384 x 384 face pictures (from rosin/layers.js), and how far it turns.
        private const val CX = 220.7f; private const val CY = 220.3f
        private const val RX = 44.6f * 0.95f; private const val RY = 33.8f * 0.95f
        private const val MAX_X = 44.6f * 0.22f; private const val MAX_Y = 33.8f * 0.20f
        private val OPEN_EYES = setOf("normal", "surprise", "anger", "confused")
        /** Where Rosin's eye is in the picture, as a fraction of its width and height. */
        const val EYE_X = CX / 384f; const val EYE_Y = CY / 384f
        /** How far the whole of Rosin turns, in degrees, left-right and up-down. */
        private const val TURN_Y = 24f; private const val TURN_X = 14f
    }

    init {
        // Far enough away that turning reads as a turn, not a stretch.
        cameraDistance = 9000f * resources.displayMetrics.density
    }

    private var face = ""
    private var tx = 0f; private var ty = 0f   // where the eye is heading
    private var gx = 0f; private var gy = 0f   // where it is
    private val clip = Path()

    fun setFace(name: String, res: Int) {
        if (name == face) return
        face = name
        setImageResource(res)
    }

    fun lookAt(x: Float, y: Float) {
        tx = x.coerceIn(-1f, 1f); ty = y.coerceIn(-1f, 1f)
        animate().rotationY(tx * TURN_Y).rotationX(-ty * TURN_X).setDuration(350).start()
        postInvalidateOnAnimation()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        post(onTurned)   // the screen turned: Rosin moves back onto it and looks to the new middle
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val d = drawable ?: return
        if (face !in OPEN_EYES) return
        gx += (tx - gx) * 0.18f; gy += (ty - gy) * 0.18f
        if (abs(tx - gx) + abs(ty - gy) > 0.01f) postInvalidateOnAnimation() else { gx = tx; gy = ty }
        if (hypot(gx, gy) < 0.02f) return
        val k = d.intrinsicWidth / 384f
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
