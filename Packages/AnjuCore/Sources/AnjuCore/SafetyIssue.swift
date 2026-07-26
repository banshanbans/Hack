import Foundation

public enum IssueState: String, Codable, Sendable {
    case tentative
    case confirmed
    case dismissed
    case resolved
}

public enum Severity: String, Codable, CaseIterable, Sendable {
    case high
    case medium
    case check

    public var sortOrder: Int {
        switch self {
        case .high: 0
        case .medium: 1
        case .check: 2
        }
    }
}

public enum IssueSource: String, Codable, Sendable {
    case roomPlan
    case localVision
    case remoteVision
    case fused
    case user
}

public enum MeasurementStatus: String, Codable, Sendable {
    case unavailable
    case visualEstimate
    case lidarMeasured
    case userMeasured
}

public enum SafetyIssueType: String, Codable, CaseIterable, Sendable {
    case looseRug = "loose_rug"
    case floorClutter = "floor_clutter"
    case cableCrossing = "cable_crossing"
    case narrowPath = "narrow_path"
    case missingGrabBar = "missing_grab_bar"
    case sharpCorner = "sharp_corner"
    case lowLighting = "low_lighting"
    case unstableSupport = "unstable_support"
    case highReachItem = "high_reach_item"
    case bedsideObstruction = "bedside_obstruction"
    case wetFloor = "wet_floor"
    case levelChange = "level_change"
    case crowdedPath = "crowded_path"
    case markedExitObstruction = "marked_exit_obstruction"
    case lowHangingObstruction = "low_hanging_obstruction"
}

public struct NormalizedBoundingBox: Codable, Equatable, Sendable {
    public let xMin: Double
    public let yMin: Double
    public let xMax: Double
    public let yMax: Double

    public init?(xMin: Double, yMin: Double, xMax: Double, yMax: Double) {
        guard (0...1).contains(xMin), (0...1).contains(yMin),
              (0...1).contains(xMax), (0...1).contains(yMax),
              xMin < xMax, yMin < yMax else { return nil }
        self.xMin = xMin
        self.yMin = yMin
        self.xMax = xMax
        self.yMax = yMax
    }

    public init?(array: [Double]) {
        guard array.count == 4 else { return nil }
        self.init(xMin: array[0], yMin: array[1], xMax: array[2], yMax: array[3])
    }

    public var array: [Double] { [xMin, yMin, xMax, yMax] }
}

public struct WorldPoint: Codable, Equatable, Sendable {
    public let x: Float
    public let y: Float
    public let z: Float

    public init(x: Float, y: Float, z: Float) {
        self.x = x
        self.y = y
        self.z = z
    }

    public func distance(to other: WorldPoint) -> Float {
        let dx = x - other.x
        let dy = y - other.y
        let dz = z - other.z
        return (dx * dx + dy * dy + dz * dz).squareRoot()
    }
}

public struct Matrix4x4Codable: Codable, Equatable, Sendable {
    /// Column-major values, matching ARKit's simd_float4x4 memory layout.
    public let values: [Float]

    public init?(values: [Float]) {
        guard values.count == 16, values.allSatisfy(\.isFinite) else { return nil }
        self.values = values
    }
}

public struct CameraMotionGate: Sendable {
    public let minimumTranslation: Float
    public let minimumRotationRadians: Float

    public init(minimumTranslation: Float = 0.15, minimumRotationRadians: Float = 0.14) {
        self.minimumTranslation = minimumTranslation
        self.minimumRotationRadians = minimumRotationRadians
    }

    public func hasMeaningfulChange(previous: Matrix4x4Codable?, current: Matrix4x4Codable) -> Bool {
        guard let previous else { return true }
        let p = previous.values, c = current.values
        let dx = c[12] - p[12], dy = c[13] - p[13], dz = c[14] - p[14]
        let translation = (dx * dx + dy * dy + dz * dz).squareRoot()
        let previousForward = SIMD3<Float>(p[8], p[9], p[10])
        let currentForward = SIMD3<Float>(c[8], c[9], c[10])
        let denominator = max(0.0001, length(previousForward) * length(currentForward))
        let cosine = max(-1, min(1, dot(previousForward, currentForward) / denominator))
        return translation >= minimumTranslation || acos(cosine) >= minimumRotationRadians
    }

    private func length(_ value: SIMD3<Float>) -> Float {
        (value.x * value.x + value.y * value.y + value.z * value.z).squareRoot()
    }

    private func dot(_ left: SIMD3<Float>, _ right: SIMD3<Float>) -> Float {
        left.x * right.x + left.y * right.y + left.z * right.z
    }
}

public struct IssueEvidence: Codable, Equatable, Sendable {
    public var frameID: UUID?
    public var boundingBox: NormalizedBoundingBox?
    public var roomObjectID: UUID?
    public var roomSurfaceID: UUID?
    public var snapshotFilename: String?
    public var zoneID: String?
    public var worldPoint: WorldPoint?
    public var measurementStatus: MeasurementStatus

    public init(
        frameID: UUID? = nil,
        boundingBox: NormalizedBoundingBox? = nil,
        roomObjectID: UUID? = nil,
        roomSurfaceID: UUID? = nil,
        snapshotFilename: String? = nil,
        zoneID: String? = nil,
        worldPoint: WorldPoint? = nil,
        measurementStatus: MeasurementStatus = .unavailable
    ) {
        self.frameID = frameID
        self.boundingBox = boundingBox
        self.roomObjectID = roomObjectID
        self.roomSurfaceID = roomSurfaceID
        self.snapshotFilename = snapshotFilename
        self.zoneID = zoneID
        self.worldPoint = worldPoint
        self.measurementStatus = measurementStatus
    }

    public var hasTraceableEvidence: Bool {
        boundingBox != nil || roomObjectID != nil || roomSurfaceID != nil ||
        snapshotFilename != nil || worldPoint != nil
    }
}

public struct SafetyIssue: Identifiable, Codable, Equatable, Sendable {
    public let id: UUID
    public let sessionID: UUID
    public let type: SafetyIssueType
    public var state: IssueState
    public var severity: Severity
    public var title: String
    public var observation: String
    public var recommendation: String
    public var needsManualCheck: Bool
    public var source: IssueSource
    public var evidence: IssueEvidence
    public var worldTransform: Matrix4x4Codable?
    public var confidence: Float?
    public let createdAt: Date
    public var updatedAt: Date

    public init(
        id: UUID = UUID(),
        sessionID: UUID,
        type: SafetyIssueType,
        state: IssueState,
        severity: Severity,
        title: String,
        observation: String,
        recommendation: String,
        needsManualCheck: Bool,
        source: IssueSource,
        evidence: IssueEvidence,
        worldTransform: Matrix4x4Codable? = nil,
        confidence: Float? = nil,
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.sessionID = sessionID
        self.type = type
        self.state = state
        self.severity = severity
        self.title = title
        self.observation = observation
        self.recommendation = recommendation
        self.needsManualCheck = needsManualCheck
        self.source = source
        self.evidence = evidence
        self.worldTransform = worldTransform
        self.confidence = confidence
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}
