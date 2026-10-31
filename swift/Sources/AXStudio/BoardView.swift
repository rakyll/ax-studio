import SwiftUI

struct BoardView: View {
    @Environment(Store.self) private var store
    @State private var filter = ""
    @State private var pendingDelete: AXTask?
    @State private var dropTarget: Phase?

    var body: some View {
        @Bindable var store = store
        VStack(alignment: .leading, spacing: 16) {
            PageHeader(title: "Task Board", subtitle: "Drag a card onto Suspended to checkpoint it, or onto Running to resume.") {
                TextField("Filter", text: $filter)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 200)
            }
            .padding([.horizontal, .top], 24)

            if store.tasks.isEmpty {
                EmptyHint(icon: "square.stack.3d.up.slash", title: "No tasks",
                          message: store.connectionError ?? "Design a task and apply it to see it here.")
            } else {
                GeometryReader { geo in
                    let phases = shownPhases
                    let width = max(220, (geo.size.width - 48 - CGFloat(phases.count - 1) * 14) / CGFloat(phases.count))
                    ScrollView(.horizontal) {
                        HStack(alignment: .top, spacing: 14) {
                            ForEach(phases, id: \.self) { phase in
                                column(phase).frame(width: width)
                            }
                        }
                        .padding(.horizontal, 24)
                        .padding(.bottom, 24)
                        .frame(height: geo.size.height)
                    }
                }
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .taskInspectorPanel()
        .confirmationDialog("Delete task \(pendingDelete?.name ?? "")?", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } })) {
            Button("Delete", role: .destructive) {
                if let t = pendingDelete { Task { await store.delete(kind: "task", name: t.name) } }
            }
        } message: {
            Text("This tears down the sandbox and removes the record.")
        }
    }

    /// Terminal and transient columns only appear when they hold something.
    private var shownPhases: [Phase] {
        let always: Set<Phase> = [.pending, .running, .suspended, .failed]
        var phases = Phase.columns.filter { always.contains($0) || !store.tasks(in: $0).isEmpty }
        for t in store.tasks where !phases.contains(t.phase) { phases.append(t.phase) }
        return phases
    }

    private func visible(_ phase: Phase) -> [AXTask] {
        store.tasks(in: phase).filter { filter.isEmpty || $0.name.localizedCaseInsensitiveContains(filter) }
    }

    private func column(_ phase: Phase) -> some View {
        let items = visible(phase)
        let accepts = phase == .running || phase == .suspended
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: phase.icon).foregroundStyle(phase.color)
                Text(phase.label).font(.headline)
                Text("\(items.count)").font(.callout.monospacedDigit()).foregroundStyle(.secondary)
                Spacer()
            }
            .padding(.horizontal, 4)
            Rectangle().fill(phase.color).frame(height: 3).clipShape(Capsule())

            ScrollView(.vertical) {
                LazyVStack(spacing: 10) {
                    ForEach(items) { t in
                        TaskCard(task: t, detail: store.details[t.id], selected: store.selectedTaskID == t.id,
                                 onDelete: { pendingDelete = t })
                            .onTapGesture { withAnimation(.snappy) { store.selectedTaskID = t.id } }
                            .draggable(t.name)
                            .transition(.scale(scale: 0.9).combined(with: .opacity))
                    }
                    if items.isEmpty {
                        Text(accepts ? "Drop here" : "—")
                            .font(.callout).foregroundStyle(.tertiary)
                            .frame(maxWidth: .infinity, minHeight: 60)
                    }
                }
                .animation(.snappy, value: items.map(\.id))
                .padding(2)
            }
        }
        .padding(12)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(phase.color.opacity(dropTarget == phase ? 0.16 : 0.05), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(phase.color.opacity(dropTarget == phase ? 0.8 : 0), style: StrokeStyle(lineWidth: 2, dash: [6, 4])))
        .dropDestination(for: String.self) { names, _ in
            guard accepts else { return false }
            for name in names {
                guard let t = store.tasks.first(where: { $0.name == name }), t.phase != phase else { continue }
                Task { phase == .suspended ? await store.suspend(t) : await store.resume(t) }
            }
            return true
        } isTargeted: { on in
            withAnimation(.easeOut(duration: 0.15)) { dropTarget = on && accepts ? phase : (dropTarget == phase ? nil : dropTarget) }
        }
    }
}

