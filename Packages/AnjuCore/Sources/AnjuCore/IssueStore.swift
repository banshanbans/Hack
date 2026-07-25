import Foundation

public struct IssueStoreConfiguration: Equatable, Sendable {
    public var duplicateDistanceMeters: Float
    public var stableObservationCount: Int

    public init(duplicateDistanceMeters: Float = 0.35, stableObservationCount: Int = 3) {
        self.duplicateDistanceMeters = duplicateDistanceMeters
        self.stableObservationCount = stableObservationCount
    }
}

public struct IssueStore: Sendable {
    public private(set) var issues: [SafetyIssue] = []
    private var observationCounts: [UUID: Int] = [:]
    private var dismissedKeys: Set<String> = []
    private let configuration: IssueStoreConfiguration

    public init(configuration: IssueStoreConfiguration = .init()) {
        self.configuration = configuration
    }

    @discardableResult
    public mutating func observe(_ incoming: SafetyIssue) -> SafetyIssue? {
        let key = dismissalKey(for: incoming)
        guard !dismissedKeys.contains(key), !isDismissedDuplicate(incoming) else { return nil }

        if let index = duplicateIndex(for: incoming) {
            let existingID = issues[index].id
            observationCounts[existingID, default: 1] += 1
            issues[index].updatedAt = incoming.updatedAt
            if issues[index].evidence.worldPoint == nil {
                issues[index].evidence.worldPoint = incoming.evidence.worldPoint
                issues[index].worldTransform = incoming.worldTransform
            }
            if issues[index].source != incoming.source {
                issues[index].source = .fused
            }
            if let confidence = incoming.confidence {
                issues[index].confidence = max(issues[index].confidence ?? 0, confidence)
            }
            if observationCounts[existingID, default: 1] >= configuration.stableObservationCount,
               !issues[index].needsManualCheck {
                issues[index].state = .confirmed
            }
            return issues[index]
        }

        issues.append(incoming)
        observationCounts[incoming.id] = 1
        return incoming
    }

    public mutating func setState(id: UUID, state: IssueState, at date: Date = Date()) {
        guard let index = issues.firstIndex(where: { $0.id == id }) else { return }
        issues[index].state = state
        issues[index].updatedAt = date
        if state == .dismissed {
            dismissedKeys.insert(dismissalKey(for: issues[index]))
        }
    }

    public func reportIssues() -> [SafetyIssue] {
        issues
            .filter { $0.state != .dismissed }
            .sorted {
                if $0.severity.sortOrder != $1.severity.sortOrder {
                    return $0.severity.sortOrder < $1.severity.sortOrder
                }
                return $0.createdAt < $1.createdAt
            }
    }

    private func duplicateIndex(for incoming: SafetyIssue) -> Int? {
        issues.firstIndex { existing in
            guard existing.type == incoming.type, existing.state != .dismissed,
                  existing.evidence.zoneID == incoming.evidence.zoneID else { return false }
            switch (existing.evidence.worldPoint, incoming.evidence.worldPoint) {
            case let (.some(lhs), .some(rhs)):
                return lhs.distance(to: rhs) < configuration.duplicateDistanceMeters
            case (.none, .none):
                if incoming.type == .lowLighting { return true }
                return existing.evidence.frameID == incoming.evidence.frameID &&
                    existing.evidence.boundingBox == incoming.evidence.boundingBox
            default:
                return false
            }
        }
    }

    private func dismissalKey(for issue: SafetyIssue) -> String {
        guard let point = issue.evidence.worldPoint else {
            return "\(issue.evidence.zoneID ?? "none"):\(issue.type.rawValue):\(issue.evidence.frameID?.uuidString ?? "evidence")"
        }
        let grid = configuration.duplicateDistanceMeters
        return "\(issue.evidence.zoneID ?? "none"):\(issue.type.rawValue):\(Int((point.x / grid).rounded())):\(Int((point.y / grid).rounded())):\(Int((point.z / grid).rounded()))"
    }

    private func isDismissedDuplicate(_ incoming: SafetyIssue) -> Bool {
        issues.contains { existing in
            guard existing.state == .dismissed, existing.type == incoming.type,
                  existing.evidence.zoneID == incoming.evidence.zoneID else { return false }
            switch (existing.evidence.worldPoint, incoming.evidence.worldPoint) {
            case let (.some(lhs), .some(rhs)):
                return lhs.distance(to: rhs) < configuration.duplicateDistanceMeters
            case (.none, .none):
                if incoming.type == .lowLighting { return true }
                return existing.evidence.frameID == incoming.evidence.frameID &&
                    existing.evidence.boundingBox == incoming.evidence.boundingBox
            default:
                return false
            }
        }
    }
}
