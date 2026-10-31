import SwiftUI

struct DesignerView: View {
    @Environment(Store.self) private var store
    @Environment(DesignerModel.self) private var model
    @State private var result: CommandResult?
    @State private var applying = false

    var body: some View {
        @Bindable var model = model
        HSplitView {
            form
                .frame(minWidth: 380, idealWidth: 440, maxWidth: 560)
            VStack(spacing: 0) {
                CompositionDiagram()
                    .padding(20)
                    .frame(maxWidth: .infinity)
                    .background(
                        Canvas { ctx, size in
                            for x in stride(from: 0, to: size.width, by: 18) {
                                for y in stride(from: 0, to: size.height, by: 18) {
                                    ctx.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 1.5, height: 1.5)), with: .color(.primary.opacity(0.09)))
                                }
                            }
                        }
                        .background(Color(nsColor: .windowBackgroundColor))
                    )
                Divider()
                yamlPane
            }
            .frame(minWidth: 460)
        }
        .toolbar {
            ToolbarItemGroup(placement: .navigation) {
                Menu {
                    ForEach(Template.allCases) { t in
                        Button { model.load(t) } label: { Label(t.rawValue, systemImage: t.icon) }
                    }
                    Divider()
                    Button("Open Manifest…") { model.openFile() }
                } label: {
                    Label("Templates", systemImage: "square.grid.2x2")
                }
            }
        }
    }

    // MARK: Form

    private var form: some View {
        @Bindable var model = model
        return Form {
            if model.rawMode {
                SwiftUI.Section {
                    Label("Editing YAML directly. The form is paused.", systemImage: "chevron.left.forwardslash.chevron.right")
                    Button("Back to the visual editor") { model.rawMode = false }
                }
            } else {
                SwiftUI.Section {
                    LabeledField("Name", error: Validate.label(model.name)) { TextField("", text: $model.name) }
                    LabeledField("Atespace", error: model.atespace.isEmpty ? nil : Validate.label(model.atespace)) {
                        TextField("", text: $model.atespace, prompt: Text(store.atespace))
                    }
                    LabeledField("Image", error: Validate.image(model.image)) {
                        TextField("", text: $model.image, prompt: Text("server default runner")).font(.callout.monospaced())
                    }
                    TextField("Command", text: $model.command, prompt: Text("runner decides")).font(.callout.monospaced())
                    Toggle("Debug (enables ax ssh)", isOn: $model.debug)
                } header: { header("Task", "shippingbox.fill", .blue) }

                SwiftUI.Section {
                    HStack {
                        Image(systemName: "cpu").foregroundStyle(.secondary).frame(width: 18)
                        Slider(value: $model.cpu, in: 0.25...8, step: 0.25) { Text("CPU") }
                        Text(model.cpuString).monospacedDigit().frame(width: 50, alignment: .trailing)
                    }
                    HStack {
                        Image(systemName: "memorychip").foregroundStyle(.secondary).frame(width: 18)
                        Slider(value: $model.memoryMi, in: 256...16384, step: 256) { Text("Memory") }
                        Text(model.memoryString).monospacedDigit().frame(width: 50, alignment: .trailing)
                    }
                } header: { header("Sandbox limits", "gauge.with.needle", .indigo) }

                SwiftUI.Section {
                    ForEach($model.env) { $kv in
                        HStack {
                            TextField("", text: $kv.key, prompt: Text("NAME")).font(.callout.monospaced()).frame(maxWidth: 160)
                            if model.isSecret(kv.key) {
                                SecureField("", text: $kv.value, prompt: Text("secret value"))
                            } else {
                                TextField("", text: $kv.value, prompt: Text("value"))
                            }
                            removeButton { model.env.removeAll { $0.id == kv.id } }
                        }
                    }
                    Button { model.env.append(KeyValue()) } label: { Label("Add variable", systemImage: "plus") }
                } header: { header("Environment", "list.bullet.rectangle", .gray) }

                SwiftUI.Section {
                    Picker("Runner config", selection: $model.configMode) {
                        ForEach(ConfigMode.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    switch model.configMode {
                    case .none: EmptyView()
                    case .claudeCode:
                        TextEditor(text: $model.prompt).font(.callout).frame(minHeight: 90)
                            .overlay(alignment: .topLeading) { if model.prompt.isEmpty { Text("Prompt…").foregroundStyle(.tertiary).padding(6) } }
                        TextField("Model", text: $model.ccModel)
                        Stepper("Max turns: \(model.maxTurns)", value: $model.maxTurns, in: 1...500, step: 5)
                        Toggle("Skip permission prompts (sandbox is the boundary)", isOn: $model.skipPermissions)
                        Text("Needs the Claude Code runner image and an ax built with spec.config support.")
                            .font(.caption).foregroundStyle(.secondary)
                    case .custom:
                        TextEditor(text: $model.customConfig).font(.callout.monospaced()).frame(minHeight: 90)
                    }
                } header: { header("Config", "slider.horizontal.3", .orange) }

                SwiftUI.Section {
                    Picker("Workspace", selection: $model.workspaceMode) {
                        ForEach(WorkspaceMode.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    switch model.workspaceMode {
                    case .none:
                        Text("The task gets an empty /workspace.").font(.callout).foregroundStyle(.secondary)
                    case .existing:
                        Picker("Bind", selection: $model.existingWorkspace) {
                            Text("Choose…").tag("")
                            ForEach(store.workspaces) { Text($0.name).tag($0.name) }
                        }
                    case .new:
                        LabeledField("Name", error: Validate.label(model.wsName)) { TextField("", text: $model.wsName) }
                        ForEach($model.repos) { $r in
                            VStack(spacing: 4) {
                                HStack {
                                    Image(systemName: "arrow.triangle.branch").foregroundStyle(.orange)
                                    TextField("https://github.com/org/repo.git", text: $r.repo).font(.callout.monospaced())
                                    removeButton { model.repos.removeAll { $0.id == r.id } }
                                }
                                HStack {
                                    TextField("name", text: $r.name)
                                    TextField("branch", text: $r.branch)
                                }
                                .font(.caption).padding(.leading, 24)
                            }
                        }
                        ForEach($model.files) { $f in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Image(systemName: "doc.text").foregroundStyle(.blue)
                                    TextField("path", text: $f.path).font(.callout.monospaced())
                                    removeButton { model.files.removeAll { $0.id == f.id } }
                                }
                                TextEditor(text: $f.content).font(.caption.monospaced()).frame(minHeight: 60)
                            }
                        }
                        ForEach($model.servers) { $s in
                            HStack {
                                Image(systemName: "powerplug.fill").foregroundStyle(.pink)
                                TextField("name", text: $s.name).frame(maxWidth: 110)
                                TextField("http://…", text: $s.endpoint).font(.callout.monospaced())
                                removeButton { model.servers.removeAll { $0.id == s.id } }
                            }
                        }
                        HStack {
                            Button { model.repos.append(RepoDraft()) } label: { Label("Repo", systemImage: "plus") }
                            Button { model.files.append(FileDraft()) } label: { Label("File", systemImage: "plus") }
                            Button { model.servers.append(ServerDraft()) } label: { Label("MCP server", systemImage: "plus") }
                        }
                    }
                } header: { header("Workspace", "folder.fill", .purple) }

                SwiftUI.Section {
                    Toggle("Include a Model resource", isOn: $model.includeModel)
                    if model.includeModel {
                        LabeledField("Name", error: Validate.label(model.modelName)) { TextField("", text: $model.modelName) }
                        Picker("Provider", selection: $model.provider) {
                            Text("Anthropic").tag("anthropic")
                            Text("Google").tag("google")
                        }
                        .onChange(of: model.provider) { _, p in
                            model.modelID = p == "google" ? "gemini-3.8-flash" : "claude-opus-5-5"
                            model.secretName = p == "google" ? "gemini-api-secret" : "anthropic-api-secret"
                            model.secretKey = p == "google" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY"
                        }
                        TextField("Model", text: $model.modelID)
                        TextField("Secret name", text: $model.secretName)
                        TextField("Secret key", text: $model.secretKey)
                        Stepper("Max tokens: \(model.maxTokens)", value: $model.maxTokens, in: 0...200_000, step: 1000)
                    }
                } header: { header("Model", "cpu", .teal) }
            }
        }
        .formStyle(.grouped)
    }

    private func header(_ title: String, _ icon: String, _ tint: Color) -> some View {
        Label(title, systemImage: icon).foregroundStyle(tint).font(.headline)
    }

    private func removeButton(_ action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: "minus.circle.fill").foregroundStyle(.secondary) }.buttonStyle(.plain)
    }

    // MARK: YAML + apply

    private var yamlPane: some View {
        @Bindable var model = model
        return VStack(spacing: 0) {
            HStack {
                Label(model.fileURL?.lastPathComponent ?? "manifest.yaml", systemImage: "doc.plaintext")
                    .font(.callout.weight(.medium))
                Spacer()
                if !model.rawMode {
                    Button("Edit YAML") { model.enterRawMode() }
                }
                Button { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(model.manifest, forType: .string) } label: {
                    Image(systemName: "doc.on.doc")
                }
                .help("Copy manifest")
                Button { model.saveFile() } label: { Image(systemName: "square.and.arrow.down") }.help("Save manifest…")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)

            if model.rawMode {
                TextEditor(text: $model.rawYAML)
                    .font(.system(.callout, design: .monospaced))
                    .scrollContentBackground(.hidden)
                    .padding(8)
            } else {
                ScrollView {
                    YAMLText(source: model.preview)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                }
            }

            Divider()
            footer
        }
        .background(Color(nsColor: .textBackgroundColor))
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(model.issues) { i in
                Label(i.text, systemImage: i.severity == .error ? "xmark.octagon.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(i.severity == .error ? Color(hex: 0xD03B3B) : Color(hex: 0xC98A00))
                    .font(.callout)
            }
            if let r = result {
                Label(r.ok ? r.stdout.trimmingCharacters(in: .whitespacesAndNewlines) : r.errorSummary,
                      systemImage: r.ok ? "checkmark.seal.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(r.ok ? Color(hex: 0x0CA30C) : Color(hex: 0xD03B3B))
                    .font(.callout)
                    .textSelection(.enabled)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            HStack {
                Text("Applies to \(store.currentContext?.shortName ?? "…") · \(model.atespace.isEmpty ? store.atespace : model.atespace)")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button {
                    applying = true
                    Task {
                        let r = await store.apply(yaml: model.manifest)
                        withAnimation(.snappy) { result = r }
                        applying = false
                    }
                } label: {
                    HStack {
                        if applying { ProgressView().controlSize(.small) }
                        Label("Apply", systemImage: "paperplane.fill")
                    }
                    .padding(.horizontal, 8)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!model.canApply || applying)
            }
        }
        .padding(14)
    }
}

struct LabeledField<Content: View>: View {
    var label: String
    var error: String?
    @ViewBuilder var content: Content

    init(_ label: String, error: String?, @ViewBuilder content: () -> Content) {
        self.label = label
        self.error = error
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            LabeledContent(label) { content }
            if let error {
                Text(error).font(.caption2).foregroundStyle(Color(hex: 0xC98A00))
            }
        }
    }
}

