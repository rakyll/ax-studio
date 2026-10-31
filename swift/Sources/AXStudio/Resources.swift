import Foundation
import SwiftUI

// MARK: - Phase

/// A task's `status.phase`. Unknown phases are kept verbatim so a newer server
/// never breaks the UI.
enum Phase: Hashable, Comparable {
    case pending, running, suspended, completed, failed, terminating
    case other(String)

    init(_ raw: String) {
        switch raw.lowercased() {
        case "pending", "", "<none>": self = .pending
        case "running": self = .running
        case "suspended": self = .suspended
        case "completed", "succeeded": self = .completed
        case "failed": self = .failed
        case "terminating": self = .terminating
        default: self = .other(raw)
        }
    }

    /// Board columns, in lifecycle order.
    static let columns: [Phase] = [.pending, .running, .suspended, .completed, .failed, .terminating]

    var label: String {
        switch self {
        case .pending: "Pending"
        case .running: "Running"
        case .suspended: "Suspended"
        case .completed: "Completed"
        case .failed: "Failed"
        case .terminating: "Terminating"
        case .other(let s): s
        }
    }

    /// Phase colors carry state, so they come from the reserved status palette
    /// and always ship with `icon` and `label`, never color alone.
    var color: Color {
        switch self {
        case .pending: Color(hex: 0xFAB219)
        case .running: Color(hex: 0x0CA30C)
        case .suspended: Color(hex: 0x2A78D6)
        case .completed: Color(hex: 0x8A8984)
        case .failed: Color(hex: 0xD03B3B)
        case .terminating: Color(hex: 0xEC835A)
        case .other: Color.secondary
        }
    }

    var icon: String {
        switch self {
        case .pending: "hourglass"
        case .running: "play.circle.fill"
        case .suspended: "pause.circle.fill"
        case .completed: "checkmark.circle.fill"
        case .failed: "xmark.octagon.fill"
        case .terminating: "trash.circle.fill"
        case .other: "questionmark.circle"
        }
    }

    var isActive: Bool { self == .running || self == .pending }

    private var order: Int { Phase.columns.firstIndex(of: self) ?? Phase.columns.count }
    static func < (a: Phase, b: Phase) -> Bool { a.order < b.order }
}

// MARK: - Resources

struct AXTask: Identifiable, Hashable {
    var name: String
    var atespace: String
    var phase: Phase
    var actor: String?
    var workerIP: String?
    var age: String

    var id: String { "\(atespace)/\(name)" }
}

struct Condition: Hashable, Identifiable {
    var type: String
    var status: String
    var reason: String
    var message: String

    var id: String { type }
    var isTrue: Bool { status.lowercased() == "true" }
}

/// What `ax describe task` adds on top of the list view.
struct TaskDetail: Hashable {
    var workspace: String?
    var workspacePath: String?
    var image: String?
    var command: String?
    var conditions: [Condition] = []
}

struct GitRepo: Hashable {
    var name: String
    var repo: String
    var branch: String
}

struct AXWorkspace: Identifiable, Hashable {
    var name: String
    var atespace: String
    var gitCount: Int
    var mcpCount: Int
    var repos: [GitRepo] = []
    var mcpServers: [String] = []

    var id: String { "\(atespace)/\(name)" }
}

struct AXModel: Identifiable, Hashable {
    var name: String
    var atespace: String
    var provider: String
    var model: String

    var id: String { "\(atespace)/\(name)" }
}

struct AXContext: Identifiable, Hashable {
    var name: String
    var description: String
    var isCurrent: Bool

    var id: String { name }
    var isLocal: Bool { name == "local" }

    /// GKE context names are long; show the cluster part.
    var shortName: String {
        let parts = name.split(separator: "_")
        if name.hasPrefix("gke_"), parts.count >= 4 { return String(parts[3...].joined(separator: "_")) }
        return name
    }
}

// MARK: - Parsing `ax` output

enum Parse {
    /// Parses a tabwriter table into rows keyed by header. Every column `ax`
    /// prints in list views is a single token, so whitespace splitting is exact.
    static func table(_ text: String) -> [[String: String]] {
        let lines = text.split(separator: "\n").map(String.init).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        guard let header = lines.first else { return [] }
        let keys = header.split(whereSeparator: \.isWhitespace).map(String.init)
        return lines.dropFirst().map { line in
            let values = line.split(whereSeparator: \.isWhitespace).map(String.init)
            var row: [String: String] = [:]
            for (i, k) in keys.enumerated() where i < values.count { row[k] = values[i] }
            return row
        }
    }

    static func none(_ s: String?) -> String? {
        guard let s, !s.isEmpty, s != "<none>" else { return nil }
        return s
    }

    static func tasks(_ text: String) -> [AXTask] {
        table(text).compactMap { r in
            guard let name = r["NAME"] else { return nil }
            return AXTask(name: name, atespace: r["ATESPACE"] ?? "default", phase: Phase(r["PHASE"] ?? ""),
                          actor: none(r["ACTOR"]), workerIP: none(r["WORKER-IP"]), age: r["AGE"] ?? "")
        }
    }

