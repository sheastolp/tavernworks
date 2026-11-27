package dev.tavernworks.poolworker

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * One relay WebSocket to the pool front (the same protocol as pool-worker.py). The front bridges
 * it to a localhost port on the host; llama-server's RPC traffic travels down it as binary frames:
 *   [stream id: u32 big-endian][type: u8][data]   type 1 = open, 2 = data, 3 = close
 * Each stream is one TCP connection to the local rpc-server.
 */
class RelaySession(
    client: OkHttpClient,
    poolUrl: String,
    enrollmentId: String,
    key: String,
    private val rpcPort: Int,
) : WebSocketListener() {

    @Volatile var alive = true
        private set
    @Volatile var connected = false
        private set
    /** HTTP status when the relay refused the upgrade (403 = not approved). */
    @Volatile var refusedCode = 0
        private set
    @Volatile var closeReason = ""
        private set

    private val streams = ConcurrentHashMap<Long, Socket>()
    private val done = CountDownLatch(1)
    private val ws: WebSocket

    val streamCount: Int get() = streams.size

    init {
        val req = Request.Builder()
            .url("$poolUrl/relay")
            .header("User-Agent", "pool-worker-android")
            .header("X-Enrollment-Id", enrollmentId)
            .header("X-Enrollment-Key", key)
            .build()
        ws = client.newWebSocket(req, this)
    }

    /** Blocks until the relay closes. */
    fun await() = done.await()

    fun close(why: String) {
        if (!alive) return
        closeReason = why
        ws.close(1000, why.take(100))
        // If the close handshake hangs, cut it.
        Thread({
            if (!done.await(5, TimeUnit.SECONDS)) ws.cancel()
        }, "relay-close").apply { isDaemon = true }.start()
    }

    override fun onOpen(webSocket: WebSocket, response: Response) {
        connected = true
        WorkerState.log("relay connected, this phone is in the pool")
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
        if (bytes.size < 5) return
        val buf = bytes.asByteBuffer()
        val sid = buf.int.toLong() and 0xffffffffL
        val typ = buf.get().toInt()
        when (typ) {
            1 -> open(sid)
            2 -> {
                val local = streams[sid] ?: return
                try {
                    // Blocking write: this holds the relay's reader, which is the backpressure.
                    local.getOutputStream().write(bytes.toByteArray(), 5, bytes.size - 5)
                } catch (_: Exception) {
                    closeStream(sid, notify = true)
                }
            }
            3 -> {
                if (streams.containsKey(sid)) WorkerState.log("split stream $sid closed by the host")
                closeStream(sid, notify = false)
            }
        }
        WorkerState.set { it.copy(streams = streams.size) }
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        // The relay only speaks binary.
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(1000, null)
        finish("the pool closed the relay" + if (reason.isNotEmpty()) " ($reason)" else "")
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = finish("relay closed")

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        if (response != null && !connected) refusedCode = response.code
        finish("relay dropped: " + (t.message ?: t.javaClass.simpleName))
    }

    private fun finish(why: String) {
        if (!alive) return
        alive = false
        connected = false
        if (closeReason.isEmpty()) closeReason = why
        for (sid in streams.keys.toList()) closeStream(sid, notify = false)
        WorkerState.set { it.copy(streams = 0, relayConnected = false) }
        done.countDown()
    }

    private fun open(sid: Long) {
        val local = Socket()
        try {
            local.connect(InetSocketAddress("127.0.0.1", rpcPort), 10_000)
            local.tcpNoDelay = true
            // No read timeout: an RPC link sits silent for minutes in a split.
            local.soTimeout = 0
        } catch (e: Exception) {
            WorkerState.log("split stream $sid: can't reach the local rpc-server (${e.message})")
            runCatching { local.close() }
            send(sid, 3)
            return
        }
        streams[sid] = local
        WorkerState.log("split stream $sid opened (the host connected)")
        Thread({ pump(sid, local) }, "relay-pump-$sid").apply { isDaemon = true }.start()
    }

    private fun pump(sid: Long, local: Socket) {
        var why = "the relay closed"
        val buf = ByteArray(CHUNK)
        try {
            val inp = local.getInputStream()
            while (alive) {
                val n = inp.read(buf)
                if (n < 0) { why = "rpc-server closed it"; break }
                if (!send(sid, 2, buf, n)) { why = "sending to the relay failed"; break }
            }
        } catch (e: Exception) {
            why = "rpc-server socket error: " + (e.message ?: e.javaClass.simpleName)
        }
        if (streams.containsKey(sid)) WorkerState.log("split stream $sid closed: $why")
        closeStream(sid, notify = true)
        WorkerState.set { it.copy(streams = streams.size) }
    }

    private fun closeStream(sid: Long, notify: Boolean) {
        val s = streams.remove(sid) ?: return
        runCatching { s.shutdownInput() }
        runCatching { s.shutdownOutput() }
        runCatching { s.close() }
        if (notify) send(sid, 3)
    }

    private fun send(sid: Long, typ: Int, data: ByteArray? = null, len: Int = 0): Boolean {
        if (!alive) return false
        // OkHttp drops the socket if more than 16 MB waits to go out: hold back above 4 MB.
        while (alive && ws.queueSize() > MAX_QUEUE) Thread.sleep(5)
        if (!alive) return false
        val frame = ByteBuffer.allocate(5 + len)
        frame.putInt(sid.toInt())
        frame.put(typ.toByte())
        if (data != null && len > 0) frame.put(data, 0, len)
        return ws.send(frame.array().toByteString())
    }

    companion object {
        const val CHUNK = 262144
        const val MAX_QUEUE = 4L * 1024 * 1024
    }
}
