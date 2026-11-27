import Foundation
import Network

/// One relay WebSocket to the pool front (the same protocol as pool-worker.py). The front bridges it
/// to a localhost port on the host; llama-server's RPC traffic travels down it as binary frames:
///   [stream id: u32 big-endian][type: u8][data]   type 1 = open, 2 = data, 3 = close
/// Each stream is one TCP connection to the in-app RPC server.
final class RelaySession: NSObject, URLSessionWebSocketDelegate {
    enum End { case running, refused(Int), closed(String) }

    private let rpcPort: Int
    private var session: URLSession!
    private var task: URLSessionWebSocketTask!
    private let q = DispatchQueue(label: "relay")
    private var streams: [UInt32: NWConnection] = [:]
    private var lastRx = Date()
    private var pingTimer: DispatchSourceTimer?
    private(set) var connected = false
    private(set) var end: End = .running
    var onChange: (() -> Void)?
    var log: ((String) -> Void)?

    var alive: Bool { if case .running = end { return true } else { return false } }
    var streamCount: Int { q.sync { streams.count } }

    init(poolURL: String, enrollmentId: String, key: String, rpcPort: Int) {
        self.rpcPort = rpcPort
        super.init()
        var req = URLRequest(url: URL(string: poolURL + "/relay")!)
        req.setValue("pool-worker-ios", forHTTPHeaderField: "User-Agent")
        req.setValue(enrollmentId, forHTTPHeaderField: "X-Enrollment-Id")
        req.setValue(key, forHTTPHeaderField: "X-Enrollment-Key")
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 150
        cfg.waitsForConnectivity = false
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        task = session.webSocketTask(with: req)
        task.maximumMessageSize = 64 * 1024 * 1024
        task.resume()
        receive()
    }

    func close(_ why: String) {
        q.async { self.finish(.closed(why)) }
    }

    // MARK: delegate

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        q.async {
            self.connected = true
            self.lastRx = Date()
            self.startPings()
            self.log?("relay connected, this device is in the pool")
            self.onChange?()
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        q.async { self.finish(.closed("the pool closed the relay")) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        q.async {
            if !self.connected, let http = task.response as? HTTPURLResponse, http.statusCode != 101 {
                self.finish(.refused(http.statusCode))
            } else {
                self.finish(.closed("relay dropped: " + (error?.localizedDescription ?? "closed")))
            }
        }
    }

    // MARK: frames

    private func receive() {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let e):
                self.q.async { self.finish(.closed("relay dropped: " + e.localizedDescription)) }
            case .success(let msg):
                var data = Data()
                if case .data(let d) = msg { data = d }
                self.q.async {
                    self.lastRx = Date()
                    // The next receive waits until this frame reached the RPC server: that is the
                    // backpressure towards the host.
                    self.handle(data) { if self.alive { self.receive() } }
                }
            }
        }
    }

    /// Runs on q.
    private func handle(_ frame: Data, next: @escaping () -> Void) {
        guard frame.count >= 5 else { next(); return }
        let b = [UInt8](frame.prefix(5))
        let sid = UInt32(b[0]) << 24 | UInt32(b[1]) << 16 | UInt32(b[2]) << 8 | UInt32(b[3])
        switch b[4] {
        case 1:
            open(sid)
            next()
        case 2:
            guard let conn = streams[sid] else { next(); return }
            conn.send(content: frame.dropFirst(5), completion: .contentProcessed { [weak self] err in
                guard let self else { return }
                self.q.async {
                    if err != nil { self.closeStream(sid, notify: true) }
                    next()
                }
            })
        case 3:
            if streams[sid] != nil { log?("split stream \(sid) closed by the host") }
            closeStream(sid, notify: false)
            next()
        default:
            next()
        }
        onChange?()
    }

    private func open(_ sid: UInt32) {
        let conn = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: UInt16(rpcPort))!,
                                using: .tcp)
        streams[sid] = conn
        conn.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.q.async {
                    self.log?("split stream \(sid) opened (the host connected)")
                    self.pump(sid, conn)
                }
            case .failed(let e):
                self.q.async {
                    self.log?("split stream \(sid): RPC server error (\(e.localizedDescription))")
                    self.closeStream(sid, notify: true)
                }
            default: break
            }
        }
        conn.start(queue: q)
    }

    private func pump(_ sid: UInt32, _ conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 262_144) { [weak self] data, _, done, err in
            guard let self else { return }
            self.q.async {
                guard self.streams[sid] != nil else { return }
                if let data, !data.isEmpty {
                    self.send(sid, 2, data) { ok in
                        if ok && !done && err == nil { self.pump(sid, conn) }
                        else { self.closeStream(sid, notify: true); self.onChange?() }
                    }
                } else if done || err != nil {
                    self.log?("split stream \(sid) closed: the RPC server closed it")
                    self.closeStream(sid, notify: true)
                    self.onChange?()
                } else {
                    self.pump(sid, conn)
                }
            }
        }
    }

    /// Runs on q.
    private func closeStream(_ sid: UInt32, notify: Bool) {
        guard let conn = streams.removeValue(forKey: sid) else { return }
        conn.cancel()
        if notify { send(sid, 3, Data()) { _ in } }
    }

    private func send(_ sid: UInt32, _ typ: UInt8, _ payload: Data, done: @escaping (Bool) -> Void) {
        guard alive else { done(false); return }
        var frame = Data(capacity: 5 + payload.count)
        frame.append(contentsOf: [UInt8(sid >> 24 & 0xff), UInt8(sid >> 16 & 0xff),
                                  UInt8(sid >> 8 & 0xff), UInt8(sid & 0xff), typ])
        frame.append(payload)
        task.send(.data(frame)) { [weak self] err in
            self?.q.async { done(err == nil) }
        }
    }

    private func startPings() {
        let t = DispatchSource.makeTimerSource(queue: q)
        t.schedule(deadline: .now() + 30, repeating: 30)
        t.setEventHandler { [weak self] in
            guard let self, self.alive else { return }
            if Date().timeIntervalSince(self.lastRx) > 90 {
                self.log?("relay silent for 90 s, reconnecting")
                self.finish(.closed("relay silent"))
                return
            }
            self.task.sendPing { [weak self] err in
                guard let self else { return }
                self.q.async { if err == nil { self.lastRx = Date() } }
            }
        }
        t.resume()
        pingTimer = t
    }

    /// Runs on q.
    private func finish(_ why: End) {
        guard alive else { return }
        end = why
        connected = false
        pingTimer?.cancel()
        for sid in Array(streams.keys) { closeStream(sid, notify: false) }
        task.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
        onChange?()
    }
}