    static func workspaces(_ text: String) -> [AXWorkspace] {
        table(text).compactMap { r in
            guard let name = r["NAME"] else { return nil }
            return AXWorkspace(name: name, atespace: r["ATESPACE"] ?? "default",
                               gitCount: Int(r["GIT-REPOS"] ?? "") ?? 0, mcpCount: Int(r["MCP-SERVERS"] ?? "") ?? 0)
        }
    }

    static func models(_ text: String) -> [AXModel] {
        table(text).compactMap { r in
            guard let name = r["NAME"] else { return nil }
            return AXModel(name: name, atespace: r["ATESPACE"] ?? "default",
                           provider: r["PROVIDER"] ?? "", model: r["MODEL"] ?? "")
        }
    }

    /// `ax config get-contexts`: an optional `*` marker, the name, then a free-text description.
    static func contexts(_ text: String) -> [AXContext] {
        text.split(separator: "\n").dropFirst().compactMap { raw in
            var line = String(raw)
            let current = line.trimmingCharacters(in: .whitespaces).hasPrefix("*")
            line = line.replacingOccurrences(of: "*", with: " ", options: [], range: line.range(of: "*"))
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { return nil }
            let name = String(trimmed.prefix { !$0.isWhitespace })
            let desc = trimmed.dropFirst(name.count).trimmingCharacters(in: .whitespaces)
            return AXContext(name: name, description: desc, isCurrent: current)
        }
    }

    /// `ax describe task <name>`.
    static func taskDetail(_ text: String) -> TaskDetail {
        var d = TaskDetail()
        let lines = text.components(separatedBy: "\n")
        var conditionHeader: String?
        for line in lines {
            if let header = conditionHeader {
                if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
                if let c = conditionRow(line, header: header) { d.conditions.append(c) }
                continue
            }
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("TYPE") { conditionHeader = line; continue }
            guard let colon = line.firstIndex(of: ":"), !line.hasPrefix(" ") else { continue }
            let key = line[..<colon].trimmingCharacters(in: .whitespaces)
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            switch key {
            case "Workspace":
                d.workspace = value.split(separator: " ").first.map(String.init)
                if let r = value.range(of: "path=") {
                    d.workspacePath = String(value[r.upperBound...].prefix { !$0.isWhitespace })
                }
            case "Image": d.image = value
            case "Command": d.command = value
            default: break
            }
        }
        return d
    }

    /// Condition rows are sliced by the header's column offsets because REASON
    /// can be empty and MESSAGE can contain spaces.
    private static func conditionRow(_ line: String, header: String) -> Condition? {
        func offset(_ word: String) -> Int? {
            header.range(of: word).map { header.distance(from: header.startIndex, to: $0.lowerBound) }
        }
        guard let t = offset("TYPE"), let s = offset("STATUS"), let r = offset("REASON"), let m = offset("MESSAGE") else { return nil }
        let chars = Array(line)
        func slice(_ a: Int, _ b: Int?) -> String {
            guard a < chars.count else { return "" }
            let end = min(b ?? chars.count, chars.count)
            return String(chars[a..<end]).trimmingCharacters(in: .whitespaces)
        }
        let type = slice(t, s)
        guard !type.isEmpty else { return nil }
        return Condition(type: type, status: slice(s, r), reason: slice(r, m), message: slice(m, nil))
    }

    /// `ax describe workspace <name>`: repos as `  - name (repo, branch: b)`, servers as `  - name: endpoint`.
    static func workspaceDetail(_ text: String, into ws: inout AXWorkspace) {
        var section = ""
        ws.repos = []
        ws.mcpServers = []
        for line in text.components(separatedBy: "\n") {
            if !line.hasPrefix(" ") { section = line.trimmingCharacters(in: .whitespaces); continue }
            let item = line.trimmingCharacters(in: .whitespaces)
            guard item.hasPrefix("- ") else { continue }
            let body = String(item.dropFirst(2))
            if section.hasPrefix("Git Repositories"),
               let open = body.firstIndex(of: "("), let close = body.lastIndex(of: ")") {
                let name = body[..<open].trimmingCharacters(in: .whitespaces)
                let inner = body[body.index(after: open)..<close]
                let parts = inner.components(separatedBy: ", branch: ")
                ws.repos.append(GitRepo(name: name, repo: parts.first ?? "", branch: parts.count > 1 ? parts[1] : "main"))
            } else if section.hasPrefix("MCP Servers") {
                ws.mcpServers.append(String(body.prefix { $0 != ":" }))
            }
        }
    }
}

// MARK: - Validation

enum Validate {
    /// `metadata.name` and `metadata.atespace` must be RFC 1123 labels.
    static func label(_ s: String) -> String? {
        if s.isEmpty { return "required" }
        if s.count > 63 { return "at most 63 characters" }
        let ok = s.range(of: "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", options: .regularExpression) != nil
        return ok ? nil : "lowercase letters, digits and '-', starting and ending alphanumeric"
    }

    /// Substrate rejects images that aren't pinned by digest.
    static func image(_ s: String) -> String? {
        if s.isEmpty { return nil }
        return s.contains("@sha256:") ? nil : "pin by digest (image@sha256:…) or Substrate will reject it"
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}
