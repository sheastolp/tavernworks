import Foundation
import UIKit
import Metal

enum Phase: String {
    case idle = "Not in the pool"
    case enrolling = "Joining"
    case waitingApproval = "Waiting for approval"
    case starting = "Starting the engine"
    case connecting = "Connecting"
    case serving = "In the pool"
    case yielding = "Paused"
    case error = "Stopped"
}

/// The iPhone/iPad side of the pool, the same steps as pool-worker.py: enroll and wait for the
/// operator's approval, run the RPC server (in the app, on Metal), hold one relay WebSocket.
/// iOS only lets it work while the app is open on screen; leaving the app drops it out of the
/// pool, and it rejoins when you come back.
@MainActor
final class PoolWorker: ObservableObject {
    @Published var phase: Phase = .idle
    @Published var detail = ""
    @Published var joined = false          // the owner pressed Join
    @Published var approved = false
    @Published var relayConnected = false
    @Published var streams = 0
    @Published var servingOn = ""
    @Published var poolModel = ""
    @Published var pinWarning = ""
    @Published var log: [String] = []
    @Published var inForeground = true

    let d = UserDefaults.standard
    static let defaultPool = "https://pool.tavernworks.dev"
    let rpcPort = 50052
    let enginePin = Bundle.main.object(forInfoDictionaryKey: "PoolEnginePin") as? String ?? "b12359"

    var poolURL: String {
        get { (d.string(forKey: "pool_url") ?? Self.defaultPool).trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
        set { d.set(newValue, forKey: "pool_url") }
    }
    var name: String {
        get { d.string(forKey: "name") ?? "" }
        set { d.set(newValue, forKey: "name") }
    }
    var offeredMB: Int {
        get { d.integer(forKey: "offered_mb") }
        set { d.set(newValue, forKey: "offered_mb") }
    }
    var enrollmentId: String {
        get { d.string(forKey: "enrollment_id") ?? "" }
        set { d.set(newValue, forKey: "enrollment_id") }
    }
    var key: String {
        get { d.string(forKey: "key") ?? "" }
        set { d.set(newValue, forKey: "key") }
    }
    var onlyWhileCharging: Bool {
        get { d.object(forKey: "only_charging") as? Bool ?? true }
        set { d.set(newValue, forKey: "only_charging") }
    }
    var enrolled: Bool { !enrollmentId.isEmpty && !key.isEmpty }
    func forgetEnrollment() { d.removeObject(forKey: "enrollment_id"); d.removeObject(forKey: "key"); approved = false }

    private var loopTask: Task<Void, Never>?
    private var relay: RelaySession?

    // MARK: device facts

    static var machineId: String {
        var u = utsname()
        uname(&u)
        return withUnsafeBytes(of: &u.machine) { raw in
            String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
    }
    var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }
    var defaultName: String { Self.machineId.replacingOccurrences(of: ",", with: "-") }
    var ramMB: Int { Int(ProcessInfo.processInfo.physicalMemory / (1024 * 1024)) }
    /// What iOS lets this app use right now.
    var appAvailableMB: Int { Int(os_proc_available_memory() / (1024 * 1024)) }
    var gpuName: String { RPCEngine.shared.gpuName }
    /// A third of RAM, 512 MB steps, 1-6 GB; never more than iOS lets the app hold.
    var autoOfferedMB: Int {
        var third = (ramMB / 3 / 512) * 512
        let avail = appAvailableMB
        if avail > 0 { third = min(third, (avail * 7 / 10) / 512 * 512) }
        return min(6144, max(1024, third))
    }

    func addLog(_ s: String) {
        let f = DateFormatter(); f.dateFormat = "HH:mm:ss"
        log.append(f.string(from: Date()) + "  " + s)
        if log.count > 200 { log.removeFirst(log.count - 200) }
    }

    // MARK: controls

    func join() {
        guard loopTask == nil else { return }
        joined = true
        UIApplication.shared.isIdleTimerDisabled = true
        UIDevice.current.isBatteryMonitoringEnabled = true
        loopTask = Task { await self.loop() }
    }

    func leave() {
        joined = false
        loopTask?.cancel()
        loopTask = nil
        relay?.close("the owner left the pool")
        relay = nil
        UIApplication.shared.isIdleTimerDisabled = false
        phase = .idle; detail = ""; relayConnected = false; streams = 0; servingOn = ""
    }

    func setForeground(_ active: Bool) {
        inForeground = active
        if !active, let r = relay {
            // iOS suspends the app in the background: leave the split cleanly instead of vanishing.
            r.close("the app left the screen")
        }
    }

    // MARK: http

    private func http(_ method: String, _ path: String, _ body: [String: Any]? = nil) async throws -> (Int, [String: Any]) {
        var req = URLRequest(url: URL(string: poolURL + path)!)
        req.httpMethod = method
        req.timeoutInterval = 30
        req.setValue("pool-worker-ios", forHTTPHeaderField: "User-Agent")
        if let body {
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        return ((resp as? HTTPURLResponse)?.statusCode ?? 0, obj)
    }

    private func sleep(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1e9)) }

