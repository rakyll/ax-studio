import SwiftUI
import Charts

struct OverviewView: View {
    @Environment(Store.self) private var store
    @Binding var section: Section?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                PageHeader(title: "Overview", subtitle: subtitle)

                if let err = store.connectionError, store.tasks.isEmpty {
                    ConnectionProblem(message: err) { section = .deploy }
                }

                tiles
                HStack(alignment: .top, spacing: 16) {
                    VStack(spacing: 16) {
                        PhaseDistribution()
                        TasksOverTime()
                    }
                    .frame(maxWidth: .infinity)
                    VStack(spacing: 16) {
                        ResourceList()
                        ActivityFeed()
                    }
                    .frame(width: 340)
                }
            }
            .padding(24)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var subtitle: String {
        let ctx = store.currentContext.map { $0.isLocal ? "local control plane" : $0.shortName } ?? "…"
        return "\(ctx) · atespace \(store.atespace)"
    }

    private var tiles: some View {
        HStack(spacing: 12) {
            StatTile(title: "Tasks", value: store.tasks.count, icon: "square.stack.3d.up", tint: .accentColor) { section = .board }
            ForEach([Phase.running, .suspended, .failed], id: \.self) { p in
                StatTile(title: p.label, value: store.tasks(in: p).count, icon: p.icon, tint: p.color) { section = .board }
            }
            StatTile(title: "Workspaces", value: store.workspaces.count, icon: "folder.badge.gearshape", tint: .purple) { section = .topology }
            StatTile(title: "Models", value: store.models.count, icon: "cpu", tint: .teal) { section = .topology }
        }
    }
}

struct StatTile: View {
    var title: String
    var value: Int
    var icon: String
    var tint: Color
    var action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Image(systemName: icon).foregroundStyle(tint)
                    Text(title).foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.8)
                    Spacer(minLength: 0)
                }
                .font(.callout.weight(.medium))
                Text("\(value)")
                    .font(.system(size: 34, weight: .bold, design: .rounded).monospacedDigit())
                    .contentTransition(.numericText(value: Double(value)))
                    .animation(.snappy, value: value)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .card(highlighted: hover, tint: tint)
            .scaleEffect(hover ? 1.02 : 1)
            .animation(.snappy(duration: 0.15), value: hover)
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

/// One stacked bar: how the current tasks split across phases.
struct PhaseDistribution: View {
    @Environment(Store.self) private var store

