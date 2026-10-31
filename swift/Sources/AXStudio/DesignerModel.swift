import SwiftUI
import AppKit
import UniformTypeIdentifiers

struct KeyValue: Identifiable, Hashable {
    let id = UUID()
    var key = ""
    var value = ""
}

struct RepoDraft: Identifiable, Hashable {
    let id = UUID()
    var name = "origin"
    var repo = ""
    var branch = "main"
}

struct FileDraft: Identifiable, Hashable {
    let id = UUID()
    var path = "AGENTS.md"
    var content = ""
}

struct ServerDraft: Identifiable, Hashable {
    let id = UUID()
    var name = ""
    var endpoint = ""
}

enum WorkspaceMode: String, CaseIterable, Identifiable {
    case none = "None", existing = "Existing", new = "New"
    var id: String { rawValue }
}

enum ConfigMode: String, CaseIterable, Identifiable {
    case none = "None", claudeCode = "Claude Code", custom = "Custom YAML"
    var id: String { rawValue }
}

enum Template: String, CaseIterable, Identifiable {
    case blank = "Blank", simple = "Simple task", claudeCode = "Claude Code on a repo"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .blank: "doc"
        case .simple: "terminal"
        case .claudeCode: "sparkles"
        }
    }
}

/// Everything the Designer edits. Generates multi-document YAML for `ax apply`.
@MainActor
@Observable
final class DesignerModel {
    // Task
    var name = "my-task"
    var atespace = ""
    var image = ""
    var command = ""
    var env: [KeyValue] = []
    var cpu: Double = 1
    var memoryMi: Double = 512
    var debug = true

    // Runner config
    var configMode: ConfigMode = .none
    var prompt = ""
    var ccModel = "claude-opus-5-5"
    var maxTurns = 50
    var skipPermissions = true
    var customConfig = "key: value\n"

    // Workspace
    var workspaceMode: WorkspaceMode = .none
    var existingWorkspace = ""
    var wsName = "my-workspace"
    var repos: [RepoDraft] = []
    var files: [FileDraft] = []
    var servers: [ServerDraft] = []

    // Model
    var includeModel = false
    var modelName = "default-model"
    var provider = "anthropic"
    var modelID = "claude-opus-5-5"
    var secretName = "anthropic-api-secret"
    var secretKey = "ANTHROPIC_API_KEY"
    var maxTokens = 16000

    // Raw editing
    var rawMode = false
    var rawYAML = ""
    var fileURL: URL?

    init() { load(.simple) }

    func reset() { load(.blank) }

    func load(_ t: Template) {
        name = "my-task"; atespace = ""; image = ""; command = ""; env = []; cpu = 1; memoryMi = 512; debug = true
        configMode = .none; prompt = ""; workspaceMode = .none; existingWorkspace = ""
        wsName = "my-workspace"; repos = []; files = []; servers = []; includeModel = false
        rawMode = false; rawYAML = ""; fileURL = nil
        switch t {
        case .blank:
            break
        case .simple:
            name = "simple-task"
            image = "gcr.io/ax-substrate/ate-images/ax-task-runner@sha256:3a0dea6ad8b55278685db58aca6e37dc4ba04056831d45bef3aaeafdca43cac6"
            command = "sh -c 'echo $ENVIRONMENT'"
            env = [KeyValue(key: "ENVIRONMENT", value: "test")]
        case .claudeCode:
            name = "claude-code"
            image = "gcr.io/ax-images/ax-images@sha256:REPLACE_WITH_PUSHED_DIGEST"
            cpu = 2; memoryMi = 4096
            configMode = .claudeCode
            prompt = """
            Read the repository, install it with its test dependencies, and run the
            test suite. Fix any failing or flaky tests you find. Finish by writing a
            short markdown report to /workspace/claude-output.md.
            """
            env = [KeyValue(key: "ANTHROPIC_API_KEY", value: "")]
            workspaceMode = .new
            wsName = "itsdangerous"
            repos = [RepoDraft(name: "origin", repo: "https://github.com/pallets/itsdangerous.git", branch: "main")]
            files = [FileDraft(path: "CLAUDE.md", content: "# Working in this repo\n- Install with `pip install -e . pytest`, test with `pytest`.\n- Do not push or open pull requests.\n")]
        }
    }

