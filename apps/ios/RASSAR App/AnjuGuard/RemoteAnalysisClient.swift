import AnjuCore
import Foundation
import ImageIO
import OSLog

struct CameraSuggestionResponse: Decodable, Sendable {
    let frameID: String
    let temporary: Bool
    let suggestions: [CameraSuggestion]

    enum CodingKeys: String, CodingKey {
        case temporary, suggestions
        case frameID = "frame_id"
    }
}

struct CameraSuggestion: Decodable, Sendable {
    let suggestionID: String?
    let riskCode: String
    let title: String
    let shortAdvice: String
    let evidence: String
    let confidence: Double
    let region: CameraSuggestionRegion?

    enum CodingKeys: String, CodingKey {
        case title, evidence, confidence, region
        case suggestionID = "suggestion_id"
        case riskCode = "risk_code"
        case shortAdvice = "short_advice"
    }
}

struct AdvisorRTCConfiguration: Decodable, Sendable {
    let available: Bool
    let reason: String?
    let provider: String?
    let appID: String?
    let roomID: String?
    let userID: String?
    let botUserID: String?
    let token: String?
    let expiresAt: String?
    let mediaMode: String?
    let videoAvailable: Bool?
    let visionMode: String?
    let snapshotIntervalMilliseconds: Int?
    let snapshotHeight: Int?
    let imageDetail: String?

    enum CodingKeys: String, CodingKey {
        case available, reason, provider, token
        case appID = "app_id"
        case roomID = "room_id"
        case userID = "user_id"
        case botUserID = "bot_user_id"
        case expiresAt = "expires_at"
        case mediaMode = "media_mode"
        case videoAvailable = "video_available"
        case visionMode = "vision_mode"
        case snapshotIntervalMilliseconds = "snapshot_interval_ms"
        case snapshotHeight = "snapshot_height"
        case imageDetail = "image_detail"
    }

    var isUsable: Bool {
        available && provider == "volcengine"
            && !(appID ?? "").isEmpty && !(roomID ?? "").isEmpty
            && !(userID ?? "").isEmpty && !(botUserID ?? "").isEmpty
            && !(token ?? "").isEmpty
    }

    var supportsVideo: Bool {
        isUsable && mediaMode == "audio_video" && videoAvailable == true
            && visionMode == "rtc_snapshot"
    }
}

struct AdvisorRTCQueueTicket: Decodable, Sendable {
    let ticketID: String?
    let status: String
    let position: Int?
    let expiresAt: String?
    let pollAfterMilliseconds: Int?
    let mode: String?
    let reason: String?

    enum CodingKeys: String, CodingKey {
        case status, position, mode, reason
        case ticketID = "ticket_id"
        case expiresAt = "expires_at"
        case pollAfterMilliseconds = "poll_after_ms"
    }
}

struct PreparedCameraInspection: Decodable, Sendable {
    let inspectionID: String
    let frameID: String
    let groupID: Int
    let rtcMessage: String
    let expiresAt: String
    let maxChunkBytes: Int

    enum CodingKeys: String, CodingKey {
        case inspectionID = "inspection_id"
        case frameID = "frame_id"
        case groupID = "group_id"
        case rtcMessage = "rtc_message"
        case expiresAt = "expires_at"
        case maxChunkBytes = "max_chunk_bytes"
    }
}

struct AdvisorMessageTurn: Decodable, Sendable {
    let text: String
}

struct AdvisorMessageResponse: Decodable, Sendable {
    let assistantTurn: AdvisorMessageTurn

    enum CodingKeys: String, CodingKey {
        case assistantTurn = "assistant_turn"
    }
}

struct CameraSuggestionRegion: Decodable, Sendable {
    let type: String
    let x: Double?
    let y: Double?
    let width: Double?
    let height: Double?
}

enum RemoteAnalysisError: LocalizedError, Sendable {
    case invalidEndpoint
    case invalidResponse
    case timedOut
    case server(code: String, status: Int)

    var errorDescription: String? {
        switch self {
        case .invalidEndpoint: "采集服务地址不可用"
        case .invalidResponse: "服务返回内容无法确认"
        case .timedOut: "服务响应超时"
        case let .server(code, status): "请求失败（\(status)，\(code)）"
        }
    }
}

