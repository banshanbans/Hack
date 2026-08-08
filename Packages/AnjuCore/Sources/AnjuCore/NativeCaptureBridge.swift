import Foundation

public struct NativeAdvisorEventConfig: Codable, Sendable {
    public let websocketPath: String
    public let token: String
    public let expiresAt: String

    public enum CodingKeys: String, CodingKey {
        case token
        case websocketPath = "websocket_path"
        case expiresAt = "expires_at"
    }

    public var isValid: Bool {
        websocketPath.hasPrefix("/api/v2/assessments/")
            && websocketPath.contains("/advisor/sessions/")
            && !websocketPath.contains("access_token")
            && !token.isEmpty
            && token.count <= 512
            && ISO8601DateFormatter().date(from: expiresAt) != nil
    }
}

public enum NativeAdvisorLeaseRecoveryEvent: Equatable, Sendable {
    case enteredBackground
    case leaseStillValid
    case leaseExpired
    case capacityUnavailable
    case finished
}

public enum NativeAdvisorLeaseRecoveryAction: Equatable, Sendable {
    case pauseRealtime
    case resumeRealtime
    case requeue
    case useHTTPFallback
    case cancelLease
}

public enum NativeAdvisorLeaseRecoveryPolicy {
    public static let heartbeatIntervalSeconds: UInt64 = 20
    public static let recoveryTimeoutSeconds: TimeInterval = 30
    public static let retryDelaysSeconds: [UInt64] = [1, 2, 4, 8]

    public static func action(for event: NativeAdvisorLeaseRecoveryEvent) -> NativeAdvisorLeaseRecoveryAction {
        switch event {
        case .enteredBackground:
            return .pauseRealtime
        case .leaseStillValid:
            return .resumeRealtime
        case .leaseExpired:
            return .requeue
        case .capacityUnavailable:
            return .useHTTPFallback
        case .finished:
            return .cancelLease
        }
    }

    public static func retryDelaySeconds(attempt: Int) -> UInt64 {
        retryDelaysSeconds[min(max(0, attempt), retryDelaysSeconds.count - 1)]
    }
}

public enum NativeBridgeCommand: String, Codable, Sendable {
    case capturePhoto = "capture_photo"
    case startLiveScan = "start_live_scan"
    case cancelNativeCapture = "cancel_native_capture"
}

public struct NativeCaptureRequest: Codable, Sendable {
    public let bridgeVersion: Int
    public let command: NativeBridgeCommand
    public let requestID: String
    public let assessmentID: String
    public let accessToken: String
    public let roomID: String
    public let roomType: String
    public let remainingSlots: Int
    public let cameraSessionID: String?
    public let advisorSessionID: String?
    public let advisorEvents: NativeAdvisorEventConfig?
    public let advisorClientInstanceID: String?
    public let advisorQueueTicketID: String?

    public enum CodingKeys: String, CodingKey {
        case command
        case bridgeVersion = "bridge_version"
        case requestID = "request_id"
        case assessmentID = "assessment_id"
        case accessToken = "access_token"
        case roomID = "room_id"
        case roomType = "room_type"
        case remainingSlots = "remaining_slots"
        case cameraSessionID = "camera_session_id"
        case advisorSessionID = "advisor_session_id"
        case advisorEvents = "advisor_events"
        case advisorClientInstanceID = "advisor_client_instance_id"
        case advisorQueueTicketID = "advisor_queue_ticket_id"
    }

    public var isValid: Bool {
        bridgeVersion == 1
            && UUID(uuidString: requestID) != nil
            && UUID(uuidString: assessmentID) != nil
            && UUID(uuidString: roomID) != nil
            && !accessToken.isEmpty
            && Self.allowedRoomTypes.contains(roomType)
            && (0...6).contains(remainingSlots)
            && (cameraSessionID.map { UUID(uuidString: $0) != nil } ?? true)
            && (advisorSessionID.map { UUID(uuidString: $0) != nil } ?? true)
            && (advisorEvents?.isValid ?? true)
            && (advisorClientInstanceID.map { UUID(uuidString: $0) != nil } ?? true)
            && (advisorQueueTicketID.map { UUID(uuidString: $0) != nil } ?? true)
    }

