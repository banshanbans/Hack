import Foundation

public enum ScanSessionState: String, Codable, Sendable {
    case preparing
    case scanning
    case paused
    case completed
}

public struct ScanSession: Identifiable, Codable, Equatable, Sendable {
    public let id: UUID
    public var roomType: String?
    public var profiles: Set<String>
    public var state: ScanSessionState
    public let createdAt: Date
    public var completedAt: Date?

    public init(
        id: UUID = UUID(),
        roomType: String? = nil,
        profiles: Set<String> = [],
        state: ScanSessionState = .preparing,
        createdAt: Date = Date(),
        completedAt: Date? = nil
    ) {
        self.id = id
        self.roomType = roomType
        self.profiles = profiles
        self.state = state
        self.createdAt = createdAt
        self.completedAt = completedAt
    }
}
