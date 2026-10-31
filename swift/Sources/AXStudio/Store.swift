import Foundation
import SwiftUI
import Observation
import AppKit

/// One `ax` invocation, shown in the activity feed.
struct ActivityEntry: Identifiable {
    let id = UUID()
    let date = Date()
    var title: String
    var detail: String
    var ok: Bool
}

/// Phase counts at one refresh, for the "tasks over time" chart.
struct PhaseSample: Identifiable {
    let id = UUID()
    var date: Date
    var counts: [Phase: Int]
}

@MainActor
@Observable
final class Store {
    // Connection
    var contexts: [AXContext] = []
    var context: String = "" { didSet { if oldValue != context { resetForContextChange() } } }
    var atespace: String = "default" { didSet { if oldValue != atespace { resetForContextChange() } } }

    // Resources
    var tasks: [AXTask] = []
    var workspaces: [AXWorkspace] = []
    var models: [AXModel] = []
    var details: [String: TaskDetail] = [:]

    // UI state
    var selectedTaskID: AXTask.ID?
    var isRefreshing = false
    var lastRefresh: Date?
    var connectionError: String?
    var activity: [ActivityEntry] = []
    var history: [PhaseSample] = []
    var axVersion: String?

    @ObservationIgnored @AppStorage("axPath") var axPath = "ax"
    @ObservationIgnored @AppStorage("refreshInterval") var refreshInterval = 4.0
    @ObservationIgnored private var pollTask: Task<Void, Never>?

    var selectedTask: AXTask? { tasks.first { $0.id == selectedTaskID } }
    var currentContext: AXContext? { contexts.first { $0.name == context } }

    func tasks(in phase: Phase) -> [AXTask] { tasks.filter { $0.phase == phase } }
    func tasks(using workspace: String) -> [AXTask] { tasks.filter { details[$0.id]?.workspace == workspace } }

