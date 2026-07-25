import AnjuCore
import RealityKit
import UIKit

@MainActor
final class IssueAnchorStore {
    private weak var arView: ARView?
    private var anchors: [UUID: AnchorEntity] = [:]
    private var hapticsDelivered: Set<UUID> = []

    init(arView: ARView) {
        self.arView = arView
    }

    func synchronize(_ issues: [SafetyIssue]) {
        let activeIDs = Set(issues.filter { $0.state != .dismissed }.map(\.id))
        for (id, anchor) in anchors where !activeIDs.contains(id) {
            anchor.removeFromParent()
            anchors.removeValue(forKey: id)
        }
        for issue in issues where issue.state != .dismissed {
            addIfNeeded(issue)
        }
    }

    private func addIfNeeded(_ issue: SafetyIssue) {
        guard anchors[issue.id] == nil,
              let point = issue.evidence.worldPoint,
              let arView else { return }
        let anchor = AnchorEntity(world: SIMD3<Float>(point.x, point.y, point.z))
        anchor.name = issue.id.uuidString
        let mesh = MeshResource.generateSphere(radius: 0.035)
        let color = AnjuTheme.severityColor(issue.severity)
        let material = SimpleMaterial(color: color, roughness: 0.55, isMetallic: false)
        let pin = ModelEntity(mesh: mesh, materials: [material])
        pin.name = "issue-pin"
        anchor.addChild(pin)
        arView.scene.addAnchor(anchor)
        anchors[issue.id] = anchor

        if issue.severity == .high, hapticsDelivered.insert(issue.id).inserted {
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        }
    }

    func removeAll() {
        anchors.values.forEach { $0.removeFromParent() }
        anchors.removeAll()
        hapticsDelivered.removeAll()
    }
}
