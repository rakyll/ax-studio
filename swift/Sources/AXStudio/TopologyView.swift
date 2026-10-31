import SwiftUI

/// Left-to-right data flow: sources (git, MCP) → workspaces → tasks.
struct TopologyView: View {
    @Environment(Store.self) private var store
    @State private var hovered: String?
    @State private var zoom: CGFloat = 1

    var body: some View {
        @Bindable var store = store
        let layout = GraphLayout(store: store)
        VStack(alignment: .leading, spacing: 0) {
            PageHeader(title: "Topology", subtitle: "How sources feed workspaces and workspaces feed tasks. Running edges flow.") {
                HStack {
                    legend
                    Slider(value: $zoom, in: 0.5...1.5).frame(width: 120)
                }
            }
            .padding(24)

            if store.tasks.isEmpty && store.workspaces.isEmpty {
                EmptyHint(icon: "point.3.connected.trianglepath.dotted", title: "Nothing to draw yet",
                          message: "Apply a Workspace and a Task from the Designer and they'll appear here, wired together.")
            } else {
                ScrollView([.horizontal, .vertical]) {
                    ZStack(alignment: .topLeading) {
                        columnHeaders(layout)
                        EdgeLayer(edges: layout.edges, hovered: hovered)
                            .frame(width: layout.size.width, height: layout.size.height)
                        ForEach(layout.nodes) { node in
                            NodeView(node: node, dimmed: hovered != nil && !layout.isConnected(node.id, hovered!))
                                .position(node.center)
                                .onHover { hovered = $0 ? node.id : (hovered == node.id ? nil : hovered) }
                                .onTapGesture {
                                    if case .task(let t) = node.kind { withAnimation(.snappy) { store.selectedTaskID = t.id } }
                                }
                        }
                    }
                    .frame(width: layout.size.width, height: layout.size.height, alignment: .topLeading)
                    .scaleEffect(zoom, anchor: .topLeading)
                    .frame(width: layout.size.width * zoom, height: layout.size.height * zoom, alignment: .topLeading)
                    .padding(.horizontal, 24)
                    .animation(.snappy, value: layout.nodes.map(\.id))
                }
                .defaultScrollAnchor(.topLeading)
            }
        }
        .background(
            Canvas { ctx, size in
                // Dotted grid backdrop.
                let step: CGFloat = 22
                for x in stride(from: 0, to: size.width, by: step) {
                    for y in stride(from: 0, to: size.height, by: step) {
                        ctx.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 1.5, height: 1.5)), with: .color(.primary.opacity(0.08)))
                    }
                }
            }
        )
        .taskInspectorPanel()
    }

    private var legend: some View {
        HStack(spacing: 10) {
            ForEach([Phase.running, .pending, .suspended, .failed], id: \.self) { p in
                HStack(spacing: 4) {
                    Image(systemName: p.icon).foregroundStyle(p.color)
                    Text(p.label).foregroundStyle(.secondary)
                }
            }
        }
        .font(.caption)
    }

    private func columnHeaders(_ layout: GraphLayout) -> some View {
        let titles = ["SOURCES", "WORKSPACES", "TASKS"] + (store.models.isEmpty ? [] : ["MODELS"])
        return ForEach(Array(zip(titles, layout.columnX)), id: \.0) { title, x in
            Text(title).font(.caption2.weight(.bold)).foregroundStyle(.tertiary).tracking(1.5)
                .position(x: x, y: 12)
        }
    }
}

// MARK: - Layout

struct GraphNode: Identifiable {
    enum Kind {
        case repo(GitRepo), mcp(String), workspace(AXWorkspace?), task(AXTask), model(AXModel)
    }
    var id: String
    var kind: Kind
    var center: CGPoint
    static let size = CGSize(width: 210, height: 58)
}

struct GraphEdge: Identifiable {
    var from: CGPoint
    var to: CGPoint
    var fromID: String
    var toID: String
    var color: Color
    var flowing: Bool
    var id: String { "\(fromID)->\(toID)" }
}

struct GraphLayout {
    var nodes: [GraphNode] = []
    var edges: [GraphEdge] = []
    var size: CGSize = .zero
    let columnX: [CGFloat] = [130, 420, 720, 1010]

