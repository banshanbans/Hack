import XCTest
@testable import AnjuCore

final class AnjuCoreTests: XCTestCase {
    func testFrameContextStoreKeepsEightAndNeverEvictsLockedFrames() async throws {
        let store = FrameContextStore()
        var frameIDs: [UUID] = []
        for index in 0..<8 {
            let value = try makeStoredFrameContext(timestamp: Double(index))
            frameIDs.append(value.context.frameID)
            let inserted = await store.insert(value)
            XCTAssertTrue(inserted)
        }
        let initialCount = await store.count
        let locked = await store.lock(frameID: frameIDs[0], inspectionID: "inspection-1")
        XCTAssertEqual(initialCount, 8)
        XCTAssertTrue(locked)

        let ninth = try makeStoredFrameContext(timestamp: 9)
        let insertedNinth = await store.insert(ninth)
        let lockedValue = await store.value(for: frameIDs[0])
        let evictedValue = await store.value(for: frameIDs[1])
        let finalCount = await store.count
        XCTAssertTrue(insertedNinth)
        XCTAssertNotNil(lockedValue)
        XCTAssertNil(evictedValue)
        XCTAssertEqual(finalCount, 8)
    }

    func testFrameContextStoreRejectsNinthWhenAllContextsAreLocked() async throws {
        let store = FrameContextStore()
        for index in 0..<8 {
            let value = try makeStoredFrameContext(timestamp: Double(index))
            let inserted = await store.insert(value)
            let locked = await store.lock(
                frameID: value.context.frameID,
                inspectionID: "inspection-\(index)"
            )
            XCTAssertTrue(inserted)
            XCTAssertTrue(locked)
        }

        let ninth = try makeStoredFrameContext(timestamp: 9)
        let insertedNinth = await store.insert(ninth)
        let count = await store.count
        let lockedCount = await store.lockedCount
        XCTAssertFalse(insertedNinth)
        XCTAssertEqual(count, 8)
        XCTAssertEqual(lockedCount, 8)
    }

    func testFrameContextStoreRequiresInspectionAndFrameMatch() async throws {
        let store = FrameContextStore()
        let first = try makeStoredFrameContext(timestamp: 1)
        let second = try makeStoredFrameContext(timestamp: 2)
        let insertedFirst = await store.insert(first)
        let insertedSecond = await store.insert(second)
        let locked = await store.lock(frameID: first.context.frameID, inspectionID: "inspection-1")
        let matching = await store.value(
            inspectionID: "inspection-1",
            expectedFrameID: first.context.frameID
        )
        let mismatching = await store.value(
            inspectionID: "inspection-1",
            expectedFrameID: second.context.frameID
        )
        let unlocked = await store.unlock(inspectionID: "inspection-1", removeContext: true)
        let removed = await store.value(for: first.context.frameID)
        XCTAssertTrue(insertedFirst)
        XCTAssertTrue(insertedSecond)
        XCTAssertTrue(locked)
        XCTAssertNotNil(matching)
        XCTAssertNil(mismatching)
        XCTAssertTrue(unlocked)
        XCTAssertNil(removed)
    }

    func testNativeRealtimeVideoPolicyThrottlesAndDowngradesWeakNetwork() {
        XCTAssertFalse(NativeRealtimeVideoPolicy.permitsVideoFrame(previousTimestamp: 1, timestamp: 1.03))
        XCTAssertTrue(NativeRealtimeVideoPolicy.permitsVideoFrame(previousTimestamp: 1, timestamp: 1.08))
        XCTAssertEqual(NativeRealtimeVideoPolicy.encoderLongEdge(uplinkQualityRawValue: 3), 720)
        XCTAssertEqual(NativeRealtimeVideoPolicy.encoderLongEdge(uplinkQualityRawValue: 4), 540)
        XCTAssertEqual(NativeRealtimeVideoPolicy.maximumCachedFrames, 8)
        XCTAssertEqual(NativeRealtimeVideoPolicy.maximumCacheBytes, 24 * 1024 * 1024)
        XCTAssertEqual(NativeRTCVideoProfile.degraded.framesPerSecond, 10)
        XCTAssertEqual(NativeRTCVideoProfile.degraded.maximumBitrateKbps, 500)
    }

