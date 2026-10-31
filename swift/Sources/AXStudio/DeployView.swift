import SwiftUI

enum StepState: Equatable {
    case idle, running, ok, failed(Int32), skipped
}

struct DeployStep: Identifiable {
    var id: String
    var title: String
    var icon: String
    var detail: String
    var command: String
    var enabled = true
    var state: StepState = .idle
    var duration: TimeInterval?
}

struct LogLine: Identifiable {
    let id = UUID()
    var step: String
    var text: String
    var isHeader = false
}

/// Runs the deploy pipeline as a sequence of shell steps with streamed output.
@MainActor
@Observable
final class DeployModel {
    enum Target: String, CaseIterable, Identifiable {
        case local = "Local (Podman)", kube = "Kubernetes"
        var id: String { rawValue }
    }

    var target: Target = .local
    var kubeContext = ""
    var imageRepo = UserDefaults.standard.string(forKey: "deploy.imageRepo") ?? "" {
        didSet { UserDefaults.standard.set(imageRepo, forKey: "deploy.imageRepo") }
    }
    var arch = "amd64"
    var steps: [DeployStep] = []
    var log: [LogLine] = []
    var running = false
    var currentStep: String?

    var repoPath: String {
        ((UserDefaults.standard.string(forKey: "repoPath") ?? "~/ax") as NSString).expandingTildeInPath
    }

    /// A kubeconfig that only sets `current-context`, prepended to KUBECONFIG so
    /// the Makefile's bare `kubectl` calls hit the chosen cluster without
    /// changing the user's global context.
    private var kubeEnv: [String: String] {
        guard target == .kube, !kubeContext.isEmpty else { return [:] }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("axstudio-kubeconfig-\(kubeContext).yaml")
        let body = "apiVersion: v1\nkind: Config\ncurrent-context: \"\(kubeContext)\"\n"
        try? body.write(to: url, atomically: true, encoding: .utf8)
        let base = ProcessInfo.processInfo.environment["KUBECONFIG"]
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".kube/config").path
        return ["KUBECONFIG": "\(url.path):\(base)"]
    }

    func rebuild() {
        let enabled = Dictionary(steps.map { ($0.id, $0.enabled) }, uniquingKeysWith: { a, _ in a })
        let ctx = kubeContext.replacingOccurrences(of: "'", with: "")
        let repo = imageRepo.trimmingCharacters(in: .whitespaces)
        switch target {
        case .local:
            steps = [
                DeployStep(id: "runtime", title: "Container runtime", icon: "cube.box",
                           detail: "Podman (or Docker) must be running to host local tasks.",
                           command: "if command -v podman >/dev/null; then podman machine list && podman info --format 'podman {{.Version.Version}} on {{.Host.Arch}}'; else docker info --format 'docker {{.ServerVersion}}'; fi"),
                DeployStep(id: "cli", title: "ax CLI", icon: "terminal",
                           detail: "Builds and installs ax from the repo with go install.",
                           command: "make install", enabled: false),
                DeployStep(id: "plane", title: "Control plane", icon: "server.rack",
                           detail: "Starts the local control plane (state in ~/.ax) and lists tasks.",
                           command: "ax --context local get tasks && ax --context local ctx"),
                DeployStep(id: "example", title: "Run example", icon: "play.circle",
                           detail: "Applies examples/simple.yaml as a smoke test.",
                           command: "ax --context local apply -f examples/simple.yaml && sleep 3 && ax --context local describe task simple-task",
                           enabled: false),
            ]
        case .kube:
            let imgEnv = "AX_IMAGE_REPO='\(repo)' IMAGE_ARCH='\(arch)'"
            steps = [
                DeployStep(id: "cluster", title: "Cluster", icon: "network",
                           detail: "Checks that kubectl can reach \(ctx.isEmpty ? "the cluster" : ctx).",
                           command: "kubectl version --request-timeout=10s && kubectl get nodes --request-timeout=10s"),
                DeployStep(id: "substrate", title: "Agent Substrate", icon: "square.stack.3d.down.right",
                           detail: "AX schedules tasks on Substrate's Control API in ate-system.",
                           command: "kubectl get svc api -n ate-system"),
                DeployStep(id: "images", title: "Build & push images", icon: "shippingbox",
                           detail: "Cross-compiles ax-server and ax-task-runner and pushes them to \(repo.isEmpty ? "AX_IMAGE_REPO" : repo).",
                           command: "make images \(imgEnv)"),
                DeployStep(id: "postgres", title: "Postgres", icon: "cylinder.split.1x2",
                           detail: "Creates ax-system, a password secret once, and the Postgres statefulset.",
                           command: "make deploy-postgres"),
                DeployStep(id: "server", title: "ax-server", icon: "server.rack",
                           detail: "Deploys the control plane, pinned to the digests just pushed when available.",
                           command: """
                           D=$(cat bin/ax-server.digest 2>/dev/null); T=$(cat bin/ax-task-runner.digest 2>/dev/null); \
                           make deploy-server \(imgEnv) ${D:+AX_SERVER_IMAGE='\(repo)/ax-server@'$D} ${T:+AX_DEFAULT_TASK_IMAGE='\(repo)/ax-task-runner@'$T} && \
                           kubectl -n ax-system rollout status deployment/ax-server --timeout=180s
                           """),
                DeployStep(id: "verify", title: "Verify", icon: "checkmark.seal",
                           detail: "Tunnels to the new control plane and lists tasks.",
                           command: "ax --context '\(ctx)' get tasks"),
            ]
        }
        for i in steps.indices { if let e = enabled[steps[i].id] { steps[i].enabled = e } }
    }

    var problems: [String] {
        guard target == .kube else { return [] }
        var p: [String] = []
        if kubeContext.isEmpty { p.append("Choose a Kubernetes context.") }
        let needsRepo = steps.contains { ($0.id == "images" || $0.id == "server") && $0.enabled }
        if needsRepo && imageRepo.trimmingCharacters(in: .whitespaces).isEmpty { p.append("Set the image registry (AX_IMAGE_REPO).") }
        if !FileManager.default.fileExists(atPath: repoPath + "/Makefile") { p.append("AX repo not found at \(repoPath) (set it in Settings).") }
        return p
    }

    func runAll() async {
        running = true
        defer { running = false; currentStep = nil }
        for i in steps.indices { steps[i].state = steps[i].enabled ? .idle : .skipped; steps[i].duration = nil }
        log.removeAll()
        for i in steps.indices where steps[i].enabled {
            if await !run(index: i) { break }
        }
    }

    func runOne(_ id: String) async {
        guard let i = steps.firstIndex(where: { $0.id == id }) else { return }
        running = true
        defer { running = false; currentStep = nil }
        _ = await run(index: i)
    }

    private func run(index i: Int) async -> Bool {
        let step = steps[i]
        steps[i].state = .running
        currentStep = step.id
        log.append(LogLine(step: step.id, text: "▶ \(step.title)   $ \(step.command)", isHeader: true))
        let start = Date()
        let status = await Shell.stream(step.command, cwd: repoPath, extraEnv: kubeEnv) { line in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.log.append(LogLine(step: step.id, text: line))
                if self.log.count > 5000 { self.log.removeFirst(self.log.count - 5000) }
            }
        }
        // Let queued log lines land before reporting the result.
        await Task.yield()
        steps[i].duration = Date().timeIntervalSince(start)
        steps[i].state = status == 0 ? .ok : .failed(status)
        log.append(LogLine(step: step.id, text: status == 0 ? "✓ \(step.title) done" : "✗ \(step.title) failed (exit \(status))", isHeader: true))
        return status == 0
    }
}

