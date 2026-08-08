import Foundation

public struct NativeRepresentativeCandidate: Equatable, Sendable {
    public let id: String
    public let perceptualHash: UInt64?
    public let pinned: Bool
    public let confidence: Double
    public let brightness: Double
    public let sharpness: Double

    public init(
        id: String,
        perceptualHash: UInt64?,
        pinned: Bool,
        confidence: Double,
        brightness: Double,
        sharpness: Double
    ) {
        self.id = id
        self.perceptualHash = perceptualHash
        self.pinned = pinned
        self.confidence = confidence
        self.brightness = brightness
        self.sharpness = sharpness
    }
}

public enum NativeRealtimeVideoPolicy {
    public static let targetFramesPerSecond = 15.0
    public static let degradedFramesPerSecond = 10.0
    public static let normalLongEdge = 720
    public static let weakNetworkLongEdge = 540
    public static let normalMaximumBitrateKbps = 900
    public static let degradedMaximumBitrateKbps = 500
    public static let maximumCachedFrames = 8
    public static let maximumCacheBytes = 24 * 1024 * 1024
    public static let maximumRepresentativeFrames = 6

    public static func permitsVideoFrame(
        previousTimestamp: TimeInterval,
        timestamp: TimeInterval,
        profile: NativeRTCVideoProfile = .normal
    ) -> Bool {
        timestamp - previousTimestamp >= 1.0 / profile.framesPerSecond
    }

    public static func encoderLongEdge(uplinkQualityRawValue: Int) -> Int {
        uplinkQualityRawValue >= 4 ? weakNetworkLongEdge : normalLongEdge
    }

    public static func selectRepresentativeIDs(
        _ candidates: [NativeRepresentativeCandidate],
        limit: Int
    ) -> [String] {
        let boundedLimit = max(0, min(maximumRepresentativeFrames, limit))
        guard boundedLimit > 0 else { return [] }
        let ranked = candidates.sorted { left, right in
            if left.pinned != right.pinned { return left.pinned && !right.pinned }
            if left.confidence != right.confidence { return left.confidence > right.confidence }
            let leftScore = left.sharpness - abs(left.brightness - 128) / 12
            let rightScore = right.sharpness - abs(right.brightness - 128) / 12
            return leftScore > rightScore
        }
        var selected: [NativeRepresentativeCandidate] = []
        for candidate in ranked {
            if let hash = candidate.perceptualHash,
               selected.contains(where: { other in
                   guard let otherHash = other.perceptualHash else { return false }
                   return (hash ^ otherHash).nonzeroBitCount < 4
               }) {
                continue
            }
            selected.append(candidate)
            if selected.count == boundedLimit { break }
        }
        return selected.map(\.id)
    }
}

public enum NativeRTCVideoProfile: String, Equatable, Sendable {
    case normal
    case degraded

    public var longEdge: Int {
        self == .normal ? NativeRealtimeVideoPolicy.normalLongEdge : NativeRealtimeVideoPolicy.weakNetworkLongEdge
    }

    public var framesPerSecond: Double {
        self == .normal
            ? NativeRealtimeVideoPolicy.targetFramesPerSecond
            : NativeRealtimeVideoPolicy.degradedFramesPerSecond
    }

    public var maximumBitrateKbps: Int {
        self == .normal
            ? NativeRealtimeVideoPolicy.normalMaximumBitrateKbps
            : NativeRealtimeVideoPolicy.degradedMaximumBitrateKbps
    }
}

public enum NativeRTCThermalLevel: Int, Comparable, Sendable {
    case nominal = 0
    case fair = 1
    case serious = 2
    case critical = 3