struct TaskCard: View {
    @Environment(Store.self) private var store
    var task: AXTask
    var detail: TaskDetail?
    var selected: Bool
    var onDelete: () -> Void
    @State private var hover = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                if task.phase == .running {
                    PulseDot(color: task.phase.color, size: 7)
                } else {
                    Image(systemName: task.phase.icon).foregroundStyle(task.phase.color).font(.caption)
                }
                Text(task.name).font(.body.weight(.semibold)).lineLimit(1)
                Spacer()
                Text(task.age).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            if let ws = detail?.workspace {
                Chip(text: ws, icon: "folder.fill", tint: .purple)
            }
            if let img = shortImage(detail?.image) {
                Text(img).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
            if let c = detail?.conditions, !c.isEmpty {
                HStack(spacing: 4) {
                    ForEach(c) { cond in
                        Image(systemName: cond.isTrue ? "checkmark.circle.fill" : "circle.dashed")
                            .foregroundStyle(cond.isTrue ? Color(hex: 0x0CA30C) : .secondary)
                            .help("\(cond.type): \(cond.status) \(cond.reason)")
                    }
                    Text(c.map(\.type).joined(separator: " · ")).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                .font(.caption)
            }
            if hover || selected {
                HStack(spacing: 6) {
                    if task.phase == .running {
                        iconButton("pause.fill", "Suspend") { Task { await store.suspend(task) } }
                        iconButton("terminal", "Open shell (ax ssh)") { store.openShell(task) }
                    }
                    if task.phase == .suspended {
                        iconButton("play.fill", "Resume") { Task { await store.resume(task) } }
                    }
                    Spacer()
                    iconButton("trash", "Delete", role: .destructive, action: onDelete)
                }
                .transition(.opacity)
            }
        }
        .padding(11)
        .card(highlighted: selected, tint: task.phase.color)
        .onHover { h in withAnimation(.easeOut(duration: 0.12)) { hover = h } }
        .contextMenu {
            if task.phase == .running {
                Button("Suspend") { Task { await store.suspend(task) } }
                Button("Open Shell") { store.openShell(task) }
            }
            if task.phase == .suspended { Button("Resume") { Task { await store.resume(task) } } }
            Divider()
            Button("Copy Name") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(task.name, forType: .string) }
            Button("Delete…", role: .destructive, action: onDelete)
        }
    }

    private func iconButton(_ icon: String, _ help: String, role: ButtonRole? = nil, action: @escaping () -> Void) -> some View {
        Button(role: role, action: action) { Image(systemName: icon).frame(width: 16) }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .help(help)
    }
}

/// A slide-in panel showing the selected task. SwiftUI's `.inspector` is not
/// used: its toolbar separator crashes AppKit when a window is restored.
struct TaskInspectorPanel: ViewModifier {
    @Environment(Store.self) private var store

    func body(content: Content) -> some View {
        HStack(spacing: 0) {
            content.frame(maxWidth: .infinity)
            if let t = store.selectedTask {
                Divider()
                VStack(spacing: 0) {
                    HStack {
                        Spacer()
                        Button { withAnimation(.snappy) { store.selectedTaskID = nil } } label: {
                            Image(systemName: "xmark.circle.fill").font(.title3).foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                        .keyboardShortcut(.escape, modifiers: [])
                        .help("Close")
                    }
                    .padding([.top, .trailing], 10)
                    TaskInspector(task: t)
                }
                .frame(width: 380)
                .background(.background)
                .transition(.move(edge: .trailing))
            }
        }
        .animation(.snappy, value: store.selectedTaskID)
    }
}

extension View {
    func taskInspectorPanel() -> some View { modifier(TaskInspectorPanel()) }
}

/// Full detail for one task: lifecycle, conditions, spec, raw YAML.
struct TaskInspector: View {
    @Environment(Store.self) private var store
    var task: AXTask
    @State private var yaml = ""
    @State private var command = "ls -la /workspace"
    @State private var output: CommandResult?
    @State private var running = false

    private var detail: TaskDetail? { store.details[task.id] }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(task.name).font(.title2.weight(.bold)).textSelection(.enabled)
                    HStack {
                        PhaseBadge(phase: task.phase)
                        Text("\(task.atespace) · \(task.age) old").font(.caption).foregroundStyle(.secondary)
                    }
                }

                LifecycleTrack(phase: task.phase, conditions: detail?.conditions ?? [])

                actions

