import SwiftUI

@main
struct PoolWorkerApp: App {
    @StateObject private var worker = PoolWorker()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(worker)
                .preferredColorScheme(.dark)
        }
        .onChange(of: scenePhase) { phase in
            worker.setForeground(phase == .active)
        }
    }
}
