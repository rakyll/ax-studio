// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "AXStudio",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(
            name: "AXStudio",
            path: "Sources/AXStudio",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