struct DeployView: View {
    @Environment(Store.self) private var store
    @State private var model = DeployModel()
    @State private var selected: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 16) {
                PageHeader(title: "Deploy", subtitle: "Bring up an AX control plane, step by step.") {
                    runButton
                }
                configuration
                pipeline
                if !model.problems.isEmpty {
                    ForEach(model.problems, id: \.self) { p in
                        Label(p, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color(hex: 0xC98A00)).font(.callout)
                    }
                }
            }
            .padding(24)

            console
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear {
            if model.kubeContext.isEmpty {
                model.kubeContext = store.contexts.first { !$0.isLocal && $0.name != "kube" && $0.name == store.context }?.name
                    ?? store.contexts.first { $0.name.hasPrefix("kind-") }?.name ?? ""
                if let c = store.currentContext, !c.isLocal { model.target = .kube }
            }
            model.rebuild()
        }
        .onChange(of: model.target) { model.rebuild() }
        .onChange(of: model.kubeContext) { model.rebuild() }
        .onChange(of: model.imageRepo) { model.rebuild() }
        .onChange(of: model.arch) { model.rebuild() }
    }

    private var runButton: some View {
        Button {
            Task { await model.runAll(); await store.loadContexts(); await store.refresh() }
        } label: {
            HStack {
                if model.running { ProgressView().controlSize(.small) }
                Label(model.running ? "Deploying…" : "Run pipeline", systemImage: "play.fill")
            }
            .padding(.horizontal, 10)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(model.running || !model.problems.isEmpty)
    }

    private var configuration: some View {
        @Bindable var model = model
        return HStack(spacing: 16) {
            Picker("Target", selection: $model.target) {
                ForEach(DeployModel.Target.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .frame(width: 280)
            .labelsHidden()

            if model.target == .kube {
                Picker("Cluster", selection: $model.kubeContext) {
                    Text("Choose…").tag("")
                    ForEach(store.contexts.filter { !$0.isLocal && $0.name != "kube" }) { c in
                        Text(c.shortName).tag(c.name)
                    }
                }
                .frame(maxWidth: 260)
                TextField("Registry (AX_IMAGE_REPO)", text: $model.imageRepo, prompt: Text("gcr.io/my-project"))
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 240)
                Picker("Arch", selection: $model.arch) {
                    Text("amd64").tag("amd64")
                    Text("arm64").tag("arm64")
                }
                .frame(width: 130)
            }
            Spacer()
        }
        .disabled(model.running)
    }

    private var pipeline: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(Array(model.steps.enumerated()), id: \.element.id) { i, step in
                    if i > 0 { PipeConnector(active: model.steps[i - 1].state == .ok && step.enabled) }
                    StepCard(step: step, selected: selected == step.id,
                             toggle: { model.steps[i].enabled.toggle(); if !model.steps[i].enabled { model.steps[i].state = .skipped } else { model.steps[i].state = .idle } },
                             run: { Task { await model.runOne(step.id) } },
                             running: model.running)
                        .onTapGesture { selected = selected == step.id ? nil : step.id }
                }
            }
            .padding(.vertical, 6)
        }
    }

    private var console: some View {
        VStack(spacing: 0) {
            HStack {
                Label("Output", systemImage: "terminal").font(.callout.weight(.medium))
                if let s = selected { Chip(text: "showing \(s)", icon: "line.3.horizontal.decrease.circle") }
                Spacer()
                Button("Clear") { model.log.removeAll() }.disabled(model.running)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .foregroundStyle(.white.opacity(0.85))

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(model.log.filter { selected == nil || $0.step == selected }) { line in
                            Text(line.text)
                                .font(.system(size: 12, weight: line.isHeader ? .bold : .regular, design: .monospaced))
                                .foregroundStyle(color(for: line))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.top, line.isHeader ? 6 : 0)
                                .id(line.id)
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.bottom, 14)
                }
                .onChange(of: model.log.count) {
                    if let last = model.log.last { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
            .overlay {
                if model.log.isEmpty {
                    Text("Run the pipeline, or click ▶ on a single step.").foregroundStyle(.white.opacity(0.4))
                }
            }
        }
        .background(Color(hex: 0x16161A))
    }

    private func color(for line: LogLine) -> Color {
        if line.isHeader {
            if line.text.hasPrefix("✓") { return Color(hex: 0x4CD964) }
            if line.text.hasPrefix("✗") { return Color(hex: 0xFF6B6B) }
            return Color(hex: 0x8AB4F8)
        }
        let t = line.text.lowercased()
        if t.contains("error") || t.contains("failed") { return Color(hex: 0xFF8A80) }
        if t.contains("warn") { return Color(hex: 0xFAB219) }
        return .white.opacity(0.82)
    }
}

