package dev.tavernworks.poolworker

import android.content.Context
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.TimeUnit

/**
 * llama.cpp's own ggml-rpc-server for Android, at the pool's pinned build, shipped inside the APK
 * (see fetch-engine.sh). Two builds:
 *   CPU  libpoolrpc_cpu.so + libggml*.so in the native library folder. Every phone.
 *   GPU  libpoolrpc_gpu.so + the Snapdragon build's libraries (copied out of the APK's assets),
 *        which compute on an Adreno 7xx/8xx GPU through the phone's own OpenCL driver.
 * The server listens on 127.0.0.1 only; the relay is the only way in.
 */
class Engine(private val context: Context, private val cfg: Config) {
    enum class Device(val rpcName: String, val label: String) {
        GPU("GPUOpenCL", "Adreno GPU (OpenCL)"),
        CPU("CPU", "CPU"),
    }

    private var proc: Process? = null
    var device: Device? = null
        private set
    var cacheOn = false
        private set

    private val nativeDir = File(context.applicationInfo.nativeLibraryDir)
    private val logFile = File(context.filesDir, "rpc-server.log")
    val cacheDir = File(context.filesDir, "llama-cache")

    val alive: Boolean get() = proc?.isAlive == true

    /** The GPU build's libraries, copied out of the APK the first time (about 50 MB). */
    private fun gpuLibDir(): File {
        val pin = BuildConfig.ENGINE_PIN
        val dir = File(context.filesDir, "engine-gpu-$pin")
        val stamp = File(dir, "PIN")
        if (stamp.isFile && stamp.readText().trim() == pin) return dir
        context.filesDir.listFiles()?.filter { it.name.startsWith("engine-gpu-") }?.forEach { it.deleteRecursively() }
        dir.mkdirs()
        val names = context.assets.list("engine-gpu").orEmpty()
        if (names.isEmpty()) throw IllegalStateException("this APK has no GPU engine inside")
        for (n in names) {
            context.assets.open("engine-gpu/$n").use { inp -> File(dir, n).outputStream().use { inp.copyTo(it) } }
        }
        return dir
    }

    /** Starts rpc-server on [want]. Throws when it can't start, with the reason from its log. */
    fun start(want: Device) {
        stop()
        val port = cfg.rpcPort
        if (portOpen(port)) throw IllegalStateException(
            "port $port is already taken on this phone (is the Termux worker still running?)")
        cacheDir.mkdirs()
        val exe: File
        val libPath: String
        val workDir: File
        if (want == Device.GPU) {
            val gpuDir = gpuLibDir()
            exe = File(nativeDir, "libpoolrpc_gpu.so")
            // The phone's own OpenCL driver lives in /vendor/lib64.
            val vendor = listOf("/vendor/lib64", "/system/vendor/lib64")
                .firstOrNull { File(it, "libOpenCL.so").exists() }
            libPath = listOfNotNull(gpuDir.path, vendor).joinToString(":")
            workDir = gpuDir
        } else {
            exe = File(nativeDir, "libpoolrpc_cpu.so")
            libPath = nativeDir.path
            // The CPU build picks its best CPU variant from the program's own folder.
            workDir = nativeDir
        }
        if (!exe.exists()) throw IllegalStateException("engine missing from the app: ${exe.name}")

        val base = listOf(exe.path, "-H", "127.0.0.1", "-p", port.toString(), "-d", want.rpcName)
        var lastError = ""
        for (cmd in listOf(base + "-c", base)) {
            appendLog("\n===== rpc-server start (${want.rpcName}) " + cmd.joinToString(" ") + " =====\n")
            val pb = ProcessBuilder(cmd).directory(workDir).redirectErrorStream(true)
            pb.environment().apply {
                put("LD_LIBRARY_PATH", libPath)
                put("LLAMA_CACHE", cacheDir.path)
                put("HOME", context.filesDir.path)
                put("TMPDIR", context.cacheDir.path)
            }
            val p = pb.start()
            proc = p
            pumpOutput(p)
            val deadline = System.currentTimeMillis() + 15_000
            while (System.currentTimeMillis() < deadline) {
                if (!p.isAlive) break
                if (portOpen(port)) {
                    device = want
                    cacheOn = "-c" in cmd
                    return
                }
                Thread.sleep(200)
            }
            lastError = tailLog()
            p.destroy()
            proc = null
            if ("-c" in cmd) WorkerState.log("rpc-server would not start with its cache, trying without it")
        }
        throw IllegalStateException("rpc-server exited at startup: " + lastError.ifEmpty { "no output" })
    }

    fun stop() {
        val p = proc ?: return
        p.destroy()
        if (!p.waitFor(5, TimeUnit.SECONDS)) p.destroyForcibly()
        proc = null
        device = null
    }

    private fun pumpOutput(p: Process) {
        Thread({
            runCatching {
                p.inputStream.bufferedReader().forEachLine { line ->
                    appendLog(line + "\n")
                    if (line.contains("error", true) || line.contains("starting", true) ||
                        line.contains("listening", true) || line.contains("device", true)) {
                        WorkerState.log("rpc-server: " + line.trim().take(160))
                    }
                }
            }
        }, "rpc-output").apply { isDaemon = true }.start()
    }

    @Synchronized
    private fun appendLog(s: String) {
        runCatching {
            if (logFile.length() > 5L * 1024 * 1024) logFile.renameTo(File(logFile.path + ".old"))
            logFile.appendText(s)
        }
    }

    private fun tailLog(): String = runCatching {
        logFile.readLines().takeLast(4).joinToString(" | ").take(400)
    }.getOrDefault("")

    companion object {
        fun portOpen(port: Int): Boolean = try {
            Socket().use { it.connect(InetSocketAddress("127.0.0.1", port), 500); true }
        } catch (_: Exception) {
            false
        }

        /** llama.cpp's OpenCL backend runs MoE expert matmuls only for Q4_0, Q8_0 and MXFP4, and the
         *  host never asks a remote device what it supports, so the GPU computes only for those files. */
        fun modelGpuOk(modelFile: String): Boolean {
            val n = modelFile.uppercase()
            return listOf("MXFP4", "Q4_0", "Q8_0").any { it in n }
        }
    }
}
