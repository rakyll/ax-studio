import SwiftUI

/// A status dot that breathes while something is live.
struct PulseDot: View {
    var color: Color
    var pulsing = true
    var size: CGFloat = 9
    @State private var on = false

    var body: some View {
        ZStack {
            if pulsing {
                Circle().fill(color.opacity(0.35))
                    .frame(width: size * 2.2, height: size * 2.2)
                    .scaleEffect(on ? 1 : 0.4)
                    .opacity(on ? 0 : 1)
            }
            Circle().fill(color).frame(width: size, height: size)
        }
        .frame(width: size * 2.2, height: size * 2.2)
        .onAppear {
            guard pulsing else { return }
            withAnimation(.easeOut(duration: 1.6).repeatForever(autoreverses: false)) { on = true }
        }
    }
}

/// Phase shown as icon + label + color, so state is never color alone.
struct PhaseBadge: View {
    var phase: Phase
    var compact = false

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: phase.icon)
                .symbolEffect(.pulse, options: .repeating, isActive: phase == .running || phase == .terminating)
            if !compact { Text(phase.label) }
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(phase.color)
        .padding(.horizontal, compact ? 4 : 7)
        .padding(.vertical, 3)
        .background(phase.color.opacity(0.13), in: Capsule())
    }
}

struct Chip: View {
    var text: String
    var icon: String
    var tint: Color = .secondary

    var body: some View {
        Label(text, systemImage: icon)
            .font(.caption)
            .lineLimit(1)
            .foregroundStyle(.primary.opacity(0.85))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 5))
    }
}

/// Card surface used across the app.
struct CardStyle: ViewModifier {
    var highlighted = false
    var tint: Color = .accentColor

    func body(content: Content) -> some View {
        content
            .background(.background, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(highlighted ? tint : Color.primary.opacity(0.08), lineWidth: highlighted ? 2 : 1))
            .shadow(color: .black.opacity(0.06), radius: 3, y: 1)
    }
}

extension View {
    func card(highlighted: Bool = false, tint: Color = .accentColor) -> some View {
        modifier(CardStyle(highlighted: highlighted, tint: tint))
    }
}

/// Header used at the top of each detail page.
struct PageHeader<Trailing: View>: View {
    var title: String
    var subtitle: String
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.largeTitle.weight(.bold))
                Text(subtitle).foregroundStyle(.secondary)
            }
            Spacer()
            trailing
        }
    }
}

extension PageHeader where Trailing == EmptyView {
    init(title: String, subtitle: String) {
        self.init(title: title, subtitle: subtitle) { EmptyView() }
    }
}

/// An empty state that explains what to do next.
struct EmptyHint: View {
    var icon: String
    var title: String
    var message: String
    var action: (String, () -> Void)?

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: icon).font(.system(size: 40, weight: .light)).foregroundStyle(.tertiary)
            Text(title).font(.title3.weight(.semibold))
            Text(message).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 380)
            if let action { Button(action.0, action: action.1).buttonStyle(.borderedProminent).padding(.top, 4) }
        }
        .padding(30)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Shortens an image reference to `name@sha256:abcdef0`.
func shortImage(_ image: String?) -> String? {
    guard let image, !image.isEmpty else { return nil }
    let last = image.split(separator: "/").last.map(String.init) ?? image
    if let at = last.range(of: "@sha256:") {
        return String(last[..<at.lowerBound]) + "@" + String(last[at.upperBound...].prefix(7))
    }
    return last
}