    private static let rowH: CGFloat = 76
    private static let groupGap: CGFloat = 26
    private static let top: CGFloat = 40

    @MainActor
    init(store: Store) {
        var y = Self.top
        var groups: [(ws: AXWorkspace?, tasks: [AXTask])] = store.workspaces.map { ws in (ws, store.tasks(using: ws.name)) }
        let unbound = store.tasks.filter { t in
            guard let w = store.details[t.id]?.workspace else { return true }
            return !store.workspaces.contains { $0.name == w }
        }
        if !unbound.isEmpty { groups.append((nil, unbound)) }

        for g in groups {
            let sources: [GraphNode.Kind] = (g.ws?.repos.map { .repo($0) } ?? []) + (g.ws?.mcpServers.map { .mcp($0) } ?? [])
            let rows = max(sources.count, g.tasks.count, 1)
            let height = CGFloat(rows) * Self.rowH
            let wsID = "ws:\(g.ws?.name ?? "-")"
            let wsCenter = CGPoint(x: columnX[1], y: y + height / 2)
            nodes.append(GraphNode(id: wsID, kind: .workspace(g.ws), center: wsCenter))

            func stackY(_ i: Int, _ n: Int) -> CGFloat { y + height / 2 + (CGFloat(i) - CGFloat(n - 1) / 2) * Self.rowH }

            for (i, s) in sources.enumerated() {
                let id: String
                switch s {
                case .repo(let r): id = "repo:\(wsID):\(r.name):\(r.repo)"
                case .mcp(let m): id = "mcp:\(wsID):\(m)"
                default: id = UUID().uuidString
                }
                let c = CGPoint(x: columnX[0], y: stackY(i, sources.count))
                nodes.append(GraphNode(id: id, kind: s, center: c))
                edges.append(GraphEdge(from: right(c), to: left(wsCenter), fromID: id, toID: wsID, color: .purple.opacity(0.55), flowing: false))
            }
            for (i, t) in g.tasks.enumerated() {
                let id = "task:\(t.id)"
                let c = CGPoint(x: columnX[2], y: stackY(i, g.tasks.count))
                nodes.append(GraphNode(id: id, kind: .task(t), center: c))
                edges.append(GraphEdge(from: right(wsCenter), to: left(c), fromID: wsID, toID: id, color: t.phase.color, flowing: t.phase == .running))
            }
            y += height + Self.groupGap
        }

        var my = Self.top + GraphNode.size.height / 2
        for m in store.models {
            nodes.append(GraphNode(id: "model:\(m.id)", kind: .model(m), center: CGPoint(x: columnX[3], y: my)))
            my += Self.rowH
        }
        size = CGSize(width: columnX[3] + GraphNode.size.width / 2 + 20, height: max(y, my) + 20)
    }

    private func left(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x - GraphNode.size.width / 2, y: p.y) }
    private func right(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x + GraphNode.size.width / 2, y: p.y) }

    /// Whether `a` and `b` are the same node or share an edge, possibly via a workspace.
    func isConnected(_ a: String, _ b: String) -> Bool {
        if a == b { return true }
        let neighbors = { (n: String) in Set(edges.filter { $0.fromID == n || $0.toID == n }.flatMap { [$0.fromID, $0.toID] }) }
        let na = neighbors(b)
        if na.contains(a) { return true }
        return na.contains { $0.hasPrefix("ws:") && neighbors($0).contains(a) }
    }
}

// MARK: - Drawing

