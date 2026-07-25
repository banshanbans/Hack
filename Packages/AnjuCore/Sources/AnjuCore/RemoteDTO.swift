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

public enum VenueZone: String, Codable, CaseIterable, Sendable {
    case entrance
    case mainAisle = "main_aisle"
    case booth
    case restArea = "rest_area"
}

public enum CandidateReviewStatus: String, Codable, Sendable {
    case confirmed, rejected, merged
    case regionCorrected = "region_corrected"
    case manualCheck = "manual_check"
}

public struct FairTurboResponseDTO: Codable, Equatable, Sendable {
    public let frameID: UUID
    public let zoneID: VenueZone
    public let candidates: [FairTurboCandidateDTO]
    public let promptVersion: String

    enum CodingKeys: String, CodingKey {
        case frameID = "frame_id", zoneID = "zone_id", candidates
        case promptVersion = "prompt_version"
    }
}

public struct FairTurboCandidateDTO: Codable, Equatable, Sendable {
    public let candidateID: UUID
    public let frameID: UUID
    public let zoneID: VenueZone
    public let riskCode: String
    public let boundingBox: [Double]
    public let evidence: String
    public let confidence: Float
    public let needsManualCheck: Bool

    enum CodingKeys: String, CodingKey {
        case candidateID = "candidate_id", frameID = "frame_id", zoneID = "zone_id"
        case riskCode = "risk_code", boundingBox = "bbox", evidence, confidence
        case needsManualCheck = "needs_manual_check"
    }

    public func validatedCandidate() -> IssueCandidate? {
        guard let type = SafetyIssueType(rawValue: riskCode),
              let box = NormalizedBoundingBox(array: boundingBox),
              (0...1).contains(confidence), !evidence.isEmpty, evidence.count <= 240 else { return nil }
        return IssueCandidate(
            type: type, observation: evidence, needsManualCheck: needsManualCheck,
            confidence: confidence, source: .remoteVision,
            evidence: .init(frameID: frameID, boundingBox: box, zoneID: zoneID.rawValue)
        )
    }
}

public struct FairScanReportDTO: Codable, Equatable, Sendable {
    public let scanID: UUID
    public let status: String
    public let assessedAreaScore: Int?
    public let coveragePercent: Int
    public let zones: [FairZoneResultDTO]
    public let budget: FairBudgetDTO
    public let promptVersion: String

    enum CodingKeys: String, CodingKey {
        case scanID = "scan_id", status, zones, budget
        case assessedAreaScore = "assessed_area_score"
        case coveragePercent = "coverage_percent"
        case promptVersion = "prompt_version"
    }
}

public struct FairZoneResultDTO: Codable, Equatable, Sendable {
    public let zoneID: VenueZone
    public let score: Int?
    public let risks: [FairReviewedRiskDTO]
    enum CodingKeys: String, CodingKey { case zoneID = "zone_id", score, risks }
}

public struct FairReviewedRiskDTO: Codable, Equatable, Sendable {
    public let candidateID: UUID
    public let frameID: UUID
    public let riskCode: String
    public let status: CandidateReviewStatus
    public let severity: String
    public let evidence: String
    public let boundingBox: [Double]?
    public let solutions: [FairSolutionDTO]
    enum CodingKeys: String, CodingKey {
        case candidateID = "candidate_id", frameID = "frame_id", riskCode = "risk_code", status, severity, evidence
        case boundingBox = "bbox", solutions
    }
}

public struct FairSolutionDTO: Codable, Equatable, Sendable {
    public let tier: String
    public let title: String
    public let totalMin: Int
    public let totalMax: Int
    enum CodingKeys: String, CodingKey { case tier, title, totalMin = "total_min", totalMax = "total_max" }
}

public struct FairBudgetDTO: Codable, Equatable, Sendable {
    public let currency: String
    public let totalMin: Int
    public let totalMax: Int
    enum CodingKeys: String, CodingKey { case currency, totalMin = "total_min", totalMax = "total_max" }
}
