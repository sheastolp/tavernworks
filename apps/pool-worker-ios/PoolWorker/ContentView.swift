import SwiftUI

private let amber = Color(red: 0.91, green: 0.69, blue: 0.29)
private let parchment = Color(red: 0.95, green: 0.89, blue: 0.75)
private let wood = Color(red: 0.16, green: 0.12, blue: 0.08)
private let night = Color(red: 0.09, green: 0.07, blue: 0.05)

struct ContentView: View {
    @EnvironmentObject var w: PoolWorker
    @Environment(\.openURL) private var openURL
    @State private var showSettings = false
    @State private var showLog = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("AI Pool worker").font(.title.bold()).foregroundColor(amber)
                    Text(PoolWorker.machineId + " · " + w.gpuName).foregroundColor(parchment.opacity(0.7))
                }

                card {
                    HStack(spacing: 10) {
                        Circle().fill(dotColor).frame(width: 12, height: 12)
                        Text(w.phase.rawValue + (w.phase == .serving && w.streams > 0 ? " · working" : ""))
                            .font(.title3.weight(.semibold))
                    }
                    if !w.detail.isEmpty { Text(w.detail).foregroundColor(parchment.opacity(0.85)) }
                    if !w.pinWarning.isEmpty { Text(w.pinWarning).foregroundColor(.orange) }
                    Divider().background(parchment.opacity(0.2))
                    fact("GPU", w.gpuName + " (Metal, can compute)")
                    fact("Serving on", w.servingOn.isEmpty ? "not running" : w.servingOn)
                    fact("Memory lent", w.gb(w.offeredMB >= 512 ? w.offeredMB : w.autoOfferedMB) + " of " + w.gb(w.ramMB))
                    fact("App may use", w.gb(w.appAvailableMB) + " right now")
                    fact("Approved", w.approved ? "yes" : (w.enrolled ? "not yet" : "not enrolled"))
                    fact("Relay", w.relayConnected ? "connected" : "not connected")
                    fact("Splits now", "\(w.streams)")
                    if !w.poolModel.isEmpty { fact("Pool model", w.poolModel) }
                    fact("Engine", "llama.cpp " + w.enginePin)
                }

                if !w.joined {
                    Button { w.join() } label: {
                        Text("Join the pool").font(.headline).frame(maxWidth: .infinity, minHeight: 52)
                    }
                    .background(amber).foregroundColor(night).cornerRadius(12)
                } else {
                    Button { w.leave() } label: {
                        Text("Leave the pool").font(.headline).frame(maxWidth: .infinity, minHeight: 52)
                    }
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(parchment.opacity(0.5)))
                    .foregroundColor(parchment)
                }

                Text("iOS only lets the worker run while this app is open on screen. Keep it open and plugged in; the screen stays on while it's in the pool.")
                    .font(.footnote).foregroundColor(parchment.opacity(0.7))

                if w.approved && w.enrolled, let url = w.linkURL {
                    Button("Link this device to my pool account") { openURL(url) }.foregroundColor(amber)
                }

                Button(showSettings ? "Hide settings" : "Settings") { showSettings.toggle() }.foregroundColor(amber)
                if showSettings { SettingsCard(locked: w.joined) }

                Button(showLog ? "Hide log" : "Show log") { showLog.toggle() }.foregroundColor(amber)
                if showLog {
                    Text(w.log.suffix(60).joined(separator: "\n").isEmpty ? "Nothing yet." : w.log.suffix(60).joined(separator: "\n"))
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(parchment.opacity(0.85))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12).background(Color.black.opacity(0.4)).cornerRadius(10)
                }
            }
            .padding(16)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .background(night.ignoresSafeArea())
        .foregroundColor(parchment)
    }

    private var dotColor: Color {
        switch w.phase {
        case .serving: return .green
        case .error: return .red
        case .idle: return parchment.opacity(0.4)
        default: return amber
        }
    }

    private func fact(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label).foregroundColor(parchment.opacity(0.6)).frame(width: 110, alignment: .leading)
            Text(value)
            Spacer(minLength: 0)
        }.font(.subheadline)
    }

    private func card<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8, content: content)
            .padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(wood).cornerRadius(14)
    }
}

struct SettingsCard: View {
    @EnvironmentObject var w: PoolWorker
    let locked: Bool
    @State private var url = ""
    @State private var name = ""
    @State private var mb: Double = 2048
    @State private var charging = true
    @State private var note = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if locked { Text("Leave the pool to change these.").foregroundColor(parchment.opacity(0.7)) }
            TextField("Pool address", text: $url).textFieldStyle(.roundedBorder)
                .keyboardType(.URL).autocorrectionDisabled().textInputAutocapitalization(.never)
            TextField("This device's name in the pool", text: $name).textFieldStyle(.roundedBorder)
                .autocorrectionDisabled().textInputAutocapitalization(.never)
            Text("Memory to lend: " + w.gb(Int(mb)))
            Slider(value: $mb, in: 1024...Double(max(2048, w.ramMB * 6 / 10 / 512 * 512)), step: 512)
            Toggle("Only while charging", isOn: $charging)
            Button("Save") { save() }
                .padding(.horizontal, 18).padding(.vertical, 8)
                .background(amber).foregroundColor(night).cornerRadius(8)
            if !note.isEmpty { Text(note).foregroundColor(parchment.opacity(0.85)) }
        }
        .disabled(locked)
        .padding(16).background(wood).cornerRadius(14)
        .onAppear {
            url = w.poolURL
            name = w.name.isEmpty ? w.defaultName : w.name
            mb = Double(w.offeredMB >= 512 ? w.offeredMB : w.autoOfferedMB)
            charging = w.onlyWhileCharging
        }
    }

    private func save() {
        let cleanURL = url.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let reEnroll = w.enrolled && (name != w.name || Int(mb) != w.offeredMB || cleanURL != w.poolURL)
        w.poolURL = cleanURL.isEmpty ? PoolWorker.defaultPool : cleanURL
        w.name = name.isEmpty ? w.defaultName : String(name.prefix(60))
        w.offeredMB = Int(mb)
        w.onlyWhileCharging = charging
        if reEnroll { w.forgetEnrollment() }
        note = reEnroll ? "Saved. The pool sees this device as a new machine now, so approve it again after you join." : "Saved."
    }
}
