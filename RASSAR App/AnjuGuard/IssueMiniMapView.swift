import ARKit
import AnjuCore
import UIKit

@MainActor
final class IssueMiniMapView: UIView {
    private var issues: [SafetyIssue] = []
    private var cameraTransform = matrix_identity_float4x4
    private let rangeMeters: Float = 3

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isAccessibilityElement = true
        backgroundColor = UIColor.systemBackground.withAlphaComponent(0.86)
        layer.cornerRadius = 18
        layer.borderColor = UIColor.white.withAlphaComponent(0.7).cgColor
        layer.borderWidth = 1
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    func update(issues: [SafetyIssue], cameraTransform: simd_float4x4) {
        self.issues = issues.filter { $0.state != .dismissed && $0.evidence.worldPoint != nil }
        self.cameraTransform = cameraTransform
        accessibilityLabel = self.issues.isEmpty
            ? "房间位置图，暂时没有问题标记"
            : "房间位置图，有\(self.issues.count)处问题标记"
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        context.setFillColor(UIColor.systemBackground.withAlphaComponent(0.88).cgColor)
        context.addPath(UIBezierPath(roundedRect: bounds, cornerRadius: 18).cgPath)
        context.fillPath()

        let center = CGPoint(x: bounds.midX, y: bounds.midY)
        context.setStrokeColor(AnjuTheme.ink.withAlphaComponent(0.2).cgColor)
        context.setLineWidth(1)
        context.strokeEllipse(in: bounds.insetBy(dx: 12, dy: 12))
        drawUser(at: center, context: context)

        let cameraPosition = SIMD3<Float>(
            cameraTransform.columns.3.x,
            cameraTransform.columns.3.y,
            cameraTransform.columns.3.z
        )
        let yaw = atan2(cameraTransform.columns.0.z, cameraTransform.columns.0.x)
        let usableRadius = Float(min(bounds.width, bounds.height) / 2 - 18)
        for issue in issues {
            guard let point = issue.evidence.worldPoint else { continue }
            let dx = point.x - cameraPosition.x
            let dz = point.z - cameraPosition.z
            let localX = cos(-yaw) * dx - sin(-yaw) * dz
            let localZ = sin(-yaw) * dx + cos(-yaw) * dz
            let scale = usableRadius / rangeMeters
            let x = center.x + CGFloat(max(-usableRadius, min(usableRadius, localX * scale)))
            let y = center.y + CGFloat(max(-usableRadius, min(usableRadius, localZ * scale)))
            drawIssue(issue, at: CGPoint(x: x, y: y), context: context)
        }
    }

    private func drawUser(at point: CGPoint, context: CGContext) {
        let path = UIBezierPath()
        path.move(to: CGPoint(x: point.x, y: point.y - 9))
        path.addLine(to: CGPoint(x: point.x - 7, y: point.y + 7))
        path.addLine(to: CGPoint(x: point.x + 7, y: point.y + 7))
        path.close()
        AnjuTheme.teal.setFill()
        path.fill()
    }

    private func drawIssue(_ issue: SafetyIssue, at point: CGPoint, context: CGContext) {
        let color = AnjuTheme.severityColor(issue.severity)
        context.setFillColor(color.cgColor)
        context.fillEllipse(in: CGRect(x: point.x - 8, y: point.y - 8, width: 16, height: 16))
        let symbol: NSString = switch issue.severity {
        case .high: "!"
        case .medium: "•"
        case .check: "?"
        }
        symbol.draw(
            at: CGPoint(x: point.x - 3.5, y: point.y - 7),
            withAttributes: [
                .font: UIFont.boldSystemFont(ofSize: 11),
                .foregroundColor: UIColor.white
            ]
        )
    }
}
