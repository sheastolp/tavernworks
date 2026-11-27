package dev.tavernworks.rosin

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.RemoteViews

/**
 * The home screen widget. Resize it freely: small shows Rosin's face (tap to talk), wide or tall adds
 * what Rosin is doing, the last reply, and Talk / Type buttons. It shows whatever the app last saw;
 * tapping Rosin's face opens the app.
 */
class RosinWidget : AppWidgetProvider() {

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        ids.forEach { render(context, manager, it) }
    }

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, newOptions: Bundle) {
        render(context, manager, id)
    }

    companion object {
        private val main = Handler(Looper.getMainLooper())
        private var queued = false
        private var lastAt = 0L

        /** Redraws every Rosin widget, at most about once a second. */
        fun refreshSoon(context: Context) {
            if (queued) return
            queued = true
            val wait = (900 - (System.currentTimeMillis() - lastAt)).coerceAtLeast(0)
            main.postDelayed({ queued = false; lastAt = System.currentTimeMillis(); refreshAll(context) }, wait)
        }

        fun refreshAll(context: Context) {
            val m = AppWidgetManager.getInstance(context)
            m.getAppWidgetIds(ComponentName(context, RosinWidget::class.java)).forEach { render(context, m, it) }
        }

        private fun pending(context: Context, action: String, code: Int): PendingIntent {
            val i = Intent(context, MainActivity::class.java).setAction(action)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            return PendingIntent.getActivity(context, code, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }

        private fun shortStatus(raw: String): String {
            val s = raw.trim().ifEmpty { "Rosin" }
            return if (s.length > 48) s.take(46) + "…" else s
        }

        fun render(context: Context, manager: AppWidgetManager, id: Int) {
            val o = manager.getAppWidgetOptions(id)
            val w = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250)
            val h = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 110)
            val layout = when {
                w < 150 || h < 90 -> R.layout.widget_small
                w >= h * 1.2 -> R.layout.widget_wide
                h >= 200 -> R.layout.widget_tall
                else -> R.layout.widget_small
            }
            val v = RemoteViews(context.packageName, layout)
            val s = WidgetState.load(context)
            val face = s?.optString("face", "normal") ?: "normal"
            val thinking = s?.optBoolean("thinking") == true
            val busy = s?.optBoolean("busy") == true
            val listening = s?.optBoolean("listening") == true
            val subs = s?.optString("subs", "").orEmpty()
            val reply = s?.optString("reply", "").orEmpty()
            val status = when {
                listening -> "Listening…"
                thinking -> "Thinking…"
                busy -> "Talking"
                s == null -> "Rosin"
                else -> shortStatus(s.optString("status", "Rosin"))
            }
            v.setImageViewResource(R.id.face, WidgetState.faceDrawable(if (thinking) "stoned" else face))
            v.setTextViewText(R.id.status, if (layout == R.layout.widget_small && !thinking && !busy && !listening) "Tap to talk" else status)
            if (layout != R.layout.widget_small) {
                val line = when {
                    (busy || listening) && subs.isNotBlank() -> subs
                    reply.isNotBlank() -> reply
                    else -> context.getString(R.string.waiting)
                }
                v.setTextViewText(R.id.line, line)
                v.setOnClickPendingIntent(R.id.btn_talk, pending(context, MainActivity.ACTION_TALK, 1))
                v.setOnClickPendingIntent(R.id.btn_type, pending(context, MainActivity.ACTION_TYPE, 2))
                v.setOnClickPendingIntent(R.id.face, pending(context, MainActivity.ACTION_OPEN, 3))
                v.setOnClickPendingIntent(R.id.line, pending(context, MainActivity.ACTION_OPEN, 3))
            } else {
                v.setOnClickPendingIntent(R.id.widget_root, pending(context, MainActivity.ACTION_TALK, 1))
            }
            manager.updateAppWidget(id, v)
        }
    }
}