    // MARK: steps

    private func ensureEnrolled() async throws {
        if enrolled { return }
        phase = .enrolling; detail = "Registering this \(isPad ? "iPad" : "iPhone") with the pool"
        if name.isEmpty { name = defaultName }
        if offeredMB < 512 { offeredMB = autoOfferedMB }
        let (code, obj) = try await http("POST", "/enroll", [
            "name": name, "offered_mb": offeredMB,
            "gpu": gpuName + " (Metal)", "os": isPad ? "ipados" : "ios"])
        guard code == 201, let id = obj["id"] as? String, let k = obj["key"] as? String else {
            throw WorkerError("the pool refused the enrollment (\(code)): \(obj["error"] as? String ?? "no reason given")")
        }
        enrollmentId = id; key = k
        addLog("enrolled as \(name) (\(offeredMB) MB), id \(id.prefix(8))")
    }

    private func pollStatus() async -> String {
        guard let r = try? await http("GET", "/enroll/\(enrollmentId)?key=\(key)") else { return "" }
        let (code, obj) = r
        switch code {
        case 200: return obj["status"] as? String ?? ""
        case 403: return "bad-key"
        case 404: return "gone"
        default: return ""
        }
    }

    private func waitForApproval() async throws -> Bool {
        var last: String?
        while !Task.isCancelled {
            let s = await pollStatus()
            if s != last { addLog("enrollment status: " + (s.isEmpty ? "pool unreachable" : s)); last = s }
            switch s {
            case "approved":
                approved = true
                return true
            case "bad-key", "gone":
                addLog("the pool doesn't know this enrollment any more, enrolling again")
                forgetEnrollment()
                try await ensureEnrolled()
                last = nil
                continue
            case "pending":
                phase = .waitingApproval
                detail = "Approve \(name) in the pool's Roster. It joins by itself once you do."
            case "":
                phase = .waitingApproval; detail = "Can't reach \(poolURL), retrying"
            default:
                phase = .waitingApproval; detail = "The pool says this device is \(s)"
            }
            approved = false
            await sleep(20)
        }
        return false
    }

    private func fetchModel() async -> String {
        guard let r = try? await http("GET", "/model.json"), r.0 == 200 else { return "" }
        return r.1["file"] as? String ?? ""
    }