    // MARK: Lifecycle

    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            await self?.loadContexts()
            while !Task.isCancelled {
                await self?.refresh()
                let interval = self?.refreshInterval ?? 4
                try? await Task.sleep(for: .seconds(max(1.5, interval)))
            }
        }
    }

    private func resetForContextChange() {
        tasks = []; workspaces = []; models = []; details = [:]; history = []
        selectedTaskID = nil
        connectionError = nil
        Task { await refresh() }
    }

    func loadContexts() async {
        let v = await Shell.run(axPath, ["version"])
        axVersion = v.ok ? v.stdout.trimmingCharacters(in: .whitespacesAndNewlines) : nil
        let r = await Shell.run(axPath, ["config", "get-contexts"])
        guard r.ok else {
            connectionError = r.errorSummary
            return
        }
        contexts = Parse.contexts(r.stdout)
        if context.isEmpty { context = contexts.first(where: \.isCurrent)?.name ?? "local" }
    }

    // MARK: Running ax

    /// Arguments every resource command needs so the app targets the chosen
    /// context without changing the user's global `ax config`.
    private var scope: [String] {
        var a: [String] = []
        if !context.isEmpty { a += ["--context", context] }
        a += ["-a", atespace]
        return a
    }

    func ax(_ args: [String], stdin: String? = nil) async -> CommandResult {
        await Shell.run(axPath, scope + args, stdin: stdin)
    }

    /// Runs a mutating command and records it in the activity feed.
    @discardableResult
    func perform(_ title: String, _ args: [String], stdin: String? = nil) async -> CommandResult {
        let r = await ax(args, stdin: stdin)
        let detail = r.ok ? r.stdout.trimmingCharacters(in: .whitespacesAndNewlines) : r.errorSummary
        activity.insert(ActivityEntry(title: title, detail: detail, ok: r.ok), at: 0)
        if activity.count > 200 { activity.removeLast(activity.count - 200) }
        await refresh()
        return r
    }

    // MARK: Refresh

    func refresh() async {
        guard !isRefreshing, !context.isEmpty else { return }
        isRefreshing = true
        defer { isRefreshing = false }

        async let t = ax(["get", "tasks"])
        async let w = ax(["get", "workspaces"])
        async let m = ax(["get", "models"])
        let (tr, wr, mr) = await (t, w, m)

        guard tr.ok else {
            connectionError = tr.errorSummary
            return
        }
        connectionError = nil
        let newTasks = Parse.tasks(tr.stdout).sorted { ($0.phase, $0.name) < ($1.phase, $1.name) }
        if newTasks != tasks { tasks = newTasks }
        if wr.ok { mergeWorkspaces(Parse.workspaces(wr.stdout)) }
        if mr.ok { models = Parse.models(mr.stdout) }
        lastRefresh = Date()

        var counts: [Phase: Int] = [:]
        for task in tasks { counts[task.phase, default: 0] += 1 }
        history.append(PhaseSample(date: Date(), counts: counts))
        if history.count > 360 { history.removeFirst(history.count - 360) }

        await loadDetails()
    }

    /// Keeps already-described repos so the topology doesn't flicker.
    private func mergeWorkspaces(_ fresh: [AXWorkspace]) {
        workspaces = fresh.map { ws in
            var ws = ws
            if let old = workspaces.first(where: { $0.id == ws.id }) {
                ws.repos = old.repos
                ws.mcpServers = old.mcpServers
            }
            return ws
        }
    }

    /// Describes each task and workspace so the board and graph know the links.
    private func loadDetails() async {
        let taskNames = tasks.map { ($0.id, $0.name) }
        await withTaskGroup(of: (String, TaskDetail?).self) { group in
            for (id, name) in taskNames {
                group.addTask { [scope, axPath] in
                    let r = await Shell.run(axPath, scope + ["describe", "task", name])
                    return (id, r.ok ? Parse.taskDetail(r.stdout) : nil)
                }
            }
            for await (id, d) in group { if let d, details[id] != d { details[id] = d } }
        }
        let live = Set(tasks.map(\.id))
        for key in details.keys where !live.contains(key) { details[key] = nil }

        for i in workspaces.indices {
            let name = workspaces[i].name
            let r = await ax(["describe", "workspace", name])
            if r.ok, i < workspaces.count, workspaces[i].name == name {
                var ws = workspaces[i]
                Parse.workspaceDetail(r.stdout, into: &ws)
                if ws != workspaces[i] { workspaces[i] = ws }
            }
        }
    }

    // MARK: Actions

    func suspend(_ t: AXTask) async { await perform("Suspend \(t.name)", ["suspend", "task", t.name]) }
    func resume(_ t: AXTask) async { await perform("Resume \(t.name)", ["resume", "task", t.name]) }
    func delete(kind: String, name: String) async { await perform("Delete \(kind) \(name)", ["delete", kind, name]) }

    func apply(yaml: String) async -> CommandResult {
        await perform("Apply manifest", ["apply", "-f", "-"], stdin: yaml)
    }

    func makeDefault(_ ctx: String) async {
        let r = await Shell.run(axPath, ["config", "use-context", ctx])
        activity.insert(ActivityEntry(title: "Use context \(ctx)", detail: r.ok ? "now the default for ax" : r.errorSummary, ok: r.ok), at: 0)
        await loadContexts()
    }

    /// Opens `ax ssh` in Terminal. A `.command` file avoids needing Automation permission.
    func openShell(_ t: AXTask, command: String? = nil) {
        let q: (String) -> String = { "'" + $0.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        var line = ([Shell.which(axPath) ?? axPath] + scope + ["ssh", t.name]).map(q).joined(separator: " ")
        if let command { line += " -- " + command }
        let script = "#!/bin/zsh -l\nclear\necho '→ ax ssh \(t.name)  (\(context))'\n\(line)\n"
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ax-ssh-\(t.name).command")
        do {
            try script.write(to: url, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
            NSWorkspace.shared.open(url)
        } catch {
            activity.insert(ActivityEntry(title: "Open shell \(t.name)", detail: error.localizedDescription, ok: false), at: 0)
        }
    }
}