    func testRTCVideoAdaptiveStateDegradesForEachPressureSignal() {
        var network = NativeRTCVideoAdaptiveState()
        XCTAssertEqual(network.updateNetwork(quality: 4, timestamp: 1)?.profile, .degraded)

        var thermal = NativeRTCVideoAdaptiveState()
        let thermalTransition = thermal.updateThermal(level: .serious, timestamp: 1)
        XCTAssertEqual(thermalTransition?.profile, .degraded)
        XCTAssertTrue(thermalTransition?.reasons.contains(.thermal) == true)

        var frameRate = NativeRTCVideoAdaptiveState()
        XCTAssertNil(frameRate.updateARFrameRate(average: 23, timestamp: 3))
        XCTAssertEqual(frameRate.updateARFrameRate(average: 22, timestamp: 6)?.profile, .degraded)
    }

    func testRTCVideoAdaptiveStateNeedsAllSignalsHealthyForTenSeconds() {
        var state = NativeRTCVideoAdaptiveState()
        _ = state.updateNetwork(quality: 4, timestamp: 0)
        _ = state.updateARFrameRate(average: 28, timestamp: 1)
        XCTAssertNil(state.updateNetwork(quality: 2, timestamp: 2))
        XCTAssertNil(state.updateARFrameRate(average: 28, timestamp: 9))
        XCTAssertEqual(state.updateARFrameRate(average: 28, timestamp: 11)?.profile, .normal)

        _ = state.updateThermal(level: .critical, timestamp: 12)
        XCTAssertEqual(state.profile, .degraded)
        XCTAssertNil(state.updateARFrameRate(average: 30, timestamp: 25))
        XCTAssertEqual(state.updateThermal(level: .fair, timestamp: 26)?.profile, .normal)
    }

    private func makeStoredFrameContext(timestamp: TimeInterval) throws -> StoredFrameContext {
        let transform = try XCTUnwrap(Matrix4x4Codable(values: [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
        ]))
        return StoredFrameContext(
            context: CapturedFrameContext(
                frameID: UUID(),
                timestamp: timestamp,
                cameraTransform: transform,
                intrinsics: .init(fx: 1, fy: 1, cx: 0, cy: 0),
                imageWidth: 2,
                imageHeight: 2,
                orientationRawValue: 1
            ),
            depth: DepthGrid(width: 1, height: 1, values: [1])
        )
    }

    func testNativeRepresentativeSelectionPinsDeduplicatesAndCapsAtSix() {
        let values = [
            NativeRepresentativeCandidate(
                id: "normal", perceptualHash: 0b11110000, pinned: false,
                confidence: 0.9, brightness: 128, sharpness: 20
            ),
            NativeRepresentativeCandidate(
                id: "pinned", perceptualHash: 0b00001111, pinned: true,
                confidence: 0.7, brightness: 120, sharpness: 16
            ),
            NativeRepresentativeCandidate(
                id: "duplicate-of-pinned", perceptualHash: 0b00001110, pinned: false,
                confidence: 0.95, brightness: 128, sharpness: 30
            ),
            NativeRepresentativeCandidate(
                id: "third", perceptualHash: 0b11111111, pinned: false,
                confidence: 0.4, brightness: 130, sharpness: 12
            ),
        ]
        XCTAssertEqual(
            NativeRealtimeVideoPolicy.selectRepresentativeIDs(values, limit: 6),
            ["pinned", "normal", "third"]
        )
        XCTAssertEqual(NativeRealtimeVideoPolicy.selectRepresentativeIDs(values, limit: 1), ["pinned"])
        XCTAssertEqual(NativeRealtimeVideoPolicy.selectRepresentativeIDs(values, limit: 0), [])
    }

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

