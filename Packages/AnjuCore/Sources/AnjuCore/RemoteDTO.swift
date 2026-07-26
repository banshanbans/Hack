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

public struct FairDirectResponseDTO: Codable, Equatable, Sendable {
    public let frameID: UUID
    public let zoneID: VenueZone
    public let candidates: [FairDirectCandidateDTO]
    public let promptVersion: String

    enum CodingKeys: String, CodingKey {
        case frameID = "frame_id", zoneID = "zone_id", candidates
        case promptVersion = "prompt_version"
    }
}

public struct FairDirectCandidateDTO: Codable, Equatable, Sendable {
    public let candidateID: UUID
    public let frameID: UUID
    public let zoneID: VenueZone
    public let riskCode: String
    public let title: String?
    public let shortAdvice: String?
    public let boundingBox: [Double]
    public let evidence: String
    public let confidence: Float
    public let needsManualCheck: Bool
    public let evidenceCodes: [String]

    enum CodingKeys: String, CodingKey {
        case candidateID = "candidate_id", frameID = "frame_id", zoneID = "zone_id"
        case riskCode = "risk_code", title, shortAdvice = "short_advice", boundingBox = "bbox", evidence, confidence
        case needsManualCheck = "needs_manual_check", evidenceCodes = "evidence_codes"
    }

    public func validatedCandidate() -> IssueCandidate? {
        guard let type = SafetyIssueType(rawValue: riskCode),
              let box = NormalizedBoundingBox(array: boundingBox),
              (0...1).contains(confidence), !evidence.isEmpty, evidence.count <= 240 else { return nil }
        return IssueCandidate(
            type: type, title: title, observation: evidence, recommendation: shortAdvice,
            needsManualCheck: needsManualCheck,
            confidence: confidence, source: .remoteVision,
            evidence: .init(frameID: frameID, boundingBox: box, zoneID: zoneID.rawValue)
        )
    }
}

public struct FairDirectAdapter: Sendable {
    public init() {}

