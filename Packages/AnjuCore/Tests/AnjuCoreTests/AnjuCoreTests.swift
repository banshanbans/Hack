import XCTest
@testable import AnjuCore

final class AnjuCoreTests: XCTestCase {
    func testRuleParsingAndRoomFiltering() throws {
        let data = try JSONEncoder().encode([makeRule(type: .looseRug, severity: .high)])
        let store = try SafetyRuleStore(data: data)

        XCTAssertNotNil(store.rule(for: .looseRug, roomType: "bedroom"))
        XCTAssertNil(store.rule(for: .looseRug, roomType: "bathroom"))
    }

    func testRuleSelectionHonorsSelectedProfiles() throws {
        let store = try SafetyRuleStore(rules: [makeRule(type: .looseRug, severity: .high)])

        XCTAssertNotNil(store.rule(
            for: .looseRug,
            roomType: "bedroom",
            profiles: ["older_adult"]
        ))
        XCTAssertNil(store.rule(
            for: .looseRug,
            roomType: "bedroom",
            profiles: ["unrelated_profile"]
        ))
    }

    func testRemoteDTORejectsUnknownTypeAndInvalidBoundingBox() {
        let unknown = makeRemoteDTO(type: "invented_hazard", bbox: [0.1, 0.2, 0.5, 0.8])
        let badBox = makeRemoteDTO(type: "loose_rug", bbox: [0.8, 0.2, 0.2, 0.9])

        XCTAssertNil(unknown.validatedCandidate(frameID: UUID()))
        XCTAssertNil(badBox.validatedCandidate(frameID: UUID()))
    }

