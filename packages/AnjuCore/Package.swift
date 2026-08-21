// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "AnjuCore",
    platforms: [
        .iOS(.v16),
        .macOS(.v13)
    ],
    products: [
        .library(name: "AnjuCore", targets: ["AnjuCore"])
    ],
    targets: [
        .target(name: "AnjuCore"),
        .testTarget(name: "AnjuCoreTests", dependencies: ["AnjuCore"])
    ]
)
