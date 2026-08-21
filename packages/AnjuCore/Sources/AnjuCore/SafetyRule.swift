import Foundation

public struct RuleSource: Codable, Equatable, Sendable {
    public let name: String
    public let url: URL?

    public init(name: String, url: URL?) {
        self.name = name
        self.url = url
    }
}

public struct SafetyRule: Codable, Equatable, Sendable {
    public let id: String
    public let type: SafetyIssueType
    public let roomTypes: [String]
    public let profiles: [String]
    public let title: String
    public let evidenceRequired: [String]
    public let severity: Severity
    public let reason: String
    public let primaryAction: String
    public let manualChecks: [String]
    public let needsManualCheck: Bool
    public let source: RuleSource

    public init(
        id: String,
        type: SafetyIssueType,
        roomTypes: [String],
        profiles: [String],
        title: String,
        evidenceRequired: [String],
        severity: Severity,
        reason: String,
        primaryAction: String,
        manualChecks: [String],
        needsManualCheck: Bool,
        source: RuleSource
    ) {
        self.id = id
        self.type = type
        self.roomTypes = roomTypes
        self.profiles = profiles
        self.title = title
        self.evidenceRequired = evidenceRequired
        self.severity = severity
        self.reason = reason
        self.primaryAction = primaryAction
        self.manualChecks = manualChecks
        self.needsManualCheck = needsManualCheck
        self.source = source
    }

    enum CodingKeys: String, CodingKey {
        case id, type, title, severity, reason, source
        case roomTypes = "room_types"
        case profiles
        case evidenceRequired = "evidence_required"
        case primaryAction = "primary_action"
        case manualChecks = "manual_checks"
        case needsManualCheck = "needs_manual_check"
    }
}

public enum SafetyRuleStoreError: Error, Equatable {
    case invalidData
    case noRules
}

public struct SafetyRuleStore: Sendable {
    public let rules: [SafetyRule]

    public init(data: Data) throws {
        guard let decoded = try? JSONDecoder().decode([SafetyRule].self, from: data) else {
            throw SafetyRuleStoreError.invalidData
        }
        guard !decoded.isEmpty else { throw SafetyRuleStoreError.noRules }
        rules = decoded
    }

    public init(rules: [SafetyRule]) throws {
        guard !rules.isEmpty else { throw SafetyRuleStoreError.noRules }
        self.rules = rules
    }

    public init(requiredRule: SafetyRule, additionalRules: [SafetyRule] = []) {
        rules = [requiredRule] + additionalRules
    }

    public func rule(
        for type: SafetyIssueType,
        roomType: String? = nil,
        profiles: Set<String> = []
    ) -> SafetyRule? {
        rules.first { rule in
            guard rule.type == type else { return false }
            let roomMatches = roomType.map { rule.roomTypes.isEmpty || rule.roomTypes.contains($0) } ?? true
            let profileMatches = profiles.isEmpty || rule.profiles.isEmpty || !profiles.isDisjoint(with: rule.profiles)
            return roomMatches && profileMatches
        }
    }

    public func applicableRules(roomType: String?, profiles: Set<String>) -> [SafetyRule] {
        rules.filter { rule in
            let roomMatches = roomType.map { rule.roomTypes.isEmpty || rule.roomTypes.contains($0) } ?? true
            let profileMatches = profiles.isEmpty || rule.profiles.isEmpty || !profiles.isDisjoint(with: rule.profiles)
            return roomMatches && profileMatches
        }
    }
}
