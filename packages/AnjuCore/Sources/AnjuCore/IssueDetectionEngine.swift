import Foundation

public struct IssueCandidate: Equatable, Sendable {
    public let type: SafetyIssueType
    public let title: String?
    public let observation: String?
    public let recommendation: String?
    public let needsManualCheck: Bool
    public let confidence: Float?
    public let source: IssueSource
    public let evidence: IssueEvidence
    public let worldTransform: Matrix4x4Codable?

    public init(
        type: SafetyIssueType,
        title: String? = nil,
        observation: String? = nil,
        recommendation: String? = nil,
        needsManualCheck: Bool = false,
        confidence: Float? = nil,
        source: IssueSource,
        evidence: IssueEvidence,
        worldTransform: Matrix4x4Codable? = nil
    ) {
        self.type = type
        self.title = title
        self.observation = observation
        self.recommendation = recommendation
        self.needsManualCheck = needsManualCheck
        self.confidence = confidence
        self.source = source
        self.evidence = evidence
        self.worldTransform = worldTransform
    }
}

public struct IssueDetectionEngine: Sendable {
    private let ruleStore: SafetyRuleStore

    public init(ruleStore: SafetyRuleStore) {
        self.ruleStore = ruleStore
    }

    /// Risk severity is always sourced from the validated local rule.
    public func makeIssue(
        from candidate: IssueCandidate,
        sessionID: UUID,
        roomType: String? = nil,
        profiles: Set<String> = [],
        now: Date = Date()
    ) -> SafetyIssue? {
        guard candidate.evidence.hasTraceableEvidence,
              let rule = ruleStore.rule(
                for: candidate.type,
                roomType: roomType,
                profiles: profiles
              ) else { return nil }

        let manualCheck = candidate.needsManualCheck || rule.needsManualCheck || candidate.evidence.worldPoint == nil
        return SafetyIssue(
            sessionID: sessionID,
            type: candidate.type,
            state: manualCheck ? .tentative : .confirmed,
            severity: manualCheck && rule.severity == .high ? .check : rule.severity,
            title: Self.safeText(candidate.title, fallback: rule.title, limit: 18),
            observation: Self.safeText(candidate.observation, fallback: rule.reason, limit: 80),
            recommendation: Self.safeText(candidate.recommendation, fallback: rule.primaryAction, limit: 36),
            needsManualCheck: manualCheck,
            source: candidate.source,
            evidence: candidate.evidence,
            worldTransform: candidate.worldTransform,
            confidence: candidate.confidence,
            createdAt: now,
            updatedAt: now
        )
    }

    private static func safeText(_ candidate: String?, fallback: String, limit: Int) -> String {
        let value = candidate?.trimmingCharacters(in: .whitespacesAndNewlines)
        let selected = value.flatMap { $0.isEmpty ? nil : $0 } ?? fallback
        return String(selected.prefix(limit))
    }
}
