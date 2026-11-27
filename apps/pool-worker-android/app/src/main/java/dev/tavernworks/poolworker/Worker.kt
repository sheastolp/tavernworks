package dev.tavernworks.poolworker

import android.content.Context
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * The phone's side of the pool, the same steps as pool-worker.py:
 *   1. enroll (or reuse the saved enrollment) and wait for the operator's approval;
 *   2. start the bundled rpc-server on 127.0.0.1 (Adreno GPU when the pool's model allows it,
 *      else CPU);
 *   3. hold one relay WebSocket to the pool front, which carries the host's RPC traffic;
 *   4. yield the phone to its owner: unplugged (if set), a hot battery or severe throttling
 *      drain it out of the pool, and it rejoins after a quiet delay.
 */
class Worker(private val context: Context) {
    private val cfg = Config(context)
    private val engine = Engine(context, cfg)
    @Volatile private var stopping = false
    private val lock = Object()
    @Volatile private var relay: RelaySession? = null

    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
    private val wsClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(150, TimeUnit.SECONDS)
        // A ping every 45 s; OkHttp drops the relay when one goes unanswered (the front pings too).
        .pingInterval(45, TimeUnit.SECONDS)
        .build()

    fun stop() {
        stopping = true
        relay?.close("the owner stopped the worker")
        synchronized(lock) { lock.notifyAll() }
    }

    /** Sleeps, but wakes at once when the worker is stopped. */
    private fun pause(ms: Long) {
        if (stopping) return
        synchronized(lock) { lock.wait(ms) }
    }

    fun run() {
        try {
            loop()
        } catch (e: Exception) {
            if (!stopping) {
                WorkerState.log("stopped: " + (e.message ?: e.javaClass.simpleName))
                WorkerState.phase(Phase.Error, e.message ?: "unexpected error")
            }
        } finally {
            relay?.close("worker stopped")
            engine.stop()
            WorkerState.set { it.copy(relayConnected = false, streams = 0, servingOn = "") }
            if (stopping) WorkerState.phase(Phase.Idle)
        }
    }

    // ------------------------------------------------------------ http
    private fun httpJson(method: String, path: String, body: JSONObject? = null): Pair<Int, JSONObject> {
        val b = Request.Builder().url(cfg.poolUrl + path).header("User-Agent", "pool-worker-android")
        if (body != null) b.method(method, body.toString().toRequestBody("application/json".toMediaType()))
        http.newCall(b.build()).execute().use { r ->
            val text = r.body?.string().orEmpty()
            val obj = runCatching { JSONObject(text) }.getOrDefault(JSONObject())
            return r.code to obj
        }
    }

    // ------------------------------------------------------------ enroll
    private fun gpuLabel(): String {
        val r = DeviceInfo.gpuRenderer(cfg)
        return DeviceInfo.gpuShortName(r) + " (" + DeviceInfo.soc() + ")"
    }

    private fun ensureEnrolled() {
        if (cfg.enrolled) return
        WorkerState.phase(Phase.Enrolling, "Registering this phone with the pool")
        if (cfg.name.isEmpty()) cfg.name = DeviceInfo.defaultName()
        if (cfg.offeredMb < 512) cfg.offeredMb = DeviceInfo.autoOfferedMb(DeviceInfo.totalRamMb(context))
        val (code, obj) = httpJson("POST", "/enroll", JSONObject()
            .put("name", cfg.name)
            .put("offered_mb", cfg.offeredMb)
            .put("gpu", gpuLabel())
            .put("os", "android"))
        if (code != 201) throw IllegalStateException(
            "the pool refused the enrollment (" + code + "): " + obj.optString("error", obj.toString()))
        cfg.enrollmentId = obj.getString("id")
        cfg.key = obj.getString("key")
        WorkerState.log("enrolled as ${cfg.name} (${cfg.offeredMb} MB), id ${cfg.enrollmentId.take(8)}")
        WorkerState.set { it.copy(enrolled = true) }
    }

    /** "approved", "pending", "revoked", "bad-key", or "" when the pool can't be reached. */
    private fun pollStatus(): String = try {
        val (code, obj) = httpJson("GET", "/enroll/" + cfg.enrollmentId + "?key=" + cfg.key)
        when (code) {
            200 -> obj.optString("status")
            403 -> "bad-key"
            404 -> "gone"
            else -> ""
        }
    } catch (_: Exception) { "" }