    private var segments: [(phase: Phase, count: Int)] {
        Phase.columns.map { ($0, store.tasks(in: $0).count) }.filter { $0.count > 0 }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Phase distribution").font(.headline)
            if segments.isEmpty {
                Text("No tasks in this atespace yet.").foregroundStyle(.secondary).frame(height: 56)
            } else {
                // Segments with a 2px surface gap; hover shows the exact count.
                GeometryReader { geo in
                    let total = CGFloat(segments.reduce(0) { $0 + $1.count })
                    let gaps = CGFloat(segments.count - 1) * 2
                    HStack(spacing: 2) {
                        ForEach(segments, id: \.phase) { s in
                            RoundedRectangle(cornerRadius: 4)
                                .fill(s.phase.color)
                                .frame(width: max(4, (geo.size.width - gaps) * CGFloat(s.count) / total))
                                .overlay { Text("\(s.count)").font(.caption.bold()).foregroundStyle(.white) }
                                .help("\(s.phase.label): \(s.count)")
                        }
                    }
                }
                .frame(height: 30)
                .animation(.snappy, value: segments.map(\.count))

                HStack(spacing: 14) {
                    ForEach(segments, id: \.phase) { s in
                        HStack(spacing: 5) {
                            Image(systemName: s.phase.icon).foregroundStyle(s.phase.color)
                            Text(s.phase.label).foregroundStyle(.secondary)
                            Text("\(s.count)").monospacedDigit()
                        }
                        .font(.caption)
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }
}

/// Phase counts sampled at each refresh this session.
struct TasksOverTime: View {
    @Environment(Store.self) private var store
    @State private var hoverDate: Date?

    private struct Point: Identifiable {
        var date: Date
        var phase: Phase
        var count: Int
        var id: String { "\(date.timeIntervalSince1970)-\(phase.label)" }
    }

    private var points: [Point] {
        store.history.flatMap { s in Phase.columns.map { Point(date: s.date, phase: $0, count: s.counts[$0] ?? 0) } }
    }

    private var phasesSeen: [Phase] {
        Phase.columns.filter { p in store.history.contains { ($0.counts[p] ?? 0) > 0 } }
    }

    private var hovered: PhaseSample? {
        guard let hoverDate else { return nil }
        return store.history.min { abs($0.date.timeIntervalSince(hoverDate)) < abs($1.date.timeIntervalSince(hoverDate)) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Tasks over time").font(.headline)
                Spacer()
                Text("this session").font(.caption).foregroundStyle(.secondary)
            }
            if store.history.count < 2 {
                Text("Collecting samples…").foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 180)
            } else {
                Chart {
                    ForEach(points.filter { phasesSeen.contains($0.phase) }) { p in
                        AreaMark(x: .value("Time", p.date), y: .value("Tasks", p.count), stacking: .standard)
                            .foregroundStyle(by: .value("Phase", p.phase.label))
                            .interpolationMethod(.monotone)
                    }
                    if let h = hovered {
                        RuleMark(x: .value("Time", h.date))
                            .foregroundStyle(.secondary.opacity(0.6))
                            .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                            .annotation(position: .top, overflowResolution: .init(x: .fit, y: .disabled)) {
                                tooltip(h)
                            }
                    }
                }
                .chartForegroundStyleScale(domain: phasesSeen.map(\.label), range: phasesSeen.map(\.color))
                .chartXSelection(value: $hoverDate)
                .chartYAxis { AxisMarks(position: .leading) { _ in AxisGridLine().foregroundStyle(.quaternary); AxisValueLabel() } }
                .chartLegend(position: .bottom, alignment: .leading)
                .frame(height: 200)
            }
        }
        .padding(16)
        .card()
    }

    private func tooltip(_ s: PhaseSample) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(s.date.formatted(date: .omitted, time: .standard)).font(.caption2).foregroundStyle(.secondary)
            ForEach(phasesSeen, id: \.self) { p in
                HStack(spacing: 5) {
                    Circle().fill(p.color).frame(width: 7, height: 7)
                    Text(p.label)
                    Spacer(minLength: 10)
                    Text("\(s.counts[p] ?? 0)").monospacedDigit()
                }
                .font(.caption)
            }
        }
        .padding(8)
        .frame(width: 150)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
    }
}

struct ResourceList: View {
    @Environment(Store.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Resources").font(.headline)
            if store.workspaces.isEmpty && store.models.isEmpty {
                Text("No workspaces or models.").font(.callout).foregroundStyle(.secondary)
            }
            ForEach(store.workspaces) { ws in
                HStack {
                    Image(systemName: "folder.fill").foregroundStyle(.purple)
                    Text(ws.name).lineLimit(1)
                    Spacer()
                    Chip(text: "\(ws.gitCount)", icon: "arrow.triangle.branch")
                    Chip(text: "\(store.tasks(using: ws.name).count)", icon: "square.stack.3d.up")
                }
                .font(.callout)
            }
            ForEach(store.models) { m in
                HStack {
                    Image(systemName: "cpu").foregroundStyle(.teal)
                    Text(m.name).lineLimit(1)
                    Spacer()
                    Text("\(m.provider) · \(m.model)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                .font(.callout)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }
}

struct ActivityFeed: View {
    @Environment(Store.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Activity").font(.headline)
            if store.activity.isEmpty {
                Text("Actions you take here show up in this feed.").font(.callout).foregroundStyle(.secondary)
            }
            ForEach(store.activity.prefix(12)) { e in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: e.ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                        .foregroundStyle(e.ok ? Color(hex: 0x0CA30C) : Color(hex: 0xD03B3B))
                    VStack(alignment: .leading, spacing: 1) {
                        Text(e.title).font(.callout.weight(.medium))
                        if !e.detail.isEmpty {
                            Text(e.detail).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                        }
                    }
                    Spacer()
                    Text(e.date, style: .relative).font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }
}

struct ConnectionProblem: View {
    var message: String
    var openDeploy: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "bolt.horizontal.circle").font(.title).foregroundStyle(Color(hex: 0xD03B3B))
            VStack(alignment: .leading, spacing: 2) {
                Text("Can't reach the AX control plane").font(.headline)
                Text(message).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
            }
            Spacer()
            Button("Open Deploy", action: openDeploy)
        }
        .padding(14)
        .card(highlighted: true, tint: Color(hex: 0xD03B3B))
    }
}
