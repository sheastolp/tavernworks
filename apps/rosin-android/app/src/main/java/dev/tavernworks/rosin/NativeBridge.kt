package dev.tavernworks.rosin

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject

/**
 * What the page can call as window.RosinNative (see assets/rosin-bridge.js, which wraps these into the
 * browser's speechSynthesis and webkitSpeechRecognition). Calls arrive on a background thread; anything
 * that touches the WebView, the recogniser or the widget is posted to the main thread.
 */
class NativeBridge(private val app: android.content.Context, private val web: WebView) : TextToSpeech.OnInitListener {

    private val main = Handler(Looper.getMainLooper())

    // ---------- talking back to the page ----------
    private fun emit(id: Int, type: String, data: Any? = null) {
        val arg = when (data) {
            null -> "null"
            is Number -> data.toString()
            else -> JSONObject.quote(data.toString())
        }
        main.post { web.evaluateJavascript("window.__rosinNative && window.__rosinNative.ev($id, '$type', $arg)", null) }
    }

    // ---------- text to speech (Android's TextToSpeech) ----------
    private var tts: TextToSpeech? = TextToSpeech(app, this)
    @Volatile private var ttsState = 0   // 0 starting, 1 ready, -1 failed
    private val waitingLines = mutableListOf<() -> Unit>()

    override fun onInit(status: Int) {
        val t = tts ?: return
        if (status != TextToSpeech.SUCCESS) {
            ttsState = -1
            synchronized(waitingLines) { waitingLines.forEach { it() }; waitingLines.clear() }
            return
        }
        t.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String) = emit(utteranceId.toInt(), "start")
            override fun onDone(utteranceId: String) = emit(utteranceId.toInt(), "end")
            @Deprecated("Old signature") override fun onError(utteranceId: String) = emit(utteranceId.toInt(), "error", "synthesis-failed")
            override fun onError(utteranceId: String, errorCode: Int) = emit(utteranceId.toInt(), "error", "synthesis-failed")
            override fun onStop(utteranceId: String, interrupted: Boolean) = emit(utteranceId.toInt(), "error", "interrupted")
            override fun onRangeStart(utteranceId: String, start: Int, end: Int, frame: Int) = emit(utteranceId.toInt(), "boundary", start)
        })
        ttsState = 1
        sendVoices()
        synchronized(waitingLines) { waitingLines.forEach { it() }; waitingLines.clear() }
    }

    private fun sendVoices() {
        val t = tts ?: return
        val list = JSONArray()
        try {
            val def = t.defaultVoice
            val all = (t.voices ?: emptySet()).filter { !it.features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) }
                .sortedWith(compareBy({ it.name != def?.name }, { it.isNetworkConnectionRequired }, { -it.quality }, { it.name }))
            for (v in all) list.put(JSONObject().put("name", v.name).put("lang", v.locale.toLanguageTag()).put("local", !v.isNetworkConnectionRequired))
        } catch (_: Exception) {}
        main.post { web.evaluateJavascript("window.__rosinNative && window.__rosinNative.voices(${list})", null) }
    }

    @JavascriptInterface
    fun speak(id: Int, text: String, rate: Double, pitch: Double, volume: Double, voice: String) {
        val go = {
            val t = tts
            if (ttsState != 1 || t == null) emit(id, "error", "synthesis-unavailable")
            else {
                if (voice.isNotEmpty()) t.voices?.firstOrNull { it.name == voice }?.let { t.voice = it }
                t.setSpeechRate(rate.toFloat().coerceIn(0.3f, 3f))
                t.setPitch(pitch.toFloat().coerceIn(0.3f, 2f))
                val params = Bundle().apply { putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, volume.toFloat().coerceIn(0f, 1f)) }
                if (t.speak(text.ifBlank { " " }, TextToSpeech.QUEUE_ADD, params, id.toString()) != TextToSpeech.SUCCESS) emit(id, "error", "synthesis-failed")
            }
        }
        synchronized(waitingLines) { if (ttsState == 0) { waitingLines += go; return } }
        go()
    }

    @JavascriptInterface
    fun cancel() { tts?.stop() }

    // ---------- speech to text (Android's SpeechRecognizer) ----------
    private var recognizer: SpeechRecognizer? = null
    private var recId = 0
    private var recEnded = true

    @JavascriptInterface
    fun hasRecognizer(): Boolean = SpeechRecognizer.isRecognitionAvailable(app)

    @JavascriptInterface
    fun listen(id: Int, lang: String, interim: Boolean) {
        main.post {
            val a = RosinHost.activity
            if (a == null) { emit(id, "start"); emit(id, "error", "not-allowed"); emit(id, "end"); return@post }
            a.withMic { ok ->
                if (!ok) { emit(id, "start"); emit(id, "error", "not-allowed"); emit(id, "end") }
                else startRecognizer(id, lang, interim)
            }
        }
    }

    private fun finish(id: Int) {
        if (id != recId || recEnded) return
        recEnded = true
        emit(id, "end")
    }

    private fun startRecognizer(id: Int, lang: String, interim: Boolean) {
        if (!recEnded) { try { recognizer?.cancel() } catch (_: Exception) {}; finish(recId) }
        recognizer?.destroy()
        val r = SpeechRecognizer.createSpeechRecognizer(app)
        recognizer = r; recId = id; recEnded = false
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
            override fun onPartialResults(partialResults: Bundle?) {
                val t = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                if (!t.isNullOrBlank() && id == recId) emit(id, "partial", t)
            }
            override fun onResults(results: Bundle?) {
                val t = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                if (id != recId) return
                if (!t.isNullOrBlank()) emit(id, "final", t) else emit(id, "error", "no-speech")
                finish(id)
            }
            override fun onError(error: Int) {
                if (id != recId) return
                emit(id, "error", when (error) {
                    SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "no-speech"
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "not-allowed"
                    SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT, SpeechRecognizer.ERROR_SERVER, 11 -> "network"
                    SpeechRecognizer.ERROR_AUDIO -> "audio-capture"
                    12, 13 -> "language-not-supported"
                    else -> "aborted"
                })
                finish(id)
            }
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, interim)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, app.packageName)
        }
        emit(id, "start")
        try { r.startListening(intent) } catch (e: Exception) { emit(id, "error", "audio-capture"); finish(id) }
    }

    @JavascriptInterface
    fun stopListening(id: Int) { main.post { if (id == recId && !recEnded) recognizer?.stopListening() } }

    @JavascriptInterface
    fun abortListening(id: Int) {
        main.post {
            if (id == recId && !recEnded) { try { recognizer?.cancel() } catch (_: Exception) {}; emit(id, "error", "aborted"); finish(id) }
        }
    }

    // ---------- what Rosin is doing, for the floating Rosin's face and speech bubbles ----------
    @JavascriptInterface
    fun state(json: String) {
        val s = try { JSONObject(json) } catch (_: Exception) { return }
        main.post { RosinHost.onState(s) }
    }

    @JavascriptInterface
    fun isApp(): Boolean = true

    /** Whether Rosin floats over other apps when the app is closed (the page's switch under ⋯). */
    @JavascriptInterface
    fun floating(): Boolean = RosinOverlay.enabled(app)

    @JavascriptInterface
    fun setFloating(on: Boolean) {
        RosinOverlay.setEnabled(app, on)
        main.post { RosinService.start(app) }   // refreshes floating Rosin and the notification's button
    }

    fun shutdown() {
        main.removeCallbacksAndMessages(null)
        try { recognizer?.destroy() } catch (_: Exception) {}
        recognizer = null
        tts?.shutdown(); tts = null
    }
}