    private fun waitForApproval(): Boolean {
        var last: String? = null
        while (!stopping) {
            val s = pollStatus()
            if (s != last) { WorkerState.log("enrollment status: " + s.ifEmpty { "pool unreachable" }); last = s }
            when (s) {
                "approved" -> { WorkerState.set { it.copy(approved = true) }; return true }
                "bad-key", "gone" -> {
                    // The pool no longer knows this enrollment: start over with a fresh one.
                    WorkerState.log("the pool doesn't know this phone's enrollment any more, enrolling again")
                    cfg.forgetEnrollment()
                    WorkerState.set { it.copy(enrolled = false, approved = false) }
                    ensureEnrolled()
                    last = null
                    continue
                }
                "pending" -> WorkerState.phase(Phase.WaitingApproval,
                    "Approve ${cfg.name} in the pool's Roster. It joins by itself once you do.")
                "" -> WorkerState.phase(Phase.WaitingApproval, "Can't reach ${cfg.poolUrl}, retrying")
                else -> WorkerState.phase(Phase.WaitingApproval, "The pool says this phone is $s")
            }
            WorkerState.set { it.copy(approved = false) }
            pause(20_000)
        }
        return false
    }

    // ------------------------------------------------------------ engine
    private fun poolModel(): String = try {
        val (code, obj) = httpJson("GET", "/model.json")
        if (code == 200) obj.optString("file") else ""
    } catch (_: Exception) { "" }

    private fun phoneHasGpuEngine(): Boolean =
        cfg.backend != "cpu" && !cfg.gpuFailed && DeviceInfo.adrenoGen(DeviceInfo.gpuRenderer(cfg)) >= 7

    private fun wantDevice(model: String): Engine.Device =
        if (phoneHasGpuEngine() && model.isNotEmpty() && Engine.modelGpuOk(model)) Engine.Device.GPU
        else Engine.Device.CPU

    /** Warns when the pool's pinned llama.cpp build isn't the one inside this app. */
    private fun checkPin() {
        val pin = try {
            val (code, obj) = httpJson("GET", "/downloads/manifest.json")
            if (code != 200) return
            val comps = obj.optJSONArray("components") ?: return
            (0 until comps.length()).mapNotNull { comps.getJSONObject(it).optString("name") }
                .filter { "-android-arm64" in it && it.startsWith("llama-") }
                .mapNotNull { Regex("llama-b(\\d+)-").find(it)?.groupValues?.get(1)?.toIntOrNull() }
                .maxOrNull() ?: return
        } catch (_: Exception) { return }
        val mine = BuildConfig.ENGINE_PIN.removePrefix("b").toIntOrNull() ?: return
        val warn = if (pin != mine)
            "The pool runs llama.cpp b$pin but this app has b$mine. Splits may fail until the app is updated."
        else ""
        if (warn.isNotEmpty()) WorkerState.log(warn)
        WorkerState.set { it.copy(pinWarning = warn) }
    }

    private fun startEngine(model: String) {
        val want = wantDevice(model)
        if (want == Engine.Device.CPU && phoneHasGpuEngine() && model.isNotEmpty())
            WorkerState.log("the pool's model ($model) has layers the Adreno GPU can't compute; lending RAM and CPU instead")
        WorkerState.phase(Phase.Starting, "Starting rpc-server on the " + want.label)
        try {
            engine.start(want)
        } catch (e: Exception) {
            if (want == Engine.Device.GPU) {
                WorkerState.log("the Adreno engine would not start (${e.message}); switching this phone to the CPU engine")
                cfg.gpuFailed = true
                engine.start(Engine.Device.CPU)
            } else throw e
        }
        WorkerState.log("rpc-server serving on the " + engine.device!!.label +
            if (engine.cacheOn) " with its tensor cache" else "")
        WorkerState.set { it.copy(servingOn = engine.device!!.label) }
    }

    // ------------------------------------------------------------ owner first
    /** Heat that has to last this long before the worker steps out, so a brief spike doesn't pause it. */
    private var hotSince = 0L

    /**
     * Why the phone should step out of the pool now, or null. [serving] true means it's in the pool:
     * heat then has to last [HEAT_GRACE_MS] first (the safety floor pauses at once). While paused, it
     * rejoins only once the battery is 2 °C under the limit and Android's level is below the trigger.
     */
    private fun yieldReason(serving: Boolean = false): String? {
        val b = DeviceInfo.battery(context)
        val status = DeviceInfo.thermalStatus(context)
        WorkerState.set { it.copy(heat = heatText(b.tempC, status)) }
        if (cfg.onlyWhileCharging && !b.plugged) { hotSince = 0; return "Unplugged. Plug the phone in and it rejoins." }

        val mode = cfg.heatMode
        val margin = if (serving) 0f else 2f
        val floor = HeatMode.Off
        val hotReason: String? = when {
            b.tempC >= floor.batteryC || (status >= floor.status) ->
                return "Too hot to keep going safely (${heatText(b.tempC, status)}). It rejoins once it cools.".also { hotSince = 0 }
            b.tempC >= mode.batteryC - margin ->
                "Battery at %.1f °C (limit %.0f °C on %s). It rejoins once it cools.".format(b.tempC, mode.batteryC, mode.label)
            status >= 0 && status >= mode.status ->
                "Android reports the phone's heat as \"${DeviceInfo.thermalName(status)}\" (battery %.1f °C). ".format(b.tempC) +
                    "It rejoins once that eases. Settings > Heat pause > Relaxed or Off ignores this."
            else -> null
        }
        if (hotReason == null) { hotSince = 0; return null }
        if (!serving) return hotReason
        val now = System.currentTimeMillis()
        if (hotSince == 0L) {
            hotSince = now
            WorkerState.log("hot: $hotReason Waiting ${HEAT_GRACE_MS / 1000} s to see if it lasts.")
        }
        return if (now - hotSince >= HEAT_GRACE_MS) hotReason else null
    }

