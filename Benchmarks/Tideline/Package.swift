// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Tideline",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [.library(name: "Tideline", targets: ["Tideline"])],
    targets: [
        .target(name: "Tideline"),
        .testTarget(name: "TidelineTests", dependencies: ["Tideline"]),
    ]
)
