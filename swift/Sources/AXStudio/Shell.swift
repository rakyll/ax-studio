import Foundation

/// The result of running a command to completion.
struct CommandResult: Sendable {
    var status: Int32
    var stdout: String
    var stderr: String

    var ok: Bool { status == 0 }

    /// The most useful single line to show when a command fails.
    var errorSummary: String {
        let text = stderr.isEmpty ? stdout : stderr
        let lines = text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        return lines.last(where: { !$0.isEmpty }).map { $0.replacingOccurrences(of: "Error: ", with: "") }
            ?? "exited with status \(status)"
    }
}

/// Runs processes the way the user's terminal would: same PATH, real exit codes.
///
/// Apps launched from Finder get a minimal PATH, so the login shell's PATH is
/// captured once and reused. Without this, `ax`, `kubectl`, `podman`, and `go`
/// would not be found.
enum Shell {
    static let environment: [String: String] = {
        var env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var parts: [String] = []
        if let login = capture("/bin/zsh", ["-l", "-c", "printf %s \"$PATH\""]), !login.isEmpty {
            parts += login.split(separator: ":").map(String.init)
        }
        parts += (env["PATH"] ?? "").split(separator: ":").map(String.init)
        parts += ["\(home)/go/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/local/go/bin",
                  "\(home)/google-cloud-sdk/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        var seen = Set<String>()
        env["PATH"] = parts.filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: ":")
        env["TERM"] = "dumb"
        return env
    }()

    private static func capture(_ exe: String, _ args: [String]) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(data: data, encoding: .utf8)
    }

    /// Resolves a program name against the captured PATH.
    static func which(_ name: String) -> String? {
        if name.contains("/") {
            return FileManager.default.isExecutableFile(atPath: name) ? name : nil
        }
        for dir in (environment["PATH"] ?? "").split(separator: ":") {
            let candidate = "\(dir)/\(name)"
            if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }

    /// Runs a program and collects its output.
    static func run(_ program: String, _ args: [String], stdin: String? = nil,
                    cwd: String? = nil, extraEnv: [String: String] = [:]) async -> CommandResult {
        await Task.detached { runBlocking(program, args, stdin: stdin, cwd: cwd, extraEnv: extraEnv) }.value
    }

    private static func runBlocking(_ program: String, _ args: [String], stdin: String?,
                                    cwd: String?, extraEnv: [String: String]) -> CommandResult {
            guard let exe = which(program) else {
                return CommandResult(status: 127, stdout: "", stderr: "\(program): command not found")
            }
            let p = Process()
            p.executableURL = URL(fileURLWithPath: exe)
            p.arguments = args
            p.environment = environment.merging(extraEnv) { $1 }
            if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
            let out = Pipe(), err = Pipe(), inp = Pipe()
            p.standardOutput = out
            p.standardError = err
            p.standardInput = stdin == nil ? FileHandle.nullDevice : inp
            do { try p.run() } catch {
                return CommandResult(status: 126, stdout: "", stderr: error.localizedDescription)
            }
            if let stdin {
                inp.fileHandleForWriting.write(Data(stdin.utf8))
                try? inp.fileHandleForWriting.close()
            }
            // Drain both pipes concurrently so a chatty stderr can't block stdout.
            var outData = Data(), errData = Data()
            let group = DispatchGroup()
            group.enter()
            DispatchQueue.global().async { outData = out.fileHandleForReading.readDataToEndOfFile(); group.leave() }
            group.enter()
            DispatchQueue.global().async { errData = err.fileHandleForReading.readDataToEndOfFile(); group.leave() }
            group.wait()
            p.waitUntilExit()
            return CommandResult(status: p.terminationStatus,
                                 stdout: String(decoding: outData, as: UTF8.self),
                                 stderr: String(decoding: errData, as: UTF8.self))
    }

    /// Runs a shell command line, delivering merged stdout/stderr line by line.
    static func stream(_ commandLine: String, cwd: String? = nil, extraEnv: [String: String] = [:],
                       onLine: @escaping @Sendable (String) -> Void) async -> Int32 {
        await withCheckedContinuation { (cont: CheckedContinuation<Int32, Never>) in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/zsh")
            p.arguments = ["-c", commandLine]
            p.environment = environment.merging(extraEnv) { $1 }
            if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
            let pipe = Pipe()
            p.standardOutput = pipe
            p.standardError = pipe
            p.standardInput = FileHandle.nullDevice
            let buffer = LineBuffer(onLine: onLine)
            pipe.fileHandleForReading.readabilityHandler = { h in
                let data = h.availableData
                if data.isEmpty { h.readabilityHandler = nil } else { buffer.append(data) }
            }
            p.terminationHandler = { proc in
                pipe.fileHandleForReading.readabilityHandler = nil
                buffer.append(pipe.fileHandleForReading.readDataToEndOfFile())
                buffer.flush()
                cont.resume(returning: proc.terminationStatus)
            }
            do { try p.run() } catch {
                onLine("failed to start: \(error.localizedDescription)")
                cont.resume(returning: 126)
            }
        }
    }
}

/// Splits a byte stream into lines, tolerating chunks that end mid-line.
private final class LineBuffer: @unchecked Sendable {
    private var pending = Data()
    private let lock = NSLock()
    private let onLine: @Sendable (String) -> Void

    init(onLine: @escaping @Sendable (String) -> Void) { self.onLine = onLine }

    func append(_ data: Data) {
        lock.lock(); defer { lock.unlock() }
        pending.append(data)
        while let nl = pending.firstIndex(of: 0x0A) {
            let line = pending[pending.startIndex..<nl]
            pending.removeSubrange(pending.startIndex...nl)
            onLine(String(decoding: line, as: UTF8.self).replacingOccurrences(of: "\r", with: ""))
        }
    }

    func flush() {
        lock.lock(); defer { lock.unlock() }
        if !pending.isEmpty { onLine(String(decoding: pending, as: UTF8.self)); pending.removeAll() }
    }
}
