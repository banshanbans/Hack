import AnjuCore
import Foundation
import ImageIO
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
    func selectFairZone(_ zone: VenueZone) async
    func completeFairScan() async throws -> FairScanReportDTO?
    func cancelPending() async
}

struct DisabledRemoteAnalysisClient: RemoteAnalysisServing {
    let isEnabled = false

    func analyze(frameID: UUID, jpegData: Data, roomType: String?) async throws -> [IssueCandidate] {
        throw RemoteAnalysisError.disabled
    }

    func selectFairZone(_ zone: VenueZone) async {}
    func completeFairScan() async throws -> FairScanReportDTO? { nil }

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
    private var fairScanToken: String?
    private var selectedZone: VenueZone = .entrance
    private var scannedZones: Set<VenueZone> = []

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
        let sessionID = try await ensureFairScan()
        let endpoint = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("v2")
            .appendingPathComponent("fair-scans")
            .appendingPathComponent(sessionID.uuidString)
            .appendingPathComponent("zones")
            .appendingPathComponent(selectedZone.rawValue)
            .appendingPathComponent("frames:turbo")
        var request = URLRequest(url: endpoint)
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
            let (data, response) = try await urlSession.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw RemoteAnalysisError.invalidResponse
            }
            let dto = try JSONDecoder().decode(FairTurboResponseDTO.self, from: data)
            guard dto.frameID == frameID, dto.zoneID == selectedZone else { throw RemoteAnalysisError.invalidResponse }
            scannedZones.insert(selectedZone)
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

    func completeFairScan() async throws -> FairScanReportDTO? {
        guard let scanID = remoteSessionID, let token = fairScanToken else { return nil }
        for zone in scannedZones {
            let review = baseURL.appendingPathComponent("api").appendingPathComponent("v2").appendingPathComponent("fair-scans").appendingPathComponent(scanID.uuidString).appendingPathComponent("zones").appendingPathComponent("\(zone.rawValue):review")
            var request = URLRequest(url: review)
            request.httpMethod = "POST"
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            let (_, response) = try await urlSession.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw RemoteAnalysisError.invalidResponse }
        }
        let endpoint = baseURL.appendingPathComponent("api").appendingPathComponent("v2").appendingPathComponent("fair-scans").appendingPathComponent(scanID.uuidString).appendingPathComponent("report")
        var request = URLRequest(url: endpoint)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw RemoteAnalysisError.invalidResponse }
        return try JSONDecoder().decode(FairScanReportDTO.self, from: data)
    }

    private func ensureFairScan() async throws -> UUID {
        if let remoteSessionID { return remoteSessionID }
        let endpoint = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("v2")
            .appendingPathComponent("fair-scans")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue(localSessionID.uuidString, forHTTPHeaderField: "X-Device-Session-ID")
        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = payload["scan_id"] as? String,
              let token = payload["access_token"] as? String,
              let sessionID = UUID(uuidString: value) else {
            throw RemoteAnalysisError.invalidResponse
        }
        remoteSessionID = sessionID
        fairScanToken = token
        return sessionID
    }
}