    public func temporaryIssue(from candidate: IssueCandidate, sessionID: UUID) -> SafetyIssue? {
        guard candidate.evidence.hasTraceableEvidence else { return nil }
        return SafetyIssue(
            sessionID: sessionID, type: candidate.type, state: .tentative, severity: .check,
            title: String((candidate.title ?? candidate.type.rawValue).prefix(18)),
            observation: String((candidate.observation ?? "需要继续复核的画面候选").prefix(80)),
            recommendation: String((candidate.recommendation ?? "继续扫描，结束后由 AI 复核").prefix(36)),
            needsManualCheck: true, source: .remoteVision, evidence: candidate.evidence,
            worldTransform: candidate.worldTransform, confidence: candidate.confidence
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
    public let ruleVersion: String?

    enum CodingKeys: String, CodingKey {
        case scanID = "scan_id", status, zones, budget
        case assessedAreaScore = "assessed_area_score"
        case coveragePercent = "coverage_percent"
        case promptVersion = "prompt_version"
        case ruleVersion = "rule_version"
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
    public let title: String?
    public let shortAdvice: String?
    public let evidenceFrameIDs: [UUID]?
    public let ruleVersion: String?
    public let scoreEligible: Bool?
    public let boundingBox: [Double]?
    public let solutions: [FairSolutionDTO]
    enum CodingKeys: String, CodingKey {
        case candidateID = "candidate_id", frameID = "frame_id", riskCode = "risk_code", status, severity, evidence
        case boundingBox = "bbox", solutions, title, shortAdvice = "short_advice"
        case evidenceFrameIDs = "evidence_frame_ids", ruleVersion = "rule_version", scoreEligible = "score_eligible"
    }
}

public struct FairSolutionDTO: Codable, Equatable, Sendable {
    public let tier: String
    public let title: String
    public let totalMin: Int
    public let totalMax: Int
    public let priceRuleID: String?
    public let currency: String?
    enum CodingKeys: String, CodingKey {
        case tier, title, totalMin = "total_min", totalMax = "total_max"
        case priceRuleID = "price_rule_id", currency
    }
}

public struct FairBudgetDTO: Codable, Equatable, Sendable {
    public let currency: String
    public let totalMin: Int
    public let totalMax: Int
    enum CodingKeys: String, CodingKey { case currency, totalMin = "total_min", totalMax = "total_max" }
}

public enum FairReportValidationError: Error, Equatable, Sendable {
    case invalidReport
    case invalidRisk(String)
}

public struct FairReportAdapter: Sendable {
    private static let venueRiskTypes: Set<SafetyIssueType> = [
        .floorClutter, .cableCrossing, .narrowPath, .looseRug, .unstableSupport, .lowLighting,
        .sharpCorner, .wetFloor, .levelChange, .crowdedPath, .markedExitObstruction, .lowHangingObstruction,
    ]

    public init() {}

    public func validatedIssues(
        report: FairScanReportDTO,
        sessionID: UUID,
        preserving spatialIssues: [SafetyIssue]
    ) throws -> [SafetyIssue] {
        guard ["reviewed", "partial_review_failed"].contains(report.status),
              (0...100).contains(report.coveragePercent),
              report.assessedAreaScore.map({ (0...100).contains($0) }) ?? true,
              report.budget.currency == "CNY", report.budget.totalMin >= 0,
              report.budget.totalMin <= report.budget.totalMax,
              !(report.ruleVersion?.isEmpty ?? false) else {
            throw FairReportValidationError.invalidReport
        }
        if report.status == "partial_review_failed", report.assessedAreaScore != nil {
            throw FairReportValidationError.invalidReport
        }
        let budgetRisks = report.zones.flatMap(\.risks).filter {
            $0.scoreEligible ?? [.confirmed, .regionCorrected].contains($0.status)
        }
        let expectedBudgetMin = budgetRisks.reduce(0) { $0 + ($1.solutions.count == 3 ? $1.solutions[1].totalMin : 0) }
        let expectedBudgetMax = budgetRisks.reduce(0) { $0 + ($1.solutions.count == 3 ? $1.solutions[1].totalMax : 0) }
        guard report.budget.totalMin == expectedBudgetMin, report.budget.totalMax == expectedBudgetMax else {
            throw FairReportValidationError.invalidReport
        }
        return try report.zones.flatMap { zone in
            guard zone.score.map({ (0...100).contains($0) }) ?? true else {
                throw FairReportValidationError.invalidReport
            }
            return try zone.risks.map { reviewed in
                try validatedIssue(reviewed, zone: zone.zoneID, sessionID: sessionID, preserving: spatialIssues)
            }
        }
    }

    private func validatedIssue(
        _ reviewed: FairReviewedRiskDTO,
        zone: VenueZone,
        sessionID: UUID,
        preserving spatialIssues: [SafetyIssue]
    ) throws -> SafetyIssue {
        guard let type = SafetyIssueType(rawValue: reviewed.riskCode), Self.venueRiskTypes.contains(type),
              ![.rejected, .merged].contains(reviewed.status),
              let boxValues = reviewed.boundingBox, let box = NormalizedBoundingBox(array: boxValues),
              !reviewed.evidence.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              reviewed.evidence.count <= 240,
              reviewed.solutions.map(\.tier) == ["A", "B", "C"] else {
            throw FairReportValidationError.invalidRisk(reviewed.riskCode)
        }
        let severity: Severity
        switch reviewed.severity {
        case "high": severity = .high
        case "medium": severity = .medium
        case "low", "check": severity = .check
        default: throw FairReportValidationError.invalidRisk(reviewed.riskCode)
        }
        let priceBands = ["A": (0, 80), "B": (80, 500), "C": (500, 3000)]
        guard reviewed.solutions.allSatisfy({ solution in
            guard let band = priceBands[solution.tier] else { return false }
            return !solution.title.isEmpty && solution.totalMin == band.0 && solution.totalMax == band.1 &&
                (solution.currency == nil || solution.currency == "CNY")
        }) else { throw FairReportValidationError.invalidRisk(reviewed.riskCode) }
        let scoreEligible = reviewed.scoreEligible ?? [.confirmed, .regionCorrected].contains(reviewed.status)
        guard !scoreEligible || [.confirmed, .regionCorrected].contains(reviewed.status) else {
            throw FairReportValidationError.invalidRisk(reviewed.riskCode)
        }
        let evidenceFrames = reviewed.evidenceFrameIDs ?? [reviewed.frameID]
        guard evidenceFrames.contains(reviewed.frameID), Set(evidenceFrames).count == evidenceFrames.count,
              !(reviewed.ruleVersion?.isEmpty ?? false) else {
            throw FairReportValidationError.invalidRisk(reviewed.riskCode)
        }
        let spatial = spatialIssues.first { $0.type == type && $0.evidence.frameID == reviewed.frameID }
        var evidence = IssueEvidence(
            frameID: reviewed.frameID, boundingBox: box, zoneID: zone.rawValue,
            worldPoint: spatial?.evidence.worldPoint,
            measurementStatus: spatial?.evidence.measurementStatus ?? .unavailable
        )
        evidence.snapshotFilename = spatial?.evidence.snapshotFilename
        let recommendation = reviewed.shortAdvice ?? reviewed.solutions[1].title
        return SafetyIssue(
            id: reviewed.candidateID, sessionID: sessionID, type: type,
            state: reviewed.status == .manualCheck ? .tentative : .confirmed,
            severity: reviewed.status == .manualCheck ? .check : severity,
            title: reviewed.title ?? reviewed.riskCode,
            observation: reviewed.evidence,
            recommendation: recommendation,
            needsManualCheck: reviewed.status == .manualCheck || !scoreEligible,
            source: .remoteVision, evidence: evidence,
            worldTransform: spatial?.worldTransform
        )
    }
}
