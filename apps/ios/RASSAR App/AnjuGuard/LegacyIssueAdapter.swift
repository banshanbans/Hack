import AnjuCore
import Foundation
import simd

enum LegacyIssueAdapter {
    static func candidate(from issue: AccessibilityIssue) -> IssueCandidate? {
        guard issue.hasPosition() else { return nil }
        let source = issue.getSource()
        guard isExplicitMissingGrabBar(issue: issue, source: source) else { return nil }

        let position = issue.getPosition()
        let point = WorldPoint(x: position.x, y: position.y, z: position.z)
        let transform = issue.transform ?? source.SourceDetectedObject?.transform ?? source.SourceRoomplanObject?.transform ?? source.SourceRoomplanSurface?.transform
        let matrix = transform.flatMap(matrix4x4)
        return IssueCandidate(
            type: .missingGrabBar,
            needsManualCheck: true,
            source: .fused,
            evidence: IssueEvidence(
                roomObjectID: source.SourceRoomplanObject?.identifier,
                roomSurfaceID: source.SourceRoomplanSurface?.identifier,
                worldPoint: point,
                measurementStatus: .unavailable
            ),
            worldTransform: matrix
        )
    }

    /// Legacy RASSAR dimensions and object categories do not imply the new product risks.
    /// Only the explicit "grab bar absent near a toilet or bathtub" rubric is retained;
    /// everything else needs purpose-built evidence before it can become a SafetyIssue.
    private static func isExplicitMissingGrabBar(
        issue: AccessibilityIssue,
        source: (
            SourceDetectedObject: DetectedObject?,
            SourceRoomplanObject: RoomObjectAnchor?,
            SourceRoomplanSurface: RoomSurfaceAnchor?
        )
    ) -> Bool {
        guard issue.category == .NonExist,
              issue.rubric.requirement == "ExistenceOrNot",
              issue.rubric.keywordMainPart.caseInsensitiveCompare("GrabBar") == .orderedSame,
              let roomObject = source.SourceRoomplanObject else { return false }
        return roomObject.category == .toilet || roomObject.category == .bathtub
    }

    static func translationMatrix(for point: WorldPoint) -> Matrix4x4Codable? {
        Matrix4x4Codable(values: [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            point.x, point.y, point.z, 1
        ])
    }

    private static func matrix4x4(_ matrix: simd_float4x4) -> Matrix4x4Codable? {
        Matrix4x4Codable(values: [
            matrix.columns.0.x, matrix.columns.0.y, matrix.columns.0.z, matrix.columns.0.w,
            matrix.columns.1.x, matrix.columns.1.y, matrix.columns.1.z, matrix.columns.1.w,
            matrix.columns.2.x, matrix.columns.2.y, matrix.columns.2.z, matrix.columns.2.w,
            matrix.columns.3.x, matrix.columns.3.y, matrix.columns.3.z, matrix.columns.3.w
        ])
    }
}
