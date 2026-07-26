import AnjuCore
import Foundation
import ImageIO
import OSLog

enum RemoteAnalysisError: LocalizedError {
    case disabled
    case invalidEndpoint
    case invalidResponse
    case timedOut
    case server(code: String, status: Int)

    var errorDescription: String? {
        switch self {
        case .disabled: "云端辅助未启用"
        case .invalidEndpoint: "云端辅助地址不可用"
        case .invalidResponse: "云端辅助返回内容无法确认"
        case .timedOut: "云端辅助响应超时"
        case let .server(code, status): "云端辅助请求失败（\(status)，\(code)）"
        }
    }
}

protocol RemoteAnalysisServing: Sendable {
    var isEnabled: Bool { get }
    func analyze(frameID: UUID, jpegData: Data, roomType: String?) async throws -> [IssueCandidate]
    func selectFairZone(_ zone: VenueZone) async
    func completeFairScan() async throws -> FairScanCompletion
    func cancelPending() async
}

enum FairScanCompletion: Sendable {
    case report(FairScanReportDTO)
    case noSuccessfulAnalysis
}

struct DisabledRemoteAnalysisClient: RemoteAnalysisServing {
    let isEnabled = false

    func analyze(frameID: UUID, jpegData: Data, roomType: String?) async throws -> [IssueCandidate] {
        throw RemoteAnalysisError.disabled
    }

    func selectFairZone(_ zone: VenueZone) async {}
    func completeFairScan() async throws -> FairScanCompletion { .noSuccessfulAnalysis }

    func cancelPending() async {}
}

actor RemoteAnalysisClient: RemoteAnalysisServing {
    nonisolated let isEnabled = true
    private let baseURL: URL
    private let localSessionID: UUID
    private let urlSession: URLSession
    private let logger = Logger(subsystem: "com.anjuguard.app", category: "network")
    private var remoteSessionID: String?
    private var fairScanToken: String?
    private var selectedZone: VenueZone = .entrance
    private var scannedZones: Set<VenueZone> = []

    init?(baseURL: URL, sessionID: UUID, timeout: TimeInterval = 20) {
        guard baseURL.scheme?.lowercased() == "https" else { return nil }
        self.baseURL = baseURL
        self.localSessionID = sessionID
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = 75
        configuration.httpMaximumConnectionsPerHost = 1
        urlSession = URLSession(configuration: configuration)
    }

    func analyze(frameID: UUID, jpegData: Data, roomType: String?) async throws -> [IssueCandidate] {
        await cancelPending()
        let sessionID = try await ensureFairScan()
        let zoneEndpoint = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("v2")
            .appendingPathComponent("fair-scans")
            .appendingPathComponent(sessionID)
            .appendingPathComponent("zones")
            .appendingPathComponent(selectedZone.rawValue)
        guard let endpoint = URL(string: zoneEndpoint.absoluteString + "/frames:analyze") else {
            throw RemoteAnalysisError.invalidEndpoint
        }
        var request = URLRequest(url: endpoint)
        request.timeoutInterval = 30
        request.httpMethod = "POST"
        request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        request.setValue(frameID.uuidString, forHTTPHeaderField: "X-Frame-ID")
        request.setValue("right", forHTTPHeaderField: "X-Model-Image-Orientation")
        if let token = fairScanToken { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let source = CGImageSourceCreateWithData(jpegData as CFData, nil),
           let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] {
            request.setValue(String(properties[kCGImagePropertyPixelWidth] as? Int ?? 0), forHTTPHeaderField: "X-Image-Width")
            request.setValue(String(properties[kCGImagePropertyPixelHeight] as? Int ?? 0), forHTTPHeaderField: "X-Image-Height")
        }
        request.httpBody = jpegData

        do {
            logger.notice("Starting direct Pro frame analysis")
            let (data, response) = try await urlSession.data(for: request)
            try validate(response: response, data: data)
            let dto = try JSONDecoder().decode(FairDirectResponseDTO.self, from: data)
            guard dto.frameID == frameID, dto.zoneID == selectedZone else { throw RemoteAnalysisError.invalidResponse }
            scannedZones.insert(selectedZone)
            logger.notice("Direct Pro analysis completed with \(dto.candidates.count, privacy: .public) candidates")
            return dto.candidates.prefix(5).compactMap { $0.validatedCandidate() }
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

    func selectFairZone(_ zone: VenueZone) async {
        selectedZone = zone
    }

    func completeFairScan() async throws -> FairScanCompletion {
        guard let scanID = remoteSessionID, let token = fairScanToken, !scannedZones.isEmpty else {
            return .noSuccessfulAnalysis
        }
        for zone in scannedZones {
            let zoneEndpoint = baseURL.appendingPathComponent("api").appendingPathComponent("v2").appendingPathComponent("fair-scans").appendingPathComponent(scanID).appendingPathComponent("zones").appendingPathComponent(zone.rawValue)
            guard let finalize = URL(string: zoneEndpoint.absoluteString + ":finalize") else {
                throw RemoteAnalysisError.invalidEndpoint
            }
            var request = URLRequest(url: finalize)
            request.timeoutInterval = 70
            request.httpMethod = "POST"
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            let (data, response) = try await urlSession.data(for: request)
            try validate(response: response, data: data)
        }
        let endpoint = baseURL.appendingPathComponent("api").appendingPathComponent("v2").appendingPathComponent("fair-scans").appendingPathComponent(scanID).appendingPathComponent("report")
        var request = URLRequest(url: endpoint)
        request.timeoutInterval = 20
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await urlSession.data(for: request)
        try validate(response: response, data: data)
        return .report(try JSONDecoder().decode(FairScanReportDTO.self, from: data))
    }

    private func ensureFairScan() async throws -> String {
        if let remoteSessionID { return remoteSessionID }
        let endpoint = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("v2")
            .appendingPathComponent("fair-scans")
        var request = URLRequest(url: endpoint)
        request.timeoutInterval = 20
        request.httpMethod = "POST"
        request.setValue(localSessionID.uuidString, forHTTPHeaderField: "X-Device-Session-ID")
        let (data, response) = try await urlSession.data(for: request)
        try validate(response: response, data: data)
        guard let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = payload["scan_id"] as? String,
              let token = payload["access_token"] as? String,
              UUID(uuidString: value) != nil else {
            throw RemoteAnalysisError.invalidResponse
        }
        remoteSessionID = value
        fairScanToken = token
        return value
    }

    private func validate(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else {
            throw RemoteAnalysisError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let code = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["code"] as? String
            throw RemoteAnalysisError.server(code: code ?? "http_error", status: http.statusCode)
        }
    }
}