    private fun heatText(tempC: Float, status: Int): String =
        "battery %.1f °C · Android: %s".format(tempC, DeviceInfo.thermalName(status))

    // ------------------------------------------------------------ serve
    private fun loop() {
        WorkerState.set { it.copy(enrolled = cfg.enrolled) }
        ensureEnrolled()
        if (!waitForApproval()) return
        checkPin()
        var backoff = 2_000L
        var model = poolModel()
        WorkerState.set { it.copy(poolModel = model) }
        var lastModelCheck = System.currentTimeMillis()
        while (!stopping) {
            val reason = yieldReason()
            if (reason != null) {
                WorkerState.log("yielding: $reason")
                engine.stop()
                WorkerState.set { it.copy(servingOn = "") }
                while (!stopping) {
                    val r = yieldReason() ?: break
                    WorkerState.phase(Phase.Yielding, r)
                    pause(10_000)
                }
                if (!stopping) {
                    WorkerState.phase(Phase.Yielding, "Free again, rejoining in ${REJOIN_DELAY_MS / 1000} s")
                    pause(REJOIN_DELAY_MS)
                }
                continue
            }
            if (stopping) break
            if (!engine.alive) startEngine(model)

            WorkerState.phase(Phase.Connecting, "Opening the relay to the pool")
            val session = RelaySession(wsClient, cfg.poolUrl, cfg.enrollmentId, cfg.key, cfg.rpcPort)
            relay = session
            // Wait for the upgrade (or its refusal).
            val t0 = System.currentTimeMillis()
            while (session.alive && !session.connected && System.currentTimeMillis() - t0 < 40_000) Thread.sleep(100)
            if (!session.connected) {
                session.close("no answer")
                relay = null
                if (session.refusedCode == 403) {
                    WorkerState.log("relay refused (enrollment not approved), back to waiting for approval")
                    engine.stop()
                    if (!waitForApproval()) return
                    continue
                }
                WorkerState.log("relay connect failed: " + session.closeReason)
                WorkerState.phase(Phase.Connecting, "Can't reach the relay, retrying")
                pause(backoff)
                backoff = (backoff * 2).coerceAtMost(30_000)
                continue
            }
            backoff = 2_000L
            WorkerState.set { it.copy(relayConnected = true) }
            WorkerState.phase(Phase.Serving, "Lending " + gb(cfg.offeredMb) + " on the " + engine.device?.label)

            // Watch the session: yield, a dead rpc-server, or a model change the other device suits.
            var yielded = false
            while (session.alive && !stopping) {
                pause(2_000)
                val why = yieldReason(serving = true)
                if (why != null) {
                    WorkerState.log("yielding ($why), draining out of the pool")
                    yielded = true
                    session.close("the phone's owner needs it")
                    break
                }
                if (!engine.alive) {
                    WorkerState.log("rpc-server died, dropping the relay to restart it")
                    session.close("rpc-server restart")
                    break
                }
                if (System.currentTimeMillis() - lastModelCheck > 60_000) {
                    lastModelCheck = System.currentTimeMillis()
                    val m = poolModel()
                    if (m.isNotEmpty() && m != model) {
                        model = m
                        WorkerState.set { it.copy(poolModel = m) }
                        if (wantDevice(m) != engine.device && session.streamCount == 0) {
                            WorkerState.log("the pool's model changed, restarting rpc-server on the " + wantDevice(m).label)
                            session.close("switching device")
                            engine.stop()
                            break
                        }
                    }
                }
            }
            session.await()
            relay = null
            WorkerState.set { it.copy(relayConnected = false, streams = 0) }
            if (yielded) {
                WorkerState.phase(Phase.Yielding, "Draining")
                pause(DRAIN_GRACE_MS)
                engine.stop()
                WorkerState.set { it.copy(servingOn = "") }
            } else if (!stopping) {
                WorkerState.log(session.closeReason.ifEmpty { "relay closed" } + ", reconnecting")
                pause(3_000)
            }
        }
    }

    companion object {
        fun gb(mb: Int): String = if (mb % 1024 == 0) "${mb / 1024} GB" else "%.1f GB".format(mb / 1024.0)
        const val REJOIN_DELAY_MS = 120_000L
        const val HEAT_GRACE_MS = 30_000L
        const val DRAIN_GRACE_MS = 10_000L
    }
}
