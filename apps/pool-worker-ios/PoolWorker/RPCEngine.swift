import Foundation
import Metal

/// llama.cpp's RPC server, built into the app (iOS can't start other programs). It runs on its
/// own thread for the life of the app, listening on 127.0.0.1 only; the relay is the only way in.
/// It serves the iPhone/iPad GPU through Metal, which runs every quant the pool uses.
final class RPCEngine {
    static let shared = RPCEngine()

    private(set) var started = false
    private(set) var deviceLabel = ""
    private(set) var deviceTotalMB = 0
    private var thread: Thread?

    var gpuName: String { MTLCreateSystemDefaultDevice()?.name ?? "Apple GPU" }

    func start(port: Int) throws {
        if started { return }
        var dev = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_GPU)
        if dev == nil { dev = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_IGPU) }
        if dev == nil { dev = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU) }
        guard let device = dev else { throw WorkerError("ggml found no device on this iPhone/iPad") }
        deviceLabel = String(cString: ggml_backend_dev_description(device))
        var freeBytes = 0, totalBytes = 0
        ggml_backend_dev_memory(device, &freeBytes, &totalBytes)
        deviceTotalMB = totalBytes / (1024 * 1024)

        let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("llama-rpc", isDirectory: true)
        try? FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
        let endpoint = "127.0.0.1:\(port)"
        let cachePath = cache.path
        let threads = max(1, ProcessInfo.processInfo.activeProcessorCount - 1)

        let t = Thread {
            var devices: [ggml_backend_dev_t?] = [device]
            endpoint.withCString { ep in
                cachePath.withCString { cd in
                    devices.withUnsafeMutableBufferPointer { buf in
                        // Blocks for the life of the app: accepts the host's connections one by one.
                        ggml_backend_rpc_start_server(ep, cd, threads, 1, buf.baseAddress)
                    }
                }
            }
        }
        t.name = "ggml-rpc-server"
        t.stackSize = 16 << 20
        t.qualityOfService = .userInitiated
        t.start()
        thread = t

        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            if Self.portOpen(port) { started = true; return }
            Thread.sleep(forTimeInterval: 0.2)
        }
        throw WorkerError("the RPC server did not open port \(port)")
    }

    /// True when something accepts TCP connections on 127.0.0.1:port.
    static func portOpen(_ port: Int) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        if fd < 0 { return false }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(port).bigEndian)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return rc == 0
    }
}

struct WorkerError: Error, CustomStringConvertible {
    let description: String
    init(_ d: String) { description = d }
}