    public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

public enum NativeRTCVideoDegradeReason: String, Hashable, Sendable {
    case network
    case thermal
    case arFrameRate = "ar_frame_rate"
}

public struct NativeRTCVideoTransition: Equatable, Sendable {
    public let profile: NativeRTCVideoProfile
    public let reasons: Set<NativeRTCVideoDegradeReason>
}

/// Deterministic hysteresis for RTC video. A single bad signal degrades immediately;
/// all three signals must be healthy before returning to the normal profile.
public struct NativeRTCVideoAdaptiveState: Sendable {
    public private(set) var profile: NativeRTCVideoProfile = .normal
    public private(set) var uplinkQuality = 0
    public private(set) var thermalLevel: NativeRTCThermalLevel = .nominal
    public private(set) var arFrameRateDegraded = false

    private var consecutiveLowARWindows = 0
    private var arHealthySince: TimeInterval?

    public init() {}

    public mutating func updateNetwork(
        quality: Int,
        timestamp: TimeInterval
    ) -> NativeRTCVideoTransition? {
        uplinkQuality = quality
        return reevaluate(timestamp: timestamp)
    }

    public mutating func updateThermal(
        level: NativeRTCThermalLevel,
        timestamp: TimeInterval
    ) -> NativeRTCVideoTransition? {
        thermalLevel = level
        return reevaluate(timestamp: timestamp)
    }

    public mutating func updateARFrameRate(
        average: Double,
        timestamp: TimeInterval
    ) -> NativeRTCVideoTransition? {
        if average < 24 {
            consecutiveLowARWindows += 1
            arHealthySince = nil
            if consecutiveLowARWindows >= 2 { arFrameRateDegraded = true }
        } else if average >= 27 {
            consecutiveLowARWindows = 0
            if arHealthySince == nil { arHealthySince = timestamp }
            if let healthySince = arHealthySince, timestamp - healthySince >= 10 {
                arFrameRateDegraded = false
            }
        } else {
            consecutiveLowARWindows = 0
            arHealthySince = nil
        }
        return reevaluate(timestamp: timestamp)
    }

    public var currentReasons: Set<NativeRTCVideoDegradeReason> {
        var reasons: Set<NativeRTCVideoDegradeReason> = []
        if uplinkQuality >= 4 { reasons.insert(.network) }
        if thermalLevel >= .serious { reasons.insert(.thermal) }
        if arFrameRateDegraded { reasons.insert(.arFrameRate) }
        return reasons
    }

    private mutating func reevaluate(timestamp: TimeInterval) -> NativeRTCVideoTransition? {
        let reasons = currentReasons
        if profile == .normal, !reasons.isEmpty {
            profile = .degraded
            return .init(profile: profile, reasons: reasons)
        }
        let arHealthyForTenSeconds = arHealthySince.map { timestamp - $0 >= 10 } ?? false
        if profile == .degraded,
           uplinkQuality <= 2,
           thermalLevel <= .fair,
           !arFrameRateDegraded,
           arHealthyForTenSeconds {
            profile = .normal
            return .init(profile: profile, reasons: [])
        }
        return nil
    }
}

public struct NativeARFrameRateWindow: Equatable, Sendable {
    public let average: Double
    public let minimum: Double
}

public struct NativeARFrameRateMonitor: Sendable {
    private var windowStart: TimeInterval?
    private var previousTimestamp: TimeInterval?
    private var frameCount = 0
    private var minimum = Double.greatestFiniteMagnitude

    public init() {}

    public mutating func record(timestamp: TimeInterval) -> NativeARFrameRateWindow? {
        if windowStart == nil { windowStart = timestamp }
        if let previousTimestamp, timestamp > previousTimestamp {
            minimum = min(minimum, 1 / (timestamp - previousTimestamp))
        }
        previousTimestamp = timestamp
        frameCount += 1
        guard let start = windowStart, timestamp - start >= 3 else { return nil }
        let duration = max(0.001, timestamp - start)
        let result = NativeARFrameRateWindow(
            average: Double(max(0, frameCount - 1)) / duration,
            minimum: minimum.isFinite ? minimum : 0
        )
        windowStart = timestamp
        frameCount = 1
        minimum = .greatestFiniteMagnitude
        return result
    }
}