struct EdgeLayer: View {
    var edges: [GraphEdge]
    var hovered: String?

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: !edges.contains(where: \.flowing))) { tl in
            Canvas { ctx, _ in
                let t = tl.date.timeIntervalSinceReferenceDate
                for e in edges {
                    let active = hovered == nil || hovered == e.fromID || hovered == e.toID
                    let path = curve(e.from, e.to)
                    ctx.stroke(path, with: .color(e.color.opacity(active ? 0.9 : 0.15)), lineWidth: active && hovered != nil ? 3 : 2)
                    if e.flowing && active {
                        // Pulses travel along the edge while the task runs.
                        for k in 0..<3 {
                            let f = (t * 0.45 + Double(k) / 3).truncatingRemainder(dividingBy: 1)
                            let p = point(on: e.from, e.to, CGFloat(f))
                            ctx.fill(Path(ellipseIn: CGRect(x: p.x - 4, y: p.y - 4, width: 8, height: 8)), with: .color(e.color))
                        }
                    }
                }
            }
        }
        .allowsHitTesting(false)
    }

    private func controls(_ a: CGPoint, _ b: CGPoint) -> (CGPoint, CGPoint) {
        let dx = max(40, (b.x - a.x) * 0.5)
        return (CGPoint(x: a.x + dx, y: a.y), CGPoint(x: b.x - dx, y: b.y))
    }

    private func curve(_ a: CGPoint, _ b: CGPoint) -> Path {
        let (c1, c2) = controls(a, b)
        var p = Path()
        p.move(to: a)
        p.addCurve(to: b, control1: c1, control2: c2)
        return p
    }

    private func point(on a: CGPoint, _ b: CGPoint, _ t: CGFloat) -> CGPoint {
        let (c1, c2) = controls(a, b)
        let u = 1 - t
        let x = u*u*u*a.x + 3*u*u*t*c1.x + 3*u*t*t*c2.x + t*t*t*b.x
        let y = u*u*u*a.y + 3*u*u*t*c1.y + 3*u*t*t*c2.y + t*t*t*b.y
        return CGPoint(x: x, y: y)
    }
}

struct NodeView: View {
    @Environment(Store.self) private var store
    var node: GraphNode
    var dimmed: Bool

    var body: some View {
        HStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 8).fill(tint.opacity(0.15))
                Image(systemName: icon).foregroundStyle(tint).font(.system(size: 15, weight: .semibold))
            }
            .frame(width: 34, height: 34)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.callout.weight(.semibold)).lineLimit(1)
                Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 0)
            if case .task(let t) = node.kind {
                if t.phase == .running { PulseDot(color: t.phase.color, size: 7) }
                else { Image(systemName: t.phase.icon).foregroundStyle(t.phase.color) }
            }
        }
        .padding(.horizontal, 10)
        .frame(width: GraphNode.size.width, height: GraphNode.size.height)
        .card(highlighted: selected, tint: tint)
        .opacity(dimmed ? 0.35 : 1)
        .animation(.easeOut(duration: 0.15), value: dimmed)
        .help(help)
    }

    private var selected: Bool {
        if case .task(let t) = node.kind { return store.selectedTaskID == t.id }
        return false
    }

    private var icon: String {
        switch node.kind {
        case .repo: "arrow.triangle.branch"
        case .mcp: "powerplug.fill"
        case .workspace(let ws): ws == nil ? "folder.badge.questionmark" : "folder.fill"
        case .task: "shippingbox.fill"
        case .model: "cpu"
        }
    }

    private var tint: Color {
        switch node.kind {
        case .repo: .orange
        case .mcp: .pink
        case .workspace(let ws): ws == nil ? .gray : .purple
        case .task(let t): t.phase.color
        case .model: .teal
        }
    }

    private var title: String {
        switch node.kind {
        case .repo(let r): r.repo.split(separator: "/").last.map { String($0).replacingOccurrences(of: ".git", with: "") } ?? r.name
        case .mcp(let m): m
        case .workspace(let ws): ws?.name ?? "empty /workspace"
        case .task(let t): t.name
        case .model(let m): m.name
        }
    }

    private var subtitle: String {
        switch node.kind {
        case .repo(let r): "\(r.branch) · \(r.name)"
        case .mcp: "MCP server"
        case .workspace(let ws): ws.map { "\($0.gitCount) repo\($0.gitCount == 1 ? "" : "s") · \($0.mcpCount) MCP" } ?? "tasks without a workspace"
        case .task(let t): "\(t.phase.label) · \(t.age)"
        case .model(let m): "\(m.provider) · \(m.model)"
        }
    }

    private var help: String {
        switch node.kind {
        case .repo(let r): r.repo
        case .task(let t): "\(t.name) — click for details"
        default: title
        }
    }
}
