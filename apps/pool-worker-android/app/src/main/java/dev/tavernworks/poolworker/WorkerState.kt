package dev.tavernworks.poolworker

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

enum class Phase(val label: String) {
    Idle("Not in the pool"),
    Enrolling("Joining"),
    WaitingApproval("Waiting for approval"),
    Starting("Starting the engine"),
    Connecting("Connecting"),
    Serving("In the pool"),
    Yielding("Paused"),
    Error("Stopped"),
}

data class WorkerUi(
    val phase: Phase = Phase.Idle,
    val detail: String = "",
    val serviceRunning: Boolean = false,
    val enrolled: Boolean = false,
    val approved: Boolean = false,
    val relayConnected: Boolean = false,
    val streams: Int = 0,
    val servingOn: String = "",      // "Adreno GPU (OpenCL)" or "CPU"
    val poolModel: String = "",
    val pinWarning: String = "",
    val log: List<String> = emptyList(),
)

/** One place for the worker's live status: the service writes it, the screen and notification read it. */
object WorkerState {
    private val _ui = MutableStateFlow(WorkerUi())
    val ui: StateFlow<WorkerUi> = _ui

    private val stamp = SimpleDateFormat("HH:mm:ss", Locale.US)

    fun set(change: (WorkerUi) -> WorkerUi) = _ui.update(change)

    fun phase(p: Phase, detail: String = "") = _ui.update { it.copy(phase = p, detail = detail) }

    fun log(line: String) {
        android.util.Log.i("PoolWorker", line)
        val entry = stamp.format(Date()) + "  " + line
        _ui.update { it.copy(log = (it.log + entry).takeLast(200)) }
    }
}

/** The worker's saved settings and its enrollment (id + key, shown once by the pool). */
class Config(context: Context) {
    private val p: SharedPreferences = context.getSharedPreferences("pool", Context.MODE_PRIVATE)

    var poolUrl: String
        get() = (p.getString("pool_url", null) ?: DEFAULT_POOL).trimEnd('/')
        set(v) = p.edit().putString("pool_url", v.trim().trimEnd('/')).apply()
    var name: String
        get() = p.getString("name", "") ?: ""
        set(v) = p.edit().putString("name", v.trim()).apply()
    var offeredMb: Int
        get() = p.getInt("offered_mb", 0)
        set(v) = p.edit().putInt("offered_mb", v).apply()
    var enrollmentId: String
        get() = p.getString("enrollment_id", "") ?: ""
        set(v) = p.edit().putString("enrollment_id", v).apply()
    var key: String
        get() = p.getString("key", "") ?: ""
        set(v) = p.edit().putString("key", v).apply()
    /** auto | cpu */
    var backend: String
        get() = p.getString("backend", "auto") ?: "auto"
        set(v) = p.edit().putString("backend", v).apply()
    /** Set when the Adreno engine would not start on this phone; it then stays on the CPU engine. */
    var gpuFailed: Boolean
        get() = p.getBoolean("gpu_failed", false)
        set(v) = p.edit().putBoolean("gpu_failed", v).apply()
    var onlyWhileCharging: Boolean
        get() = p.getBoolean("only_charging", true)
        set(v) = p.edit().putBoolean("only_charging", v).apply()
    var batteryTempLimitC: Float
        get() = p.getFloat("battery_temp_limit_c", 42f)
        set(v) = p.edit().putFloat("battery_temp_limit_c", v).apply()
    /** The user wants the worker on: the service restarts itself after Android stops it. */
    var wantRunning: Boolean
        get() = p.getBoolean("want_running", false)
        set(v) = p.edit().putBoolean("want_running", v).apply()
    var gpuRenderer: String
        get() = p.getString("gpu_renderer", "") ?: ""
        set(v) = p.edit().putString("gpu_renderer", v).apply()

    val rpcPort: Int get() = p.getInt("rpc_port", 50052)
    val enrolled: Boolean get() = enrollmentId.isNotEmpty() && key.isNotEmpty()

    fun forgetEnrollment() = p.edit().remove("enrollment_id").remove("key").apply()

    companion object {
        const val DEFAULT_POOL = "https://pool.tavernworks.dev"
    }
}