/// Minimal YAML syntax coloring: keys, strings, comments, document separators.
struct YAMLText: View {
    var source: String

    var body: some View {
        Text(highlighted).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
    }

    private var highlighted: AttributedString {
        var out = AttributedString()
        for (i, line) in source.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
            if i > 0 { out += AttributedString("\n") }
            let s = String(line)
            let trimmed = s.trimmingCharacters(in: .whitespaces)
            if trimmed == "---" || trimmed.hasPrefix("#") {
                var a = AttributedString(s); a.foregroundColor = .secondary; out += a; continue
            }
            if let colon = keyColon(in: s) {
                var k = AttributedString(String(s[..<colon]))
                k.foregroundColor = Color(hex: 0x8E44AD)
                var rest = AttributedString(String(s[colon...]))
                if s[colon...].contains("\"") { rest.foregroundColor = Color(hex: 0x1F7A3A) }
                else if s[colon...].contains("|") { rest.foregroundColor = .secondary }
                out += k + rest
            } else {
                var a = AttributedString(s)
                a.foregroundColor = Color(hex: 0x1F7A3A)
                out += a
            }
        }
        return out
    }

    /// The colon that ends a mapping key, if the line has one before any quote.
    private func keyColon(in s: String) -> String.Index? {
        guard let c = s.firstIndex(of: ":") else { return nil }
        if let q = s.firstIndex(of: "\""), q < c { return nil }
        let next = s.index(after: c)
        return next == s.endIndex || s[next] == " " ? c : nil
    }
}