    func testNativeBridgeRequestValidatesVersionRoomAndSlots() throws {
        let requestID = UUID().uuidString
        let assessmentID = UUID().uuidString
        let roomID = UUID().uuidString
        let cameraSessionID = UUID().uuidString
        let advisorSessionID = UUID().uuidString
        let valid = """
        {
          "bridge_version": 1,
          "command": "start_live_scan",
          "request_id": "\(requestID)",
          "assessment_id": "\(assessmentID)",
          "access_token": "memory-only-token",
          "room_id": "\(roomID)",
          "room_type": "bathroom",
          "remaining_slots": 4,
          "camera_session_id": "\(cameraSessionID)",
          "advisor_session_id": "\(advisorSessionID)",
          "advisor_events": {
            "websocket_path": "/api/v2/assessments/\(assessmentID)/rooms/\(roomID)/advisor/sessions/\(advisorSessionID)/events",
            "token": "one-time-event-token",
            "expires_at": "2026-08-08T10:02:00Z"
          }
        }
        """
        let decoded = try JSONDecoder().decode(NativeCaptureRequest.self, from: Data(valid.utf8))

        XCTAssertTrue(decoded.isValid)
        XCTAssertEqual(decoded.command, .startLiveScan)
        XCTAssertEqual(decoded.cameraSessionID, cameraSessionID)
        XCTAssertEqual(decoded.advisorSessionID, advisorSessionID)
        XCTAssertTrue(decoded.advisorEvents?.isValid == true)

        let invalidRoom = valid.replacingOccurrences(of: "bathroom", with: "venue_booth")
        XCTAssertFalse(try JSONDecoder().decode(
            NativeCaptureRequest.self,
            from: Data(invalidRoom.utf8)
        ).isValid)
        let invalidVersion = valid.replacingOccurrences(of: "\"bridge_version\": 1", with: "\"bridge_version\": 2")
        XCTAssertFalse(try JSONDecoder().decode(
            NativeCaptureRequest.self,
            from: Data(invalidVersion.utf8)
        ).isValid)
    }

    func testNativeBridgeResultNeverEchoesAccessToken() throws {
        let result = NativeCaptureResult(
            requestID: UUID().uuidString,
            status: "partial",
            roomID: UUID().uuidString,
            captureMode: "camera_2d",
            uploadedMediaIDs: [UUID().uuidString],
            failedCount: 1,
            errorCode: "frame_upload_partial",
            cameraSessionID: UUID().uuidString
        )
        let json = String(decoding: try JSONEncoder().encode(result), as: UTF8.self)

        XCTAssertFalse(json.contains("access_token"))
        XCTAssertFalse(json.contains("memory-only-token"))
        XCTAssertTrue(json.contains("uploaded_media_ids"))
        XCTAssertTrue(json.contains("camera_session_id"))
    }

    func testNativeFrameSelectionPolicyBoundariesAreStable() {
        let policy = NativeFrameSelectionPolicy.homeCamera

        XCTAssertTrue(policy.acceptsQuality(brightness: 28, sharpness: 5))
        XCTAssertTrue(policy.acceptsQuality(brightness: 232, sharpness: 5))
        XCTAssertFalse(policy.acceptsQuality(brightness: 27.99, sharpness: 5))
        XCTAssertFalse(policy.acceptsQuality(brightness: 100, sharpness: 4.99))
        XCTAssertFalse(policy.acceptsPerceptualHash(previous: 0, current: 0b1_1111))
        XCTAssertTrue(policy.acceptsPerceptualHash(previous: 0, current: 0b11_1111))
        XCTAssertTrue(policy.permitsModelRequest(elapsed: 5, completedRequests: 29))
        XCTAssertFalse(policy.permitsModelRequest(elapsed: 4.99, completedRequests: 29))
        XCTAssertFalse(policy.permitsModelRequest(elapsed: 5, completedRequests: 30))
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
