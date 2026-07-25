import ARKit
import AnjuCore
import UIKit

@MainActor
final class IssueOverlayCoordinator {
    private weak var containerView: UIView?
    private var labels: [UUID: UIButton] = [:]
    private var issueByID: [UUID: SafetyIssue] = [:]
    var onIssueSelected: ((SafetyIssue) -> Void)?

    init(containerView: UIView) {
        self.containerView = containerView
    }

    func update(issues: [SafetyIssue], camera: ARCamera, viewportSize: CGSize) {
        guard let containerView else { return }
        let candidates = issues
            .filter { $0.state != .dismissed && $0.evidence.worldPoint != nil }
            .sorted { $0.severity.sortOrder < $1.severity.sortOrder }
            .prefix(5)
        let visibleIDs = Set(candidates.map(\.id))
        for (id, label) in labels where !visibleIDs.contains(id) {
            label.removeFromSuperview()
            labels.removeValue(forKey: id)
            issueByID.removeValue(forKey: id)
        }

        var occupied: [CGRect] = []
        let centerExclusion = CGRect(
            x: viewportSize.width / 2 - 70,
            y: viewportSize.height / 2 - 70,
            width: 140,
            height: 140
        )
        for issue in candidates {
            guard let world = issue.evidence.worldPoint else { continue }
            let projected = camera.projectPoint(
                SIMD3<Float>(world.x, world.y, world.z),
                orientation: .portrait,
                viewportSize: viewportSize
            )
            guard projected.x.isFinite, projected.y.isFinite,
                  projected.x >= -40, projected.x <= viewportSize.width + 40,
                  projected.y >= -40, projected.y <= viewportSize.height + 40 else {
                labels[issue.id]?.isHidden = true
                continue
            }
            let button = labels[issue.id] ?? makeLabel(for: issue, in: containerView)
            button.isHidden = false
            issueByID[issue.id] = issue
            var frame = CGRect(x: projected.x - 62, y: projected.y - 22, width: 124, height: 44)
            frame.origin.x = min(max(8, frame.origin.x), viewportSize.width - frame.width - 8)
            frame.origin.y = min(max(72, frame.origin.y), viewportSize.height - frame.height - 96)
            if frame.intersects(centerExclusion) { frame.origin.y = centerExclusion.maxY + 8 }
            while occupied.contains(where: { $0.intersects(frame) }), frame.maxY < viewportSize.height - 100 {
                frame.origin.y += 48
            }
            button.frame = frame
            occupied.append(frame)
        }
    }

    func removeAll() {
        labels.values.forEach { $0.removeFromSuperview() }
        labels.removeAll()
        issueByID.removeAll()
    }

    private func makeLabel(for issue: SafetyIssue, in container: UIView) -> UIButton {
        let button = UIButton(type: .system)
        button.tag = labels.count
        button.layer.cornerRadius = 14
        button.layer.shadowColor = UIColor.black.cgColor
        button.layer.shadowOpacity = 0.18
        button.layer.shadowRadius = 5
        button.layer.shadowOffset = .init(width: 0, height: 2)
        button.backgroundColor = .systemBackground.withAlphaComponent(0.94)
        button.setTitle(ProductCopy.shortLabel(for: issue.type), for: .normal)
        button.setTitleColor(AnjuTheme.ink, for: .normal)
        button.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        button.titleLabel?.adjustsFontForContentSizeCategory = true
        button.accessibilityLabel = "\(ProductCopy.shortLabel(for: issue.type))，\(ProductCopy.viewAdvice)"
        button.addAction(UIAction { [weak self] _ in
            guard let self, let selected = self.issueByID[issue.id] else { return }
            self.onIssueSelected?(selected)
        }, for: .touchUpInside)
        container.addSubview(button)
        labels[issue.id] = button
        return button
    }
}