    // MARK: Validation

    struct Issue: Identifiable {
        let id = UUID()
        var severity: Severity
        var text: String
        enum Severity { case error, warning }
    }

    var issues: [Issue] {
        if rawMode { return [] }
        var out: [Issue] = []
        if let e = Validate.label(name) { out.append(Issue(severity: .error, text: "Task name: \(e)")) }
        if !atespace.isEmpty, let e = Validate.label(atespace) { out.append(Issue(severity: .error, text: "Atespace: \(e)")) }
        if let w = Validate.image(image) { out.append(Issue(severity: .warning, text: "Image: \(w)")) }
        if image.contains("REPLACE_WITH") { out.append(Issue(severity: .error, text: "Image: replace the placeholder digest")) }
        if workspaceMode == .new, let e = Validate.label(wsName) { out.append(Issue(severity: .error, text: "Workspace name: \(e)")) }
        if workspaceMode == .existing, existingWorkspace.isEmpty { out.append(Issue(severity: .error, text: "Pick a workspace to bind")) }
        if workspaceMode == .new, repos.contains(where: { $0.repo.isEmpty }) { out.append(Issue(severity: .warning, text: "A git repo has no URL")) }
        if includeModel, let e = Validate.label(modelName) { out.append(Issue(severity: .error, text: "Model name: \(e)")) }
        if env.contains(where: { $0.key.isEmpty }) { out.append(Issue(severity: .warning, text: "An env var has no name")) }
        if env.contains(where: { isSecret($0.key) && $0.value.isEmpty }) {
            out.append(Issue(severity: .warning, text: "A credential env var is empty"))
        }
        if configMode == .claudeCode, prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            out.append(Issue(severity: .error, text: "Claude Code needs a prompt"))
        }
        return out
    }

    var canApply: Bool { !issues.contains { $0.severity == .error } }

    func isSecret(_ key: String) -> Bool {
        let k = key.uppercased()
        return k.contains("KEY") || k.contains("TOKEN") || k.contains("SECRET") || k.contains("PASSWORD")
    }

    // MARK: YAML

    var memoryString: String {
        memoryMi >= 1024 && Int(memoryMi) % 1024 == 0 ? "\(Int(memoryMi) / 1024)Gi" : "\(Int(memoryMi))Mi"
    }

    var cpuString: String {
        cpu < 1 ? "\(Int((cpu * 1000).rounded()))m" : (cpu == cpu.rounded() ? "\(Int(cpu))" : String(format: "%g", cpu))
    }

    /// The manifest that will be applied: either the form's output or the raw text.
    var manifest: String { rawMode ? rawYAML : generated }

    /// Values are emitted without secrets so the preview is safe to screenshot.
    var preview: String { rawMode ? rawYAML : generate(redact: true) }

    var generated: String { generate(redact: false) }

    private func generate(redact: Bool) -> String {
        var docs: [String] = []
        let ates = atespace.isEmpty ? "" : "\n  atespace: \(q(atespace))"

        if includeModel {
            var y = """
            apiVersion: ax.io/v1alpha1
            kind: Model
            metadata:
              name: \(q(modelName))\(ates)
            spec:
              provider: \(q(provider))
              model: \(q(modelID))
              secretKey:
                name: \(q(secretName))
                key: \(q(secretKey))
            """
            if maxTokens > 0 { y += "\n  parameters:\n    maxTokens: \(maxTokens)" }
            docs.append(y)
        }

        if workspaceMode == .new {
            var y = "apiVersion: ax.io/v1alpha1\nkind: Workspace\nmetadata:\n  name: \(q(wsName))\(ates)\nspec:"
            var empty = true
            if !repos.isEmpty {
                empty = false
                y += "\n  git:"
                for r in repos {
                    y += "\n    - name: \(q(r.name.isEmpty ? "origin" : r.name))\n      repo: \(q(r.repo))"
                    if !r.branch.isEmpty { y += "\n      branch: \(q(r.branch))" }
                }
            }
            if !files.isEmpty {
                empty = false
                y += "\n  files:"
                for f in files {
                    y += "\n    - path: \(q(f.path))\n      content: " + block(f.content, indent: 8)
                }
            }
            if !servers.isEmpty {
                empty = false
                y += "\n  mcp:\n    servers:"
                for s in servers { y += "\n      - name: \(q(s.name))\n        endpoint: \(q(s.endpoint))" }
            }
            if empty { y += " {}" }
            docs.append(y)
        }

        var t = "apiVersion: ax.io/v1alpha1\nkind: Task\nmetadata:\n  name: \(q(name))\(ates)\nspec:"
        if !image.isEmpty { t += "\n  image: \(q(image))" }
        let argv = Self.tokenize(command)
        if !argv.isEmpty { t += "\n  command: [" + argv.map(q).joined(separator: ", ") + "]" }
        switch configMode {
        case .none: break
        case .claudeCode:
            t += "\n  config:\n    prompt: " + block(prompt, indent: 6)
            t += "\n    model: \(q(ccModel))\n    maxTurns: \(maxTurns)"
            if skipPermissions { t += "\n    dangerouslySkipPermissions: true" }
        case .custom:
            let body = customConfig.split(separator: "\n", omittingEmptySubsequences: false).map { "    " + $0 }.joined(separator: "\n")
            t += "\n  config:\n" + body.trimmingTrailing()
        }
        let realEnv = env.filter { !$0.key.isEmpty }
        if !realEnv.isEmpty {
            t += "\n  env:"
            for kv in realEnv {
                let v = redact && isSecret(kv.key) && !kv.value.isEmpty ? "••••••••" : kv.value
                t += "\n    - name: \(q(kv.key))\n      value: \(q(v))"
            }
        }
        t += "\n  resources:\n    limits:\n      cpu: \(q(cpuString))\n      memory: \(q(memoryString))"
        switch workspaceMode {
        case .none: break
        case .existing: if !existingWorkspace.isEmpty { t += "\n  workspace:\n    name: \(q(existingWorkspace))" }
        case .new: t += "\n  workspace:\n    name: \(q(wsName))"
        }
        if debug { t += "\n  debug: true" }
        docs.append(t)

        return docs.joined(separator: "\n---\n") + "\n"
    }

    /// Double-quoted YAML scalar.
    private func q(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n").replacingOccurrences(of: "\t", with: "\\t") + "\""
    }

    /// Literal block scalar for multi-line text.
    private func block(_ s: String, indent: Int) -> String {
        guard s.contains("\n") else { return q(s) }
        let pad = String(repeating: " ", count: indent)
        let body = s.trimmingTrailing().split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.isEmpty ? "" : pad + $0 }.joined(separator: "\n")
        return "|\n" + body
    }

    /// Splits a command line like a POSIX shell would for quoting purposes.
    static func tokenize(_ s: String) -> [String] {
        var out: [String] = [], cur = "", quote: Character?, any = false, escape = false
        for ch in s {
            if escape { cur.append(ch); escape = false; continue }
            if ch == "\\" && quote != "'" { escape = true; any = true; continue }
            if let qc = quote {
                if ch == qc { quote = nil } else { cur.append(ch) }
                continue
            }
            if ch == "'" || ch == "\"" { quote = ch; any = true; continue }
            if ch.isWhitespace {
                if any || !cur.isEmpty { out.append(cur); cur = ""; any = false }
                continue
            }
            cur.append(ch)
        }
        if any || !cur.isEmpty { out.append(cur) }
        return out
    }

    // MARK: Files

    func enterRawMode() {
        rawYAML = generated
        rawMode = true
    }

    func openFile() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "yaml")!, UTType(filenameExtension: "yml")!]
        let repo = (UserDefaults.standard.string(forKey: "repoPath") ?? "~/ax") as NSString
        panel.directoryURL = URL(fileURLWithPath: repo.expandingTildeInPath).appendingPathComponent("examples")
        guard panel.runModal() == .OK, let url = panel.url, let text = try? String(contentsOf: url, encoding: .utf8) else { return }
        rawYAML = text
        rawMode = true
        fileURL = url
    }

    func saveFile() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "yaml")!]
        panel.nameFieldStringValue = fileURL?.lastPathComponent ?? "\(name).yaml"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        try? manifest.write(to: url, atomically: true, encoding: .utf8)
        fileURL = url
    }
}

private extension String {
    func trimmingTrailing() -> String {
        var s = self
        while let last = s.last, last.isWhitespace { s.removeLast() }
        return s
    }
}