actor RemoteAnalysisClient {
    private let baseURL: URL
    private let requestContext: NativeCaptureRequest
    private let urlSession: URLSession
    private let advisorClientInstanceID: String?
    private var advisorQueueTicketID: String?
    private var advisorEvents: NativeAdvisorEventConfig?
    private let logger = Logger(subsystem: "com.anjuguard.app", category: "home-camera")

    init?(baseURL: URL, request: NativeCaptureRequest, timeout: TimeInterval = 25) {
        guard baseURL.scheme?.lowercased() == "https", request.isValid else { return nil }
        self.baseURL = baseURL
        requestContext = request
        advisorClientInstanceID = request.advisorClientInstanceID
        advisorQueueTicketID = request.advisorQueueTicketID
        advisorEvents = request.advisorEvents
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = 75
        configuration.httpMaximumConnectionsPerHost = 1
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        urlSession = URLSession(configuration: configuration)
    }

    func inspect(frameID: UUID, jpegData: Data, previousSummary: [[String: String]] = []) async throws -> CameraSuggestionResponse {
        let endpoint = try roomEndpoint(suffix: "camera/frames:inspect")
        var request = authorizedRequest(endpoint, method: "POST")
        request.timeoutInterval = 30
        request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        let dimensions = imageDimensions(jpegData)
        request.setValue(String(dimensions.width), forHTTPHeaderField: "X-Image-Width")
        request.setValue(String(dimensions.height), forHTTPHeaderField: "X-Image-Height")
        var context: [String: Any] = [
            "frame_id": frameID.uuidString,
            "source_kind": "ios_camera_frame",
            "orientation": "up",
            "previous_summary": previousSummary
        ]
        if let cameraSessionID = requestContext.cameraSessionID {
            context["camera_session_id"] = cameraSessionID
        }
        request.setValue(
            String(data: try JSONSerialization.data(withJSONObject: context), encoding: .utf8),
            forHTTPHeaderField: "X-Camera-Context"
        )
        request.httpBody = jpegData
        let data = try await perform(request)
        let decoded = try JSONDecoder().decode(CameraSuggestionResponse.self, from: data)
        guard decoded.frameID.caseInsensitiveCompare(frameID.uuidString) == .orderedSame,
              decoded.temporary else { throw RemoteAnalysisError.invalidResponse }
        return decoded
    }

    func upload(
        jpegData: Data,
        sourceKind: String,
        sourceID: String?,
        frameIndex: Int?,
        capturedAtMilliseconds: Int?
    ) async throws -> String {
        let endpoint = try roomEndpoint(suffix: "media")
        var request = authorizedRequest(endpoint, method: "POST")
        request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        let dimensions = imageDimensions(jpegData)
        request.setValue(String(dimensions.width), forHTTPHeaderField: "X-Image-Width")
        request.setValue(String(dimensions.height), forHTTPHeaderField: "X-Image-Height")
        request.setValue(sourceKind, forHTTPHeaderField: "X-Media-Source-Kind")
        request.setValue("up", forHTTPHeaderField: "X-Media-Orientation")
        if let sourceID { request.setValue(sourceID, forHTTPHeaderField: "X-Media-Source-ID") }
        if let frameIndex { request.setValue(String(frameIndex), forHTTPHeaderField: "X-Media-Frame-Index") }
        if let capturedAtMilliseconds {
            request.setValue(String(capturedAtMilliseconds), forHTTPHeaderField: "X-Media-Captured-At-Ms")
        }
        request.httpBody = jpegData
        let data = try await perform(request)
        guard let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let mediaID = payload["media_id"] as? String,
              UUID(uuidString: mediaID) != nil else { throw RemoteAnalysisError.invalidResponse }
        return mediaID
    }

    func startAdvisorVoice() async throws -> AdvisorRTCConfiguration {
        guard let sessionID = requestContext.advisorSessionID else {
            throw RemoteAnalysisError.invalidEndpoint
        }
        let endpoint = try roomEndpoint(suffix: "advisor/sessions/\(sessionID)/voice")
        let data = try await perform(try authorizedAdvisorRTCRequest(endpoint))
        return try JSONDecoder().decode(AdvisorRTCConfiguration.self, from: data)
    }

    func startAdvisorRealtime() async throws -> AdvisorRTCConfiguration {
        guard let sessionID = requestContext.advisorSessionID else {
            throw RemoteAnalysisError.invalidEndpoint
        }
        let endpoint = try roomEndpoint(suffix: "advisor/sessions/\(sessionID)/realtime")
        let data = try await perform(try authorizedAdvisorRTCRequest(endpoint))
        return try JSONDecoder().decode(AdvisorRTCConfiguration.self, from: data)
    }

    func heartbeatAdvisorRTCQueue() async throws -> AdvisorRTCQueueTicket {
        guard let sessionID = requestContext.advisorSessionID,
              let clientID = advisorClientInstanceID,
              let ticketID = advisorQueueTicketID else {
            throw RemoteAnalysisError.server(code: "advisor_queue_required", status: 409)
        }
        let endpoint = try roomEndpoint(
            suffix: "advisor/sessions/\(sessionID)/rtc-queue/\(ticketID)/heartbeat"
        )
        var request = authorizedRequest(endpoint, method: "POST")
        request.setValue(clientID, forHTTPHeaderField: "X-Advisor-Client-ID")
        let data = try await perform(request)
        return try JSONDecoder().decode(AdvisorRTCQueueTicket.self, from: data)
    }

    func recoverAdvisorRealtime(
        timeout: TimeInterval = NativeAdvisorLeaseRecoveryPolicy.recoveryTimeoutSeconds
    ) async throws -> AdvisorRTCConfiguration {
        let deadline = Date().addingTimeInterval(timeout)
        var retryIndex = 0
        while !Task.isCancelled, Date() < deadline {
            do {
                _ = try await heartbeatAdvisorRTCQueue()
                return try await startAdvisorRealtime()
            } catch let RemoteAnalysisError.server(code, status)
                where status == 410 || code == "advisor_queue_expired" {
                return try await reacquireAdvisorRealtime(deadline: deadline)
            } catch {
                let seconds = NativeAdvisorLeaseRecoveryPolicy.retryDelaySeconds(attempt: retryIndex)
                retryIndex += 1
                try await sleepBeforeRetry(seconds: seconds, deadline: deadline)
            }
        }
        throw RemoteAnalysisError.timedOut
    }

    func cancelAdvisorRTCQueue() async {
        guard let sessionID = requestContext.advisorSessionID,
              let clientID = advisorClientInstanceID,
              let ticketID = advisorQueueTicketID,
              let endpoint = try? roomEndpoint(
                suffix: "advisor/sessions/\(sessionID)/rtc-queue/\(ticketID)"
              ) else { return }
        var request = authorizedRequest(endpoint, method: "DELETE")
        request.setValue(clientID, forHTTPHeaderField: "X-Advisor-Client-ID")
        _ = try? await perform(request)
        advisorQueueTicketID = nil
    }

    func issueAdvisorEventToken() async throws -> NativeAdvisorEventConfig {
        guard let sessionID = requestContext.advisorSessionID else {
            throw RemoteAnalysisError.invalidEndpoint
        }
        let endpoint = try roomEndpoint(suffix: "advisor/sessions/\(sessionID)/events-token")
        let data = try await perform(authorizedRequest(endpoint, method: "POST"))
        let events = try JSONDecoder().decode(NativeAdvisorEventConfig.self, from: data)
        guard events.isValid else { throw RemoteAnalysisError.invalidResponse }
        advisorEvents = events
        return events
    }

    func prepareInspection(
        frameID: UUID,
        capturedAtMilliseconds: Int,
        width: Int,
        height: Int,
        perceptualHash: String,
        brightness: Double,
        sharpness: Double,
        motion: Double
    ) async throws -> PreparedCameraInspection {
        guard let cameraSessionID = requestContext.cameraSessionID else {
            throw RemoteAnalysisError.invalidEndpoint
        }
        let endpoint = try roomEndpoint(
            suffix: "camera/sessions/\(cameraSessionID)/frames:prepare-inspection"
        )
        var request = authorizedRequest(endpoint, method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "frame_id": frameID.uuidString,
            "captured_at_ms": capturedAtMilliseconds,
            "width": width,
            "height": height,
            "orientation": "up",
            "perceptual_hash": perceptualHash,
            "quality": [
                "brightness": brightness,
                "sharpness": sharpness,
                "motion": motion,
            ],
        ])
        let data = try await perform(request)
        let value = try JSONDecoder().decode(PreparedCameraInspection.self, from: data)
        guard value.frameID.caseInsensitiveCompare(frameID.uuidString) == .orderedSame else {
            throw RemoteAnalysisError.invalidResponse
        }
        return value
    }

    func advisorMessage(
        _ text: String,
        suggestionID: String?,
        frameID: String?
    ) async throws -> AdvisorMessageResponse {
        guard let sessionID = requestContext.advisorSessionID else {
            throw RemoteAnalysisError.invalidEndpoint
        }
        let endpoint = try roomEndpoint(suffix: "advisor/sessions/\(sessionID)/messages")
        var request = authorizedRequest(endpoint, method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var context: [String: String] = ["room_id": requestContext.roomID]
        if let cameraSessionID = requestContext.cameraSessionID {
            context["camera_session_id"] = cameraSessionID
        }
        if let suggestionID {
            context["camera_suggestion_id"] = suggestionID
            if let frameID { context["frame_id"] = frameID }
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "text": String(text.prefix(500)),
            "context_refs": context,
        ])
        let data = try await perform(request)
        return try JSONDecoder().decode(AdvisorMessageResponse.self, from: data)
    }

    func advisorEventSocket(refreshToken: Bool = false) async throws -> URLSessionWebSocketTask? {
        let events: NativeAdvisorEventConfig
        if refreshToken {
            events = try await issueAdvisorEventToken()
        } else if let current = advisorEvents {
            events = current
        } else {
            return nil
        }
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        components?.scheme = baseURL.scheme == "https" ? "wss" : "ws"
        components?.path = events.websocketPath
        components?.queryItems = [URLQueryItem(name: "token", value: events.token)]
        guard let url = components?.url else { throw RemoteAnalysisError.invalidEndpoint }
        return urlSession.webSocketTask(with: url)
    }

    func cancelPending() async {
        let tasks = await urlSession.allTasks
        tasks.forEach { $0.cancel() }
    }

    func recordAnalytics(_ eventName: String, payload: [String: String] = [:]) async {
        let endpoint = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("v2")
            .appendingPathComponent("assessments")
            .appendingPathComponent(requestContext.assessmentID)
            .appendingPathComponent("analytics")
            .appendingPathComponent("events")
        guard endpoint.scheme == "https", !eventName.isEmpty else { return }
        var request = authorizedRequest(endpoint, method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "event_name": String(eventName.prefix(64)),
            "room_id": requestContext.roomID,
            "payload": payload,
        ])
        _ = try? await perform(request)
    }

    private func roomEndpoint(suffix: String) throws -> URL {
        var endpoint = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("v2")
            .appendingPathComponent("assessments")
            .appendingPathComponent(requestContext.assessmentID)
            .appendingPathComponent("rooms")
            .appendingPathComponent(requestContext.roomID)
        for component in suffix.split(separator: "/") {
            endpoint.appendPathComponent(String(component))
        }
        guard endpoint.scheme == "https" else { throw RemoteAnalysisError.invalidEndpoint }
        return endpoint
    }

    private func authorizedRequest(_ endpoint: URL, method: String) -> URLRequest {
        var request = URLRequest(url: endpoint)
        request.httpMethod = method
        request.setValue("Bearer \(requestContext.accessToken)", forHTTPHeaderField: "Authorization")
        return request
    }

    private func authorizedAdvisorRTCRequest(_ endpoint: URL) throws -> URLRequest {
        guard let clientID = advisorClientInstanceID,
              let ticketID = advisorQueueTicketID else {
            throw RemoteAnalysisError.server(code: "advisor_queue_required", status: 409)
        }
        var request = authorizedRequest(endpoint, method: "POST")
        request.setValue(clientID, forHTTPHeaderField: "X-Advisor-Client-ID")
        request.setValue(ticketID, forHTTPHeaderField: "X-Advisor-Queue-Ticket")
        return request
    }

    private func reacquireAdvisorRealtime(deadline: Date) async throws -> AdvisorRTCConfiguration {
        var ticket: AdvisorRTCQueueTicket?
        var retryIndex = 0
        while !Task.isCancelled, Date() < deadline {
            do {
                let current = try await (ticket == nil ? enqueueAdvisorRTCQueue() : advisorRTCQueueStatus())
                ticket = current
                retryIndex = 0
                if current.status == "granted" || current.status == "active" {
                    if let ticketID = current.ticketID { advisorQueueTicketID = ticketID }
                    return try await startAdvisorRealtime()
                }
                if current.status == "unavailable" {
                    throw RemoteAnalysisError.server(code: "advisor_queue_required", status: 409)
                }
                let wait = max(250, min(5_000, current.pollAfterMilliseconds ?? 2_000))
                try await sleepBeforeRetry(milliseconds: wait, deadline: deadline)
            } catch let RemoteAnalysisError.server(code, status)
                where status == 410 || code == "advisor_queue_expired" {
                ticket = nil
            } catch let RemoteAnalysisError.server(code, status)
                where status == 409 || code == "advisor_queue_required" {
                throw RemoteAnalysisError.server(code: code, status: status)
            } catch {
                let seconds = NativeAdvisorLeaseRecoveryPolicy.retryDelaySeconds(attempt: retryIndex)
                retryIndex += 1
                try await sleepBeforeRetry(seconds: seconds, deadline: deadline)
            }
        }
        throw RemoteAnalysisError.timedOut
    }

    private func enqueueAdvisorRTCQueue() async throws -> AdvisorRTCQueueTicket {
        guard let sessionID = requestContext.advisorSessionID,
              let clientID = advisorClientInstanceID else {
            throw RemoteAnalysisError.server(code: "advisor_queue_required", status: 409)
        }
        let endpoint = try roomEndpoint(suffix: "advisor/sessions/\(sessionID)/rtc-queue")
        var request = authorizedRequest(endpoint, method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "client_instance_id": clientID, "mode": "audio_video",
        ])
        let data = try await perform(request)
        let ticket = try JSONDecoder().decode(AdvisorRTCQueueTicket.self, from: data)
        if let ticketID = ticket.ticketID { advisorQueueTicketID = ticketID }
        return ticket
    }

    private func advisorRTCQueueStatus() async throws -> AdvisorRTCQueueTicket {
        guard let sessionID = requestContext.advisorSessionID,
              let clientID = advisorClientInstanceID,
              let ticketID = advisorQueueTicketID else {
            throw RemoteAnalysisError.server(code: "advisor_queue_required", status: 409)
        }
        let endpoint = try roomEndpoint(suffix: "advisor/sessions/\(sessionID)/rtc-queue/\(ticketID)")
        var request = authorizedRequest(endpoint, method: "GET")
        request.setValue(clientID, forHTTPHeaderField: "X-Advisor-Client-ID")
        let data = try await perform(request)
        return try JSONDecoder().decode(AdvisorRTCQueueTicket.self, from: data)
    }

    private func sleepBeforeRetry(seconds: UInt64, deadline: Date) async throws {
        let remaining = deadline.timeIntervalSinceNow
        guard remaining > 0 else { throw RemoteAnalysisError.timedOut }
        let duration = min(Double(seconds), remaining)
        try await Task.sleep(nanoseconds: UInt64(duration * 1_000_000_000))
    }

    private func sleepBeforeRetry(milliseconds: Int, deadline: Date) async throws {
        let remaining = deadline.timeIntervalSinceNow
        guard remaining > 0 else { throw RemoteAnalysisError.timedOut }
        let duration = min(Double(milliseconds) / 1_000, remaining)
        try await Task.sleep(nanoseconds: UInt64(duration * 1_000_000_000))
    }

    private func imageDimensions(_ data: Data) -> (width: Int, height: Int) {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else {
            return (0, 0)
        }
        return (
            properties[kCGImagePropertyPixelWidth] as? Int ?? 0,
            properties[kCGImagePropertyPixelHeight] as? Int ?? 0
        )
    }

    private func perform(_ request: URLRequest) async throws -> Data {
        do {
            let (data, response) = try await urlSession.data(for: request)
            try validate(response: response, data: data)
            return data
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .timedOut {
            throw RemoteAnalysisError.timedOut
        } catch {
            logger.error("Home camera request failed: \(error.localizedDescription, privacy: .public)")
            throw error
        }
    }

    private func validate(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw RemoteAnalysisError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let object = try? JSONSerialization.jsonObject(with: data)
            let code = (object as? [String: Any])?["code"] as? String ?? "http_error"
            throw RemoteAnalysisError.server(code: code, status: http.statusCode)
        }
    }
}
