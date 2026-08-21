import Foundation

public struct RemoteAnalysisResponseDTO: Codable, Equatable, Sendable {
    public let frameID: UUID
    public let issues: [RemoteIssueDTO]

    public init(frameID: UUID, issues: [RemoteIssueDTO]) {
        self.frameID = frameID
        self.issues = issues
    }

    enum CodingKeys: String, CodingKey {
        case frameID = "frame_id"
        case issues
    }
}

public struct RemoteIssueDTO: Codable, Equatable, Sendable {
    public let type: String
    public let boundingBox: [Double]
    public let title: String
    public let observation: String
    public let recommendation: String
    public let needsManualCheck: Bool
    public let confidence: Float?
    public let ruleIDs: [String]

    public init(
        type: String,
        boundingBox: [Double],
        title: String,
        observation: String,
        recommendation: String,
        needsManualCheck: Bool,
        confidence: Float?,
        ruleIDs: [String]
    ) {
        self.type = type
        self.boundingBox = boundingBox
        self.title = title
        self.observation = observation
        self.recommendation = recommendation
        self.needsManualCheck = needsManualCheck
        self.confidence = confidence
        self.ruleIDs = ruleIDs
    }

    enum CodingKeys: String, CodingKey {
        case type, title, observation, recommendation, confidence
        case boundingBox = "bbox"
        case needsManualCheck = "needs_manual_check"
        case ruleIDs = "rule_ids"
    }

    public func validatedCandidate(frameID: UUID) -> IssueCandidate? {
        guard let type = SafetyIssueType(rawValue: type),
              let box = NormalizedBoundingBox(array: boundingBox),
              title.count <= 80,
              observation.count <= 240,
              recommendation.count <= 160 else { return nil }
        return IssueCandidate(
            type: type,
            title: title,
            observation: observation,
            recommendation: recommendation,
            needsManualCheck: needsManualCheck,
            confidence: confidence,
            source: .remoteVision,
            evidence: IssueEvidence(frameID: frameID, boundingBox: box)
        )
    }
}