/// A live picture of what's being designed: Model, Workspace sources, and the Task sandbox.
struct CompositionDiagram: View {
    @Environment(DesignerModel.self) private var m

    var body: some View {
        if m.rawMode {
            HStack {
                Image(systemName: "chevron.left.forwardslash.chevron.right").font(.title)
                Text("Raw YAML mode — apply as written.").font(.headline)
            }
            .foregroundStyle(.secondary)
            .frame(height: 150)
        } else {
            HStack(alignment: .center, spacing: 0) {
                if m.workspaceMode != .none {
                    workspaceCard
                    connector(.purple)
                }
                sandboxCard
                if m.includeModel {
                    connector(.teal, dashed: true)
                    modelCard
                }
            }
            .animation(.snappy, value: m.workspaceMode)
            .animation(.snappy, value: m.includeModel)
        }
    }

    private var workspaceCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(m.workspaceMode == .existing ? (m.existingWorkspace.isEmpty ? "workspace?" : m.existingWorkspace) : m.wsName,
                  systemImage: "folder.fill")
                .font(.headline).foregroundStyle(.purple)
            if m.workspaceMode == .existing {
                Text("existing workspace").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(m.repos.prefix(3)) { r in
                    Label(r.repo.split(separator: "/").last.map(String.init) ?? "repo", systemImage: "arrow.triangle.branch")
                        .font(.caption).foregroundStyle(.orange).lineLimit(1)
                }
                ForEach(m.files.prefix(3)) { f in
                    Label(f.path, systemImage: "doc.text").font(.caption).foregroundStyle(.blue).lineLimit(1)
                }
                ForEach(m.servers.prefix(3)) { s in
                    Label(s.name.isEmpty ? "mcp" : s.name, systemImage: "powerplug.fill").font(.caption).foregroundStyle(.pink).lineLimit(1)
                }
                if m.repos.isEmpty && m.files.isEmpty && m.servers.isEmpty {
                    Text("empty").font(.caption).foregroundStyle(.tertiary)
                }
            }
        }
        .padding(12)
        .frame(width: 170, alignment: .leading)
        .card(highlighted: true, tint: .purple.opacity(0.5))
    }

    private var sandboxCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "shippingbox.fill").foregroundStyle(.blue)
                Text(m.name.isEmpty ? "task" : m.name).font(.headline).lineLimit(1)
                Spacer()
                if m.debug { Chip(text: "ssh", icon: "terminal", tint: .green) }
            }
            Text(shortImage(m.image) ?? "default runner image").font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
            if m.configMode == .claudeCode {
                Chip(text: "Claude Code · \(m.maxTurns) turns", icon: "sparkles", tint: .orange)
            }
            meter("CPU", m.cpuString, m.cpu / 8, .indigo)
            meter("Mem", m.memoryString, m.memoryMi / 16384, .blue)
            HStack(spacing: 4) {
                Image(systemName: "folder")
                Text("/workspace").font(.caption.monospaced())
            }
            .font(.caption).foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(width: 230)
        .background(
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(Color.blue.opacity(0.5), style: StrokeStyle(lineWidth: 1.5, dash: [6, 4]))
                .background(RoundedRectangle(cornerRadius: 14).fill(.background))
        )
        .overlay(alignment: .topTrailing) {
            Text("SANDBOX").font(.system(size: 8, weight: .heavy)).tracking(1.2).foregroundStyle(.blue.opacity(0.7))
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(.background, in: Capsule())
                .offset(x: -12, y: -7)
        }
    }

    private func meter(_ label: String, _ value: String, _ fraction: Double, _ tint: Color) -> some View {
        HStack(spacing: 6) {
            Text(label).font(.caption).foregroundStyle(.secondary).frame(width: 30, alignment: .leading)
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.secondary.opacity(0.15))
                    Capsule().fill(tint).frame(width: max(4, g.size.width * min(1, fraction)))
                }
            }
            .frame(height: 6)
            Text(value).font(.caption.monospacedDigit()).frame(width: 44, alignment: .trailing)
        }
        .animation(.snappy, value: fraction)
    }

    private var modelCard: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(m.modelName, systemImage: "cpu").font(.headline).foregroundStyle(.teal)
            Text(m.provider).font(.caption)
            Text(m.modelID).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
            Label(m.secretName, systemImage: "key.fill").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
        .padding(12)
        .frame(width: 160, alignment: .leading)
        .card(highlighted: true, tint: .teal.opacity(0.5))
    }

    private func connector(_ color: Color, dashed: Bool = false) -> some View {
        HStack(spacing: 0) {
            Rectangle().fill(.clear).frame(height: 2)
                .overlay(
                    Line().stroke(color, style: StrokeStyle(lineWidth: 2, dash: dashed ? [4, 4] : []))
                )
            Image(systemName: "arrowtriangle.right.fill").font(.system(size: 9)).foregroundStyle(color)
        }
        .frame(width: 44)
    }
}

private struct Line: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: rect.minX, y: rect.midY))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        return p
    }
}
