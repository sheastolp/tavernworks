package dev.tavernworks.rosin

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.provider.CalendarContract
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.util.TimeZone

/**
 * window.RosinCalendar for the mood compass (rosin/rosin-compass.js): reads the phone's own calendar, only after
 * the person says yes, and only the next events' titles and times. Nothing is written to the calendar.
 */
class CalendarBridge(private val app: Context) {

    private val main = Handler(Looper.getMainLooper())
    private fun granted() = app.checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED

    @JavascriptInterface
    fun status(): String = if (granted()) "granted" else "prompt"

    /** Asks for the calendar (needs the app's screen), then tells the page with a "rosin-calendar" event. */
    @JavascriptInterface
    fun request() {
        main.post {
            val done = { RosinHost.js("window.dispatchEvent(new Event('rosin-calendar'))") }
            val a = RosinHost.currentActivity()
            if (granted() || a == null) done() else a.withCalendar { done() }
        }
    }

    /** Events between two times (ms), as JSON: [{ title, start, end, allDay }]. */
    @JavascriptInterface
    fun events(from: Double, to: Double): String {
        val out = JSONArray()
        if (!granted()) return out.toString()
        val start = from.toLong(); val end = to.toLong().coerceAtMost(start + 31L * 24 * 3600 * 1000)
        val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().also {
            ContentUris.appendId(it, start); ContentUris.appendId(it, end)
        }.build()
        val cols = arrayOf(
            CalendarContract.Instances.TITLE, CalendarContract.Instances.BEGIN, CalendarContract.Instances.END,
            CalendarContract.Instances.ALL_DAY, CalendarContract.Instances.SELF_ATTENDEE_STATUS
        )
        try {
            app.contentResolver.query(uri, cols, "${CalendarContract.Instances.VISIBLE} = 1", null,
                "${CalendarContract.Instances.BEGIN} ASC")?.use { c ->
                val tz = TimeZone.getDefault()
                while (c.moveToNext() && out.length() < 200) {
                    if (c.getInt(4) == CalendarContract.Attendees.ATTENDEE_STATUS_DECLINED) continue
                    val allDay = c.getInt(3) == 1
                    var b = c.getLong(1); var e = c.getLong(2)
                    // All-day events are stored at midnight UTC; the page wants this phone's own midnight.
                    if (allDay) { b -= tz.getOffset(b); e -= tz.getOffset(e) }
                    out.put(JSONObject().put("title", c.getString(0) ?: "").put("start", b).put("end", e).put("allDay", allDay))
                }
            }
        } catch (_: Exception) {}
        return out.toString()
    }
}