    private static let allowedRoomTypes: Set<String> = [
        "bathroom", "bedroom", "living_room", "kitchen", "corridor", "balcony",
    ]
}

public struct NativeCaptureResult: Codable, Sendable {
    public let requestID: String
    public let status: String
    public let roomID: String
    public let captureMode: String
    public let uploadedMediaIDs: [String]
    public let failedCount: Int
    public let errorCode: String?
    public let cameraSessionID: String?

    public init(
        requestID: String,
        status: String,
        roomID: String,
        captureMode: String,
        uploadedMediaIDs: [String],
        failedCount: Int,
        errorCode: String?,
        cameraSessionID: String? = nil
    ) {
        self.requestID = requestID
        self.status = status
        self.roomID = roomID
        self.captureMode = captureMode
        self.uploadedMediaIDs = uploadedMediaIDs
        self.failedCount = failedCount
        self.errorCode = errorCode
        self.cameraSessionID = cameraSessionID
    }

    public enum CodingKeys: String, CodingKey {
        case status
        case requestID = "request_id"
        case roomID = "room_id"
        case captureMode = "capture_mode"
        case uploadedMediaIDs = "uploaded_media_ids"
        case failedCount = "failed_count"
        case errorCode = "error_code"
        case cameraSessionID = "camera_session_id"
    }
}

public struct NativeFrameSelectionPolicy: Equatable, Sendable {
    public static let homeCamera = NativeFrameSelectionPolicy()

    public let candidateInterval: Double
    public let minimumBrightness: Double
    public let maximumBrightness: Double
    public let minimumSharpness: Double
    public let minimumTranslationMeters: Double
    public let minimumRotationRadians: Double
    public let minimumPerceptualHashDistance: Int
    public let modelRequestInterval: Double
    public let maximumModelRequests: Int
    public let maximumDepthContexts: Int
    public let maximumImageEdge: Double
    public let jpegQuality: Double

    public init(
        candidateInterval: Double = 2,
        minimumBrightness: Double = 28,
        maximumBrightness: Double = 232,
        minimumSharpness: Double = 5,
        minimumTranslationMeters: Double = 0.15,
        minimumRotationRadians: Double = 0.14,
        minimumPerceptualHashDistance: Int = 6,
        modelRequestInterval: Double = 5,
        maximumModelRequests: Int = 30,
        maximumDepthContexts: Int = 8,
        maximumImageEdge: Double = 1280,
        jpegQuality: Double = 0.72
    ) {
        self.candidateInterval = candidateInterval
        self.minimumBrightness = minimumBrightness
        self.maximumBrightness = maximumBrightness
        self.minimumSharpness = minimumSharpness
        self.minimumTranslationMeters = minimumTranslationMeters
        self.minimumRotationRadians = minimumRotationRadians
        self.minimumPerceptualHashDistance = minimumPerceptualHashDistance
        self.modelRequestInterval = modelRequestInterval
        self.maximumModelRequests = maximumModelRequests
        self.maximumDepthContexts = maximumDepthContexts
        self.maximumImageEdge = maximumImageEdge
        self.jpegQuality = jpegQuality
    }

    public func acceptsQuality(brightness: Double, sharpness: Double) -> Bool {
        (minimumBrightness...maximumBrightness).contains(brightness)
            && sharpness >= minimumSharpness
    }

    public func acceptsPerceptualHash(previous: UInt64?, current: UInt64) -> Bool {
        guard let previous else { return true }
        return (previous ^ current).nonzeroBitCount >= minimumPerceptualHashDistance
    }

    public func permitsModelRequest(elapsed: Double, completedRequests: Int) -> Bool {
        elapsed >= modelRequestInterval && completedRequests < maximumModelRequests
    }
}