                GroupBox("Sandbox") {
                    VStack(alignment: .leading, spacing: 6) {
                        field("Actor", task.actor)
                        field("Worker IP", task.workerIP)
                        field("Workspace", detail?.workspace.map { "\($0)  →  \(detail?.workspacePath ?? "/workspace")" })
                        field("Image", detail?.image)
                        field("Command", detail?.command)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(4)
                }

                if let conds = detail?.conditions, !conds.isEmpty {
                    GroupBox("Conditions") {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(conds) { c in
                                HStack(alignment: .top) {
                                    Image(systemName: c.isTrue ? "checkmark.circle.fill" : "xmark.circle")
                                        .foregroundStyle(c.isTrue ? Color(hex: 0x0CA30C) : Color(hex: 0xEC835A))
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(c.type).font(.callout.weight(.semibold))
                                        if !c.reason.isEmpty { Text(c.reason).font(.caption) }
                                        if !c.message.isEmpty { Text(c.message).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                                    }
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(4)
                    }
                }

                if task.phase == .running {
                    GroupBox("Run in sandbox") {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                TextField("command", text: $command).font(.callout.monospaced()).textFieldStyle(.roundedBorder)
                                    .onSubmit(runCommand)
                                Button(action: runCommand) { running ? AnyView(ProgressView().controlSize(.small)) : AnyView(Image(systemName: "return")) }
                                    .disabled(running)
                            }
                            if let o = output {
                                Text((o.stdout + o.stderr).trimmingCharacters(in: .whitespacesAndNewlines))
                                    .font(.caption.monospaced())
                                    .foregroundStyle(o.ok ? Color.primary : Color(hex: 0xD03B3B))
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(8)
                                    .background(.black.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
                            }
                        }
                        .padding(4)
                    }
                }

                GroupBox("Manifest") {
                    Text(yaml.isEmpty ? "loading…" : yaml)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(4)
                }
            }
            .padding(18)
        }
        .task(id: task.id) {
            output = nil
            let r = await store.ax(["get", "task", task.name])
            yaml = r.ok ? r.stdout : r.errorSummary
        }
    }

    private var actions: some View {
        HStack {
            if task.phase == .running {
                Button { Task { await store.suspend(task) } } label: { Label("Suspend", systemImage: "pause.fill") }
                Button { store.openShell(task) } label: { Label("Shell", systemImage: "terminal") }
            }
            if task.phase == .suspended {
                Button { Task { await store.resume(task) } } label: { Label("Resume", systemImage: "play.fill") }
                    .buttonStyle(.borderedProminent)
            }
            Spacer()
        }
        .controlSize(.large)
    }

    private func runCommand() {
        guard !command.isEmpty else { return }
        running = true
        Task {
            output = await store.ax(["ssh", task.name, "--", "sh", "-c", command])
            running = false
        }
    }

    @ViewBuilder
    private func field(_ label: String, _ value: String?) -> some View {
        if let value, !value.isEmpty {
            HStack(alignment: .firstTextBaseline) {
                Text(label).font(.caption).foregroundStyle(.secondary).frame(width: 74, alignment: .leading)
                Text(value).font(.caption.monospaced()).textSelection(.enabled).lineLimit(3).truncationMode(.middle)
            }
        }
    }
}

/// A horizontal track of lifecycle stages: Created → Workspace → Ready, plus the current phase.
struct LifecycleTrack: View {
    var phase: Phase
    var conditions: [Condition]

    private struct Stage: Identifiable {
        var id: String
        var icon: String
        var done: Bool
        var tint: Color
    }

    private var stages: [Stage] {
        func cond(_ t: String) -> Bool { conditions.first { $0.type == t }?.isTrue ?? false }
        let ready = cond("Ready")
        let green = Color(hex: 0x0CA30C)
        var s = [
            Stage(id: "Created", icon: "plus.circle.fill", done: true, tint: green),
            Stage(id: "Workspace", icon: "folder.fill", done: cond("WorkspaceReady") || ready, tint: green),
            Stage(id: "Ready", icon: "bolt.fill", done: ready, tint: green),
        ]
        if phase != .running && phase != .pending {
            s.append(Stage(id: phase.label, icon: phase.icon, done: true, tint: phase.color))
        }
        return s
    }

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(stages.enumerated()), id: \.element.id) { i, s in
                if i > 0 {
                    Rectangle().fill(s.done ? s.tint : Color.secondary.opacity(0.25)).frame(height: 2)
                }
                VStack(spacing: 4) {
                    Image(systemName: s.icon)
                        .font(.system(size: 14))
                        .foregroundStyle(s.done ? .white : .secondary)
                        .frame(width: 30, height: 30)
                        .background(s.done ? s.tint : Color.secondary.opacity(0.15), in: Circle())
                    Text(s.id).font(.caption2).foregroundStyle(s.done ? .primary : .secondary).fixedSize()
                }
            }
        }
        .padding(.vertical, 6)
        .animation(.snappy, value: stages.map(\.done))
    }
}