    func testFairDirectCandidateCarriesDeterministicCameraCopy() throws {
        let data = Data(#"""
        {
          "candidate_id":"00000000-0000-0000-0000-000000000001",
          "frame_id":"00000000-0000-0000-0000-000000000002",
          "zone_id":"entrance",
          "risk_code":"wet_floor",
          "title":"地面有明显湿滑处",
          "short_advice":"先擦干地面并提醒绕行",
          "evidence_codes":["wet_surface_visible"],
          "bbox":[0.1,0.2,0.7,0.8],
          "evidence":"入口地面可见积水",
          "confidence":0.91,
          "needs_manual_check":false
        }
        """#.utf8)
        let dto = try JSONDecoder().decode(FairDirectCandidateDTO.self, from: data)
        let candidate = try XCTUnwrap(dto.validatedCandidate())

        XCTAssertEqual(candidate.type, .wetFloor)
        XCTAssertEqual(candidate.title, "地面有明显湿滑处")
        XCTAssertEqual(candidate.recommendation, "先擦干地面并提醒绕行")
        let issue = try XCTUnwrap(FairDirectAdapter().temporaryIssue(from: candidate, sessionID: UUID()))
        XCTAssertEqual(issue.severity, .check)
        XCTAssertEqual(issue.state, .tentative)
        XCTAssertTrue(issue.needsManualCheck)
    }

    func testFairReportAdapterPreservesServerCopyAndValidatesFormalRisk() throws {
        let report = try decodeFairReport(riskCode: "marked_exit_obstruction")
        let issues = try FairReportAdapter().validatedIssues(report: report, sessionID: UUID(), preserving: [])

        XCTAssertEqual(issues.count, 1)
        XCTAssertEqual(issues[0].type, .markedExitObstruction)
        XCTAssertEqual(issues[0].severity, .high)
        XCTAssertEqual(issues[0].title, "服务端出口标题")
        XCTAssertEqual(issues[0].recommendation, "服务端短建议")
    }

    func testFairReportAdapterRejectsUnknownRiskCode() throws {
        let report = try decodeFairReport(riskCode: "invented_fair_risk")
        XCTAssertThrowsError(try FairReportAdapter().validatedIssues(report: report, sessionID: UUID(), preserving: []))
    }

    private func decodeFairReport(riskCode: String) throws -> FairScanReportDTO {
        let json = #"""
        {
          "scan_id":"00000000-0000-0000-0000-000000000010","status":"reviewed",
          "assessed_area_score":84,"coverage_percent":25,"prompt_version":"pro-v1",
          "rule_version":"venue-fair-rules-v1",
          "budget":{"currency":"CNY","total_min":80,"total_max":500},
          "zones":[{"zone_id":"entrance","score":84,"risks":[{
            "candidate_id":"00000000-0000-0000-0000-000000000011",
            "frame_id":"00000000-0000-0000-0000-000000000012",
            "risk_code":"\#(riskCode)","status":"confirmed","severity":"high",
            "title":"服务端出口标题","short_advice":"服务端短建议","evidence":"出口标识和障碍均清晰可见",
            "evidence_frame_ids":["00000000-0000-0000-0000-000000000012"],
            "rule_version":"venue-fair-rules-v1","score_eligible":true,"bbox":[0.1,0.2,0.7,0.8],
            "solutions":[
              {"tier":"A","title":"A","total_min":0,"total_max":80,"currency":"CNY","price_rule_id":"A"},
              {"tier":"B","title":"B","total_min":80,"total_max":500,"currency":"CNY","price_rule_id":"B"},
              {"tier":"C","title":"C","total_min":500,"total_max":3000,"currency":"CNY","price_rule_id":"C"}
            ]
          }]}]
        }
        """#
        return try JSONDecoder().decode(FairScanReportDTO.self, from: Data(json.utf8))
    }

    func testSeverityComesFromRuleAndWeakEvidenceDowngradesHigh() throws {
        let store = try SafetyRuleStore(rules: [makeRule(type: .looseRug, severity: .high)])
        let engine = IssueDetectionEngine(ruleStore: store)
        let candidate = makeCandidate(point: nil, manualCheck: false)

        XCTAssertTrue(candidate.evidence.hasTraceableEvidence)
        XCTAssertNotNil(store.rule(for: .looseRug))
        let issue = engine.makeIssue(from: candidate, sessionID: UUID())

        XCTAssertEqual(issue?.severity, .check)
        XCTAssertEqual(issue?.state, .tentative)
        XCTAssertEqual(issue?.needsManualCheck, true)
    }

    func testIssueWithoutEvidenceIsRejected() throws {
        let store = try SafetyRuleStore(rules: [makeRule(type: .looseRug, severity: .high)])
        let engine = IssueDetectionEngine(ruleStore: store)
        let candidate = IssueCandidate(type: .looseRug, source: .remoteVision, evidence: .init())

        XCTAssertNil(engine.makeIssue(from: candidate, sessionID: UUID()))
    }

    func testSpatialDeduplicationPromotesAfterStableObservations() {
        var store = IssueStore(configuration: .init(duplicateDistanceMeters: 0.35, stableObservationCount: 3))
        let sessionID = UUID()
        let first = makeIssue(sessionID: sessionID, point: .init(x: 1, y: 0, z: 1))
        let second = makeIssue(sessionID: sessionID, point: .init(x: 1.1, y: 0, z: 1.1))
        let third = makeIssue(sessionID: sessionID, point: .init(x: 0.95, y: 0, z: 1.05))

        store.observe(first)
        store.observe(second)
        let result = store.observe(third)

        XCTAssertEqual(store.issues.count, 1)
        XCTAssertEqual(result?.id, first.id)
        XCTAssertEqual(result?.state, .confirmed)
    }

    func testObservationsFromDifferentSourcesBecomeFused() {
        var store = IssueStore()
        let sessionID = UUID()
        let local = makeIssue(sessionID: sessionID, point: .init(x: 1, y: 0, z: 1))
        var remote = makeIssue(sessionID: sessionID, point: .init(x: 1.1, y: 0, z: 1.1))
        remote.source = .remoteVision

        store.observe(local)
        let fused = store.observe(remote)

        XCTAssertEqual(fused?.source, .fused)
        XCTAssertEqual(store.issues.count, 1)
    }

    func testSceneWideLowLightingCandidatesDeduplicateAcrossFrames() {
        var store = IssueStore()
        let sessionID = UUID()
        let first = SafetyIssue(
            sessionID: sessionID,
            type: .lowLighting,
            state: .tentative,
            severity: .check,
            title: "这里光线有点暗",
            observation: "通道较暗。",
            recommendation: "增加夜灯。",
            needsManualCheck: true,
            source: .localVision,
            evidence: .init(frameID: UUID(), boundingBox: NormalizedBoundingBox(array: [0, 0, 1, 1]))
        )
        let second = SafetyIssue(
            sessionID: sessionID,
            type: .lowLighting,
            state: .tentative,
            severity: .check,
            title: first.title,
            observation: first.observation,
            recommendation: first.recommendation,
            needsManualCheck: true,
            source: .localVision,
            evidence: .init(frameID: UUID(), boundingBox: NormalizedBoundingBox(array: [0, 0, 1, 1]))
        )

        store.observe(first)
        store.observe(second)

        XCTAssertEqual(store.issues.count, 1)
    }

    func testVenueZonesKeepSceneWideCandidatesIsolated() {
        var store = IssueStore()
        let sessionID = UUID()
        for zone in ["entrance", "booth"] {
            store.observe(SafetyIssue(
                sessionID: sessionID, type: .lowLighting, state: .tentative, severity: .check,
                title: "照明待确认", observation: "区域较暗", recommendation: "补充照明",
                needsManualCheck: true, source: .remoteVision,
                evidence: .init(frameID: UUID(), boundingBox: NormalizedBoundingBox(array: [0, 0, 1, 1]), zoneID: zone)
            ))
        }
        XCTAssertEqual(store.issues.count, 2)
    }

    func testDismissedIssueDoesNotReappearInSession() {
        var store = IssueStore()
        let issue = makeIssue(sessionID: UUID(), point: .init(x: 1, y: 0, z: 1))
        store.observe(issue)
        store.setState(id: issue.id, state: .dismissed)

        let duplicate = makeIssue(sessionID: issue.sessionID, point: .init(x: 1.02, y: 0, z: 1.01))
        XCTAssertNil(store.observe(duplicate))
        XCTAssertTrue(store.reportIssues().isEmpty)
    }

    func testDismissedIssueDoesNotReappearAcrossGridBoundary() {
        var store = IssueStore(configuration: .init(duplicateDistanceMeters: 0.35, stableObservationCount: 3))
        let issue = makeIssue(sessionID: UUID(), point: .init(x: 0.17, y: 0, z: 1))
        store.observe(issue)
        store.setState(id: issue.id, state: .dismissed)

        let duplicate = makeIssue(sessionID: issue.sessionID, point: .init(x: 0.18, y: 0, z: 1))
        XCTAssertNil(store.observe(duplicate))
    }

    func testReportSortingIsStableBySeverityThenDate() {
        var store = IssueStore()
        let start = Date(timeIntervalSince1970: 100)
        let medium = makeIssue(sessionID: UUID(), severity: .medium, createdAt: start)
        let highLate = makeIssue(sessionID: UUID(), severity: .high, createdAt: start.addingTimeInterval(2))
        let highEarly = makeIssue(sessionID: UUID(), severity: .high, createdAt: start.addingTimeInterval(1))
        store.observe(medium)
        store.observe(highLate)
        store.observe(highEarly)

        XCTAssertEqual(store.reportIssues().map(\.id), [highEarly.id, highLate.id, medium.id])
    }

    func testBoundingBoxValidation() {
        XCTAssertNotNil(NormalizedBoundingBox(array: [0, 0.2, 1, 0.9]))
        XCTAssertNil(NormalizedBoundingBox(array: [-0.1, 0.2, 1, 0.9]))
        XCTAssertNil(NormalizedBoundingBox(array: [0.1, 0.2, 0.1, 0.9]))
        XCTAssertNil(NormalizedBoundingBox(array: [0.1, 0.2, 0.9]))
    }

    func testDepthMedianFiltersInvalidAndOutlierValues() {
        let resolver = WorldPointResolver()

        let result = resolver.robustMedian([0, .nan, .infinity, 2, 2.1, 2.05, 7])
        XCTAssertNotNil(result)
        XCTAssertEqual(result ?? 0, 2.05, accuracy: 0.001)
    }

    func testHistoricalDepthBackProjectionUsesFrameTransform() throws {
        let matrix = try XCTUnwrap(Matrix4x4Codable(values: [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            10, 1, -2, 1
        ]))
        let frame = CapturedFrameContext(
            frameID: UUID(),
            timestamp: 1,
            cameraTransform: matrix,
            intrinsics: .init(fx: 100, fy: 100, cx: 50, cy: 50),
            imageWidth: 100,
            imageHeight: 100,
            orientationRawValue: 1
        )
        let depth = try XCTUnwrap(DepthGrid(width: 3, height: 3, values: Array(repeating: 2, count: 9)))
        let box = try XCTUnwrap(NormalizedBoundingBox(array: [0.4, 0.4, 0.6, 0.6]))

        let point = WorldPointResolver(configuration: .init(sampleRadius: 1)).resolve(
            boundingBox: box,
            frame: frame,
            depth: depth
        )

        XCTAssertNotNil(point)
        XCTAssertEqual(point?.x ?? 0, 10, accuracy: 0.001)
        XCTAssertEqual(point?.y ?? 0, 1, accuracy: 0.001)
        XCTAssertEqual(point?.z ?? 0, -4, accuracy: 0.001)
    }

    func testRightOrientedModelCoordinatesMapBackToCapturedImage() throws {
        let modelBox = try XCTUnwrap(NormalizedBoundingBox(array: [0.1, 0.2, 0.3, 0.6]))
        let captured = try XCTUnwrap(ModelImageOrientation.right.capturedImageBox(from: modelBox))
        XCTAssertEqual(captured.array[0], 0.2, accuracy: 0.0001)
        XCTAssertEqual(captured.array[1], 0.7, accuracy: 0.0001)
        XCTAssertEqual(captured.array[2], 0.6, accuracy: 0.0001)
        XCTAssertEqual(captured.array[3], 0.9, accuracy: 0.0001)
    }

    func testCameraMotionGateSuppressesStaticFrames() throws {
        let identity = try XCTUnwrap(Matrix4x4Codable(values: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]))
        let smallMove = try XCTUnwrap(Matrix4x4Codable(values: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.04, 0, 0, 1]))
        let moved = try XCTUnwrap(Matrix4x4Codable(values: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.3, 0, 0, 1]))
        let gate = CameraMotionGate()
        XCTAssertTrue(gate.hasMeaningfulChange(previous: nil, current: identity))
        XCTAssertFalse(gate.hasMeaningfulChange(previous: identity, current: smallMove))
        XCTAssertTrue(gate.hasMeaningfulChange(previous: identity, current: moved))
    }

    func testRemoteSchemaDecoding() throws {
        let frameID = UUID()
        let json = """
        {
          "frame_id": "\(frameID.uuidString)",
          "issues": [{
            "type": "loose_rug",
            "bbox": [0.1, 0.2, 0.8, 0.9],
            "title": "地毯边缘可能绊脚",
            "observation": "地毯位于通道上。",
            "recommendation": "固定四角。",
            "needs_manual_check": true,
            "confidence": 0.8,
            "rule_ids": ["RUG-001"]
          }]
        }
        """

        let response = try JSONDecoder().decode(RemoteAnalysisResponseDTO.self, from: Data(json.utf8))
        XCTAssertEqual(response.frameID, frameID)
        XCTAssertEqual(response.issues.count, 1)
        XCTAssertNotNil(response.issues[0].validatedCandidate(frameID: frameID))
    }

    private func makeRule(type: SafetyIssueType, severity: Severity) -> SafetyRule {
        SafetyRule(
            id: "TEST-001",
            type: type,
            roomTypes: ["bedroom"],
            profiles: ["older_adult"],
            title: "地毯边缘可能绊脚",
            evidenceRequired: ["rug_visible"],
            severity: severity,
            reason: "地毯位于通道上。",
            primaryAction: "固定四角，或移出通道。",
            manualChecks: [],
            needsManualCheck: false,
            source: .init(name: "Test", url: nil)
        )
    }

    private func makeCandidate(point: WorldPoint?, manualCheck: Bool) -> IssueCandidate {
        IssueCandidate(
            type: .looseRug,
            needsManualCheck: manualCheck,
            source: .localVision,
            evidence: .init(
                frameID: UUID(),
                boundingBox: NormalizedBoundingBox(array: [0.1, 0.2, 0.5, 0.8]),
                worldPoint: point
            )
        )
    }

    private func makeRemoteDTO(type: String, bbox: [Double]) -> RemoteIssueDTO {
        RemoteIssueDTO(
            type: type,
            boundingBox: bbox,
            title: "标题",
            observation: "观察",
            recommendation: "建议",
            needsManualCheck: false,
            confidence: nil,
            ruleIDs: []
        )
    }

    private func makeIssue(
        sessionID: UUID,
        point: WorldPoint? = nil,
        severity: Severity = .high,
        createdAt: Date = Date()
    ) -> SafetyIssue {
        SafetyIssue(
            sessionID: sessionID,
            type: .looseRug,
            state: .tentative,
            severity: severity,
            title: "地毯边缘可能绊脚",
            observation: "地毯位于通道上。",
            recommendation: "固定四角。",
            needsManualCheck: false,
            source: .localVision,
            evidence: .init(frameID: UUID(), worldPoint: point),
            createdAt: createdAt,
            updatedAt: createdAt
        )
    }
}