    private func checkPin() async {
        guard let r = try? await http("GET", "/downloads/manifest.json"), r.0 == 200,
              let comps = r.1["components"] as? [[String: Any]] else { return }
        let pins = comps.compactMap { $0["name"] as? String }
            .filter { $0.hasPrefix("llama-") && $0.contains("-android-arm64") }
            .compactMap { n -> Int? in
                guard let r = n.range(of: #"llama-b(\d+)-"#, options: .regularExpression) else { return nil }
                return Int(n[r].dropFirst(7).dropLast())
            }
        guard let pin = pins.max(), let mine = Int(enginePin.dropFirst()) else { return }
        pinWarning = pin != mine ? "The pool runs llama.cpp b\(pin) but this app has b\(mine). Splits may fail until the app is updated." : ""
        if !pinWarning.isEmpty { addLog(pinWarning) }
    }

    private func yieldReason() -> String? {
        if !inForeground { return "Open on screen to work. iOS pauses apps in the background." }
        let st = UIDevice.current.batteryState
        if onlyWhileCharging && st == .unplugged { return "Unplugged. Plug in and it rejoins." }
        let t = ProcessInfo.processInfo.thermalState
        if t == .serious || t == .critical { return "Running hot. It rejoins once it cools." }
        return nil
    }

    private func loop() async {
        do {
            try await ensureEnrolled()
            guard try await waitForApproval() else { return }
            await checkPin()
            poolModel = await fetchModel()
            phase = .starting; detail = "Starting the RPC server on the GPU (Metal)"
            let port = rpcPort
            // Off the main thread: starting waits for the server's port to open.
            try await Task.detached { try RPCEngine.shared.start(port: port) }.value
            servingOn = RPCEngine.shared.deviceLabel + " (Metal)"
            addLog("RPC server ready on \(servingOn)")
            var backoff = 2.0
            var wasYielding = false
            while !Task.isCancelled {
                if let r = yieldReason() {
                    if !wasYielding { addLog("pausing: \(r)") }
                    wasYielding = true
                    phase = .yielding; detail = r
                    await sleep(3)
                    continue
                }
                if wasYielding { addLog("free again, rejoining"); wasYielding = false }

                phase = .connecting; detail = "Opening the relay to the pool"
                let s = RelaySession(poolURL: poolURL, enrollmentId: enrollmentId, key: key, rpcPort: rpcPort)
                s.log = { [weak self] line in Task { @MainActor in self?.addLog(line) } }
                s.onChange = { [weak self] n in
                    Task { @MainActor in self?.streams = n }
                }
                relay = s
                let t0 = Date()
                while s.alive && !s.connected && Date().timeIntervalSince(t0) < 40 { await sleep(0.1) }
                if !s.connected {
                    s.close("no answer")
                    relay = nil
                    if case .refused(403) = s.end {
                        addLog("relay refused (not approved), back to waiting for approval")
                        guard try await waitForApproval() else { return }
                        continue
                    }
                    addLog("relay connect failed")
                    detail = "Can't reach the relay, retrying"
                    await sleep(backoff); backoff = min(30, backoff * 2)
                    continue
                }
                backoff = 2
                relayConnected = true
                phase = .serving
                detail = "Lending \(gb(offeredMB)) on the \(gpuName)"
                while s.alive && !Task.isCancelled {
                    await sleep(2)
                    if yieldReason() != nil { s.close("the owner needs the device"); break }
                    let m = await fetchModelIfDue()
                    if !m.isEmpty { poolModel = m }
                }
                relay = nil
                relayConnected = false
                streams = 0
                if !Task.isCancelled && yieldReason() == nil {
                    if case .closed(let why) = s.end { addLog(why + ", reconnecting") }
                    await sleep(3)
                }
            }
        } catch {
            if !Task.isCancelled {
                addLog("stopped: \(error)")
                phase = .error; detail = "\(error)"
            }
        }
        if !joined { phase = .idle; detail = "" }
        loopTask = nil
    }

    private var lastModelCheck = Date.distantPast
    private func fetchModelIfDue() async -> String {
        guard Date().timeIntervalSince(lastModelCheck) > 60 else { return "" }
        lastModelCheck = Date()
        return await fetchModel()
    }

    func gb(_ mb: Int) -> String {
        mb % 1024 == 0 ? "\(mb / 1024) GB" : String(format: "%.1f GB", Double(mb) / 1024)
    }

    var linkURL: URL? { URL(string: poolURL + "/chat#link=" + enrollmentId + "." + key) }
}
