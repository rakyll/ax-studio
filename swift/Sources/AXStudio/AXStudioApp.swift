import SwiftUI
import AppKit

@main
struct AXStudioApp: App {
    @State private var store = Store()
    @State private var designer = DesignerModel()
    // Persisted, so `open --args -section board` lands on a specific page.
    @AppStorage("section") private var savedSection: Section = .overview

    init() {
        // A SwiftPM executable starts as a background process; make it a real app.
        NSApplication.shared.setActivationPolicy(.regular)
        DispatchQueue.main.async { NSApplication.shared.activate(ignoringOtherApps: true) }
    }

    var body: some Scene {
        WindowGroup("AX Studio") {
            RootView(section: Binding(get: { savedSection }, set: { savedSection = $0 ?? .overview }))
                .environment(store)
                .environment(designer)
                .frame(minWidth: 1100, minHeight: 700)
                .onAppear { store.start() }
        }
        .windowToolbarStyle(.unified)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Task Design") { designer.reset(); savedSection = .designer }
                    .keyboardShortcut("n")
                Button("Open Manifest…") { designer.openFile(); savedSection = .designer }
                    .keyboardShortcut("o")
            }
            CommandMenu("AX") {
                Button("Refresh") { Task { await store.refresh() } }.keyboardShortcut("r")
                Divider()
                ForEach(Section.allCases) { s in
                    Button(s.title) { savedSection = s }
                        .keyboardShortcut(KeyEquivalent(Character("\(s.index + 1)")), modifiers: .command)
                }
            }
        }

        Settings {
            SettingsView().environment(store)
        }
    }
}

enum Section: String, CaseIterable, Identifiable, Codable {
    case overview, board, topology, designer, deploy

    var id: String { rawValue }
    var index: Int { Section.allCases.firstIndex(of: self)! }

    var title: String {
        switch self {
        case .overview: "Overview"
        case .board: "Task Board"
        case .topology: "Topology"
        case .designer: "Designer"
        case .deploy: "Deploy"
        }
    }

    var icon: String {
        switch self {
        case .overview: "gauge.with.dots.needle.67percent"
        case .board: "rectangle.split.3x1"
        case .topology: "point.3.connected.trianglepath.dotted"
        case .designer: "square.and.pencil"
        case .deploy: "shippingbox"
        }
    }
}

struct RootView: View {
    @Environment(Store.self) private var store
    @Binding var section: Section?

    var body: some View {
        NavigationSplitView {
            List(selection: $section) {
                SwiftUI.Section("Workspace") {
                    ForEach([Section.overview, .board, .topology]) { s in
                        row(s)
                    }
                }
                SwiftUI.Section("Build") {
                    ForEach([Section.designer, .deploy]) { s in
                        row(s)
                    }
                }
            }
            .navigationSplitViewColumnWidth(min: 190, ideal: 210)
            .safeAreaInset(edge: .bottom) { ConnectionBadge().padding(10) }
        } detail: {
            Group {
                switch section ?? .overview {
                case .overview: OverviewView(section: $section)
                case .board: BoardView()
                case .topology: TopologyView()
                case .designer: DesignerView()
                case .deploy: DeployView()
                }
            }
            .toolbar { MainToolbar() }
        }
    }

    private func row(_ s: Section) -> some View {
        Label {
            HStack {
                Text(s.title)
                Spacer()
                if s == .board, !store.tasks.isEmpty {
                    Text("\(store.tasks.count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
        } icon: { Image(systemName: s.icon) }
        .tag(s)
    }
}

struct MainToolbar: ToolbarContent {
    @Environment(Store.self) private var store

    var body: some ToolbarContent {
        @Bindable var store = store
        ToolbarItemGroup(placement: .primaryAction) {
            Menu {
                Picker("Context", selection: $store.context) {
                    ForEach(store.contexts) { c in
                        Label(c.shortName, systemImage: icon(for: c)).tag(c.name)
                    }
                }
                .pickerStyle(.inline)
                Divider()
                Button("Make Default for ax CLI") { Task { await store.makeDefault(store.context) } }
                    .disabled(store.currentContext?.isCurrent ?? true)
            } label: {
                Label(store.currentContext?.shortName ?? "Context", systemImage: store.currentContext.map(icon(for:)) ?? "server.rack")
                    .labelStyle(.titleAndIcon)
            }
            .help("Where ax sends commands. Switching here does not change your global ax config.")

            TextField("atespace", text: $store.atespace)
                .textFieldStyle(.roundedBorder)
                .frame(width: 110)
                .help("Atespace scope")

            Button {
                Task { await store.refresh() }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .overlay(alignment: .bottomTrailing) {
                if store.isRefreshing { Circle().fill(Color.accentColor).frame(width: 5, height: 5) }
            }
        }
    }

    private func icon(for c: AXContext) -> String {
        c.isLocal ? "laptopcomputer" : (c.name == "kube" ? "arrow.triangle.branch" : "server.rack")
    }
}

/// Live connection state in the sidebar footer.
struct ConnectionBadge: View {
    @Environment(Store.self) private var store

    var body: some View {
        HStack(spacing: 8) {
            PulseDot(color: store.connectionError == nil ? (store.lastRefresh == nil ? .orange : .green) : .red,
                     pulsing: store.connectionError == nil && store.lastRefresh != nil)
            VStack(alignment: .leading, spacing: 1) {
                Text(store.currentContext?.shortName ?? "connecting…").font(.caption.weight(.semibold)).lineLimit(1)
                Text(status).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
        .help(store.connectionError ?? "Connected")
    }

    private var status: String {
        if let e = store.connectionError { return e }
        guard let t = store.lastRefresh else { return "connecting…" }
        return "updated \(t.formatted(date: .omitted, time: .standard))"
    }
}

struct SettingsView: View {
    @AppStorage("axPath") private var axPath = "ax"
    @AppStorage("refreshInterval") private var refreshInterval = 4.0
    @AppStorage("repoPath") private var repoPath = "~/ax"

    var body: some View {
        Form {
            TextField("ax binary", text: $axPath)
            Text(Shell.which(axPath) ?? "not found on PATH").font(.caption).foregroundStyle(.secondary)
            TextField("AX repository", text: $repoPath)
            Slider(value: $refreshInterval, in: 2...30, step: 1) { Text("Refresh every \(Int(refreshInterval))s") }
        }
        .padding(20)
        .frame(width: 460)
    }
}
