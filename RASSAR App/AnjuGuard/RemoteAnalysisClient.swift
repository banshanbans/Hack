import AnjuCore
import Foundation
import OSLog

enum RemoteAnalysisError: Error {
    case disabled
    case invalidEndpoint
    case invalidResponse
    case timedOut
}

protocol RemoteAnalysisServing: Sendable {
    var isEnabled: Bool { get }
    func analyze(frameID: UUID, jpegData: Data, roomType: String?) async throws -> [IssueCandidate]
    func cancelPending() async
}

struct DisabledRemoteAnalysisClient: RemoteAnalysisServing {
    let isEnabled = false

    func analyze(frameID: UUID, jpegData: Data, roomType: String?) async throws -> [IssueCandidate] {
        throw RemoteAnalysisError.disabled
    }

    func cancelPending() async {}
}

actor RemoteAnalysisClient: RemoteAnalysisServing {
    nonisolated let isEnabled = true
    private let baseURL: URL
    private let localSessionID: UUID
    private let profiles: [String]
    private let urlSession: URLSession
    private let logger = Logger(subsystem: "com.anjuguard.app", category: "network")
    private var remoteSessionID: UUID?

    init?(baseURL: URL, sessionID: UUID, profiles: [String] = [], timeout: TimeInterval = 15) {
        guard baseURL.scheme?.lowercased() == "https" else { return nil }
        self.baseURL = baseURL
        self.localSessionID = sessionID
        self.profiles = profiles
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout + 5
        configuration.httpMaximumConnectionsPerHost = 1
        urlSession = URLSession(configuration: configuration)
    }

    func analyze(frameID: UUID, jpegData: Data, roomType: String?) async throws -> [IssueCandidate] {
        await cancelPending()
        let sessionID = try await ensureRemoteSession(roomType: roomType)
        let endpoint = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("v1")
            .appendingPathComponent("sessions")
            .appendingPathComponent(sessionID.uuidString)
            .appendingPathComponent("frames:analyze")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        request.setValue(frameID.uuidString, forHTTPHeaderField: "X-Frame-ID")
        if let roomType { request.setValue(roomType, forHTTPHeaderField: "X-Room-Type") }
        request.httpBody = jpegData

        do {
            let (data, response) = try await urlSession.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw RemoteAnalysisError.invalidResponse
            }
            let dto = try JSONDecoder().decode(RemoteAnalysisResponseDTO.self, from: data)
            guard dto.frameID == frameID else { throw RemoteAnalysisError.invalidResponse }
            return dto.issues.prefix(5).compactMap { $0.validatedCandidate(frameID: frameID) }
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .timedOut {
            logger.notice("Remote frame analysis timed out")
            throw RemoteAnalysisError.timedOut
        } catch {
            logger.error("Remote frame analysis failed: \(error.localizedDescription, privacy: .public)")
            throw error
        }
    }

    func cancelPending() async {
        let tasks = await urlSession.allTasks
        tasks.forEach { $0.cancel() }
    }

    private func ensureRemoteSession(roomType: String?) async throws -> UUID {
        if let remoteSessionID { return remoteSessionID }
        let endpoint = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("v1")
            .appendingPathComponent("sessions")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "device_id": localSessionID.uuidString,
            "room_type": roomType ?? "unknown",
            "profiles": profiles,
            "app_version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1"
        ])
        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = payload["session_id"] as? String,
              let sessionID = UUID(uuidString: value) else {
            throw RemoteAnalysisError.invalidResponse
        }
        remoteSessionID = sessionID
        return sessionID
    }
}
