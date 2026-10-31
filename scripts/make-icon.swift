// Renders an .icns app icon from an SVG logo: the logo on a rounded gradient tile.
//   swift scripts/make-icon.swift <logo.svg> <out.icns>   (also writes a 1024px <out>.png for Windows/Linux)
import AppKit

let args = CommandLine.arguments
guard args.count == 3, let logo = NSImage(contentsOfFile: args[1]) else {
    FileHandle.standardError.write("usage: make-icon <logo.svg> <out.icns>\n".data(using: .utf8)!)
    exit(1)
}

func render(_ px: Int) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(px)
    // macOS icon grid: the tile is ~80% of the canvas.
    let tile = NSRect(x: s * 0.1, y: s * 0.1, width: s * 0.8, height: s * 0.8)
    let path = NSBezierPath(roundedRect: tile, xRadius: s * 0.18, yRadius: s * 0.18)
    NSGradient(starting: NSColor(red: 1.0, green: 0.86, blue: 0.90, alpha: 1),
               ending: NSColor(red: 0.98, green: 0.62, blue: 0.72, alpha: 1))!.draw(in: path, angle: -90)
    let inset = tile.insetBy(dx: s * 0.09, dy: s * 0.09)
    let aspect = logo.size.width / logo.size.height
    var r = inset
    if aspect < 1 { r.size.width = inset.height * aspect; r.origin.x = inset.midX - r.width / 2 }
    else { r.size.height = inset.width / aspect; r.origin.y = inset.midY - r.height / 2 }
    logo.draw(in: r)
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let iconset = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("AppIcon.iconset")
try? FileManager.default.removeItem(at: iconset)
try! FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
    try! render(base).write(to: iconset.appendingPathComponent("icon_\(base)x\(base).png"))
    try! render(base * 2).write(to: iconset.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}
let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
p.arguments = ["-c", "icns", iconset.path, "-o", args[2]]
try! render(1024).write(to: URL(fileURLWithPath: args[2]).deletingPathExtension().appendingPathExtension("png"))
try! p.run()
p.waitUntilExit()
exit(p.terminationStatus)
