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
 * The home screen widget: just Rosin, on a see-through background. While Rosin is talking (a reply, or idle
 * chatter) its words show in a speech bubble, and the bubble goes away when it stops. Tapping Rosin opens
 * the app. Tall or square widgets put the bubble above Rosin; wide ones put it beside Rosin.
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

        private fun openApp(context: Context): PendingIntent {
            val i = Intent(context, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            return PendingIntent.getActivity(context, 3, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }

        /** The newest part of what Rosin is saying, so a long line still fits the bubble. */
        private fun bubbleText(raw: String, max: Int): String {
            val t = raw.replace(Regex("\\s+"), " ").trim()
            if (t.length <= max) return t
            val cut = t.substring(t.length - max)
            val sp = cut.indexOf(' ')
            return "…" + (if (sp in 1..20) cut.substring(sp + 1) else cut)
        }

        fun render(context: Context, manager: AppWidgetManager, id: Int) {
            val o = manager.getAppWidgetOptions(id)
            val w = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 110)
            val h = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 110)
            val wide = w >= h * 1.4f
            val v = RemoteViews(context.packageName, if (wide) R.layout.widget_wide else R.layout.widget_tall)
            val s = WidgetState.load(context)
            val face = s?.optString("face", "normal") ?: "normal"
            val thinking = s?.optBoolean("thinking") == true
            val listening = s?.optBoolean("listening") == true || s?.optBoolean("heard") == true
            val talking = s?.optBoolean("busy") == true || s?.optBoolean("talking") == true
            val words = s?.optString("subs", "").orEmpty()
            val showBubble = talking && !thinking && !listening && words.isNotBlank()

            v.setImageViewResource(R.id.face, WidgetState.faceDrawable(if (thinking) "stoned" else face))
            v.setTextViewText(R.id.bubble, if (showBubble) bubbleText(words, if (wide) 150 else 110) else "")
            v.setViewVisibility(R.id.bubble_box, when {
                showBubble -> android.view.View.VISIBLE
                wide -> android.view.View.INVISIBLE   // keeps Rosin in the same spot when the bubble goes
                else -> android.view.View.GONE
            })
            v.setOnClickPendingIntent(R.id.widget_root, openApp(context))
            v.setOnClickPendingIntent(R.id.face, openApp(context))
            v.setOnClickPendingIntent(R.id.bubble, openApp(context))
            manager.updateAppWidget(id, v)
        }
    }
}
