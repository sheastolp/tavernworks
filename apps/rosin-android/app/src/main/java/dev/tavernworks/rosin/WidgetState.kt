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

    /** The saved state. If it is more than two minutes old, Rosin can't still be talking, so that part is dropped. */
    fun load(context: Context): JSONObject? {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val s = p.getString("state", null)?.let { try { JSONObject(it) } catch (_: Exception) { null } } ?: return null
        if (System.currentTimeMillis() - p.getLong("at", 0) > 120_000) clearTalking(s)
        return s
    }

    /** Marks Rosin as quiet, for when the app closes, so no speech bubble is left on the home screen. */
    fun quiet(context: Context) {
        val s = load(context) ?: return
        save(context, clearTalking(s))
    }

    private fun clearTalking(s: JSONObject): JSONObject {
        for (k in listOf("busy", "talking", "thinking", "listening", "heard")) s.put(k, false)
        return s.put("subs", "")
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