struct StepCard: View {
    var step: DeployStep
    var selected: Bool
    var toggle: () -> Void
    var run: () -> Void
    var running: Bool

    private var tint: Color {
        switch step.state {
        case .idle: .accentColor
        case .running: Color(hex: 0x2A78D6)
        case .ok: Color(hex: 0x0CA30C)
        case .failed: Color(hex: 0xD03B3B)
        case .skipped: .secondary
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                ZStack {
                    Circle().fill(tint.opacity(step.enabled ? 0.15 : 0.06)).frame(width: 36, height: 36)
                    if step.state == .running {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: stateIcon).foregroundStyle(tint).font(.system(size: 16, weight: .semibold))
                    }
                }
                Spacer()
                Toggle("", isOn: Binding(get: { step.enabled }, set: { _ in toggle() }))
                    .toggleStyle(.switch).controlSize(.mini).labelsHidden()
                    .disabled(running)
                    .help(step.enabled ? "Included in the pipeline" : "Skipped")
            }
            Text(step.title).font(.headline).foregroundStyle(step.enabled ? .primary : .secondary)
            Text(step.detail).font(.caption).foregroundStyle(.secondary).lineLimit(3).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            HStack {
                Text(statusText).font(.caption.weight(.medium)).foregroundStyle(tint)
                Spacer()
                Button(action: run) { Image(systemName: "play.fill") }
                    .buttonStyle(.borderless).disabled(running).help("Run just this step")
            }
        }
        .padding(12)
        .frame(width: 190, height: 170)
        .card(highlighted: selected || step.state == .running, tint: tint)
        .opacity(step.enabled ? 1 : 0.6)
        .help(step.command)
        .animation(.snappy, value: step.state)
    }

    private var stateIcon: String {
        switch step.state {
        case .ok: "checkmark"
        case .failed: "xmark"
        case .skipped: "forward.end"
        default: step.icon
        }
    }

    private var statusText: String {
        switch step.state {
        case .idle: step.enabled ? "Ready" : "Skipped"
        case .running: "Running…"
        case .ok: step.duration.map { String(format: "Done in %.1fs", $0) } ?? "Done"
        case .failed(let c): "Failed (exit \(c))"
        case .skipped: "Skipped"
        }
    }
}

struct PipeConnector: View {
    var active: Bool

    var body: some View {
        ZStack {
            Capsule().fill(active ? Color(hex: 0x0CA30C) : Color.secondary.opacity(0.25)).frame(height: 3)
            Image(systemName: "chevron.right").font(.caption2.weight(.bold))
                .foregroundStyle(active ? Color(hex: 0x0CA30C) : .secondary)
                .padding(3)
                .background(Color(nsColor: .windowBackgroundColor), in: Circle())
        }
        .frame(width: 34)
        .animation(.snappy, value: active)
    }
}
