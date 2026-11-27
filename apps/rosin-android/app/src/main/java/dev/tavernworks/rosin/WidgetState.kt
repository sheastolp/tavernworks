package dev.tavernworks.rosin

import android.content.Context
import org.json.JSONObject

/** The last thing the app saw Rosin do, kept so the widget can show it even when the app isn't running. */
object WidgetState {
    private const val PREFS = "rosin_widget"

    fun save(context: Context, s: JSONObject) {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        p.edit().putString("state", s.toString()).putLong("at", System.currentTimeMillis()).apply()
    }

    fun load(context: Context): JSONObject? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("state", null)?.let {
            try { JSONObject(it) } catch (_: Exception) { null }
        }

    fun faceDrawable(face: String): Int = when (face) {
        "stoned" -> R.drawable.rosin_stoned
        "happy" -> R.drawable.rosin_happy
        "laugh" -> R.drawable.rosin_laugh
        "surprise" -> R.drawable.rosin_surprise
        "anger" -> R.drawable.rosin_anger
        "confused" -> R.drawable.rosin_confused
        else -> R.drawable.rosin_normal
    }
}
