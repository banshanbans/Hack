import AnjuCore
import Foundation
import OSLog

@MainActor
final class ScanIssueRepository {
    private(set) var store: IssueStore

    init(store: IssueStore = IssueStore()) {
        self.store = store
    }

    var issues: [SafetyIssue] { store.reportIssues() }

    @discardableResult
    func observe(_ issue: SafetyIssue) -> SafetyIssue? {
        store.observe(issue)
    }

    func setState(id: UUID, state: IssueState) {
        store.setState(id: id, state: state)
    }

    func issue(id: UUID) -> SafetyIssue? {
        store.issues.first { $0.id == id }
    }

    func replace(with issues: [SafetyIssue]) {
        var replacement = IssueStore()
        for issue in issues { replacement.observe(issue) }
        store = replacement
    }
}

@MainActor
final class AnjuAppContext {
    let session: ScanSession
    let ruleStore: SafetyRuleStore
    let detectionEngine: IssueDetectionEngine
    let repository: ScanIssueRepository
    let remoteAnalysis: any RemoteAnalysisServing
    private(set) var fairReport: FairScanReportDTO?

    init(
        session: ScanSession,
        ruleStore: SafetyRuleStore,
        repository: ScanIssueRepository? = nil,
        remoteAnalysis: any RemoteAnalysisServing = DisabledRemoteAnalysisClient()
    ) {
        self.session = session
        self.ruleStore = ruleStore
        detectionEngine = IssueDetectionEngine(ruleStore: ruleStore)
        self.repository = repository ?? ScanIssueRepository()
        self.remoteAnalysis = remoteAnalysis
    }

    static func makeDefault(profiles: Set<String>, roomType: String? = nil) -> AnjuAppContext {
        let logger = Logger(subsystem: "com.anjuguard.app", category: "rules")
        let store: SafetyRuleStore
        if VenueZone.allCases.map(\.rawValue).contains(roomType ?? "") {
            store = Self.fairRuleStore
        } else if let url = Bundle.main.url(forResource: "SafetyRules.zh-CN", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let loaded = try? SafetyRuleStore(data: data) {
            store = loaded
        } else {
            logger.error("Safety rule resource unavailable; using minimum fallback")
            store = SafetyRuleStore(requiredRule: Self.fallbackRule)
        }
        var session = ScanSession(roomType: roomType, profiles: profiles)
        session.state = .preparing
        let remote: any RemoteAnalysisServing
        let configuredBaseURL = ProcessInfo.processInfo.environment["ANJU_ANALYSIS_BASE_URL"]
            ?? Bundle.main.object(forInfoDictionaryKey: "AnjuAnalysisBaseURL") as? String
        if let value = configuredBaseURL,
           let url = URL(string: value),
           let client = RemoteAnalysisClient(baseURL: url, sessionID: session.id, profiles: Array(profiles)) {
            remote = client
        } else {
            remote = DisabledRemoteAnalysisClient()
        }
        return AnjuAppContext(session: session, ruleStore: store, remoteAnalysis: remote)
    }

    func applyFairReport(_ report: FairScanReportDTO) {
        let turboIssues = repository.issues
        var reviewedIssues: [SafetyIssue] = []
        for reviewed in report.zones.flatMap(\.risks) where reviewed.status != .rejected && reviewed.status != .merged {
            guard let type = SafetyIssueType(rawValue: reviewed.riskCode),
                  let boxValues = reviewed.boundingBox,
                  let box = NormalizedBoundingBox(array: boxValues) else { continue }
            let turbo = turboIssues.first { $0.type == type && $0.evidence.frameID == reviewed.frameID }
            let zone = report.zones.first(where: { $0.risks.contains(reviewed) })?.zoneID.rawValue
            var evidence = IssueEvidence(frameID: reviewed.frameID, boundingBox: box, zoneID: zone)
            evidence.worldPoint = turbo?.evidence.worldPoint
            evidence.measurementStatus = turbo?.evidence.measurementStatus ?? .unavailable
            let candidate = IssueCandidate(
                type: type, observation: reviewed.evidence,
                needsManualCheck: reviewed.status == .manualCheck,
                source: .remoteVision, evidence: evidence,
                worldTransform: turbo?.worldTransform
            )
            if let issue = detectionEngine.makeIssue(from: candidate, sessionID: session.id, roomType: zone, profiles: session.profiles) {
                reviewedIssues.append(issue)
            }
        }
        repository.replace(with: reviewedIssues)
        fairReport = report
    }

    private static let fallbackRule = SafetyRule(
        id: "FALLBACK-001",
        type: .floorClutter,
        roomTypes: [],
        profiles: [],
        title: "通道上有杂物",
        evidenceRequired: ["obstruction_visible"],
        severity: .high,
        reason: "常走的通道被物品占用，需要留意。",
        primaryAction: "先清出一条连续、无遮挡的通道。",
        manualChecks: [],
        needsManualCheck: true,
        source: .init(name: "内置最小规则", url: nil)
    )

    private static let fairRuleStore: SafetyRuleStore = {
        let zones = VenueZone.allCases.map(\.rawValue)
        let definitions: [(SafetyIssueType, Severity, String, String, String)] = [
            (.floorClutter, .high, "通行区域有杂物", "通行区域可见低位障碍。", "先移出通道并设置清晰边界。"),
            (.cableCrossing, .high, "线缆横跨通道", "线缆经过人员通行动线。", "先固定线缆并加醒目标识。"),
            (.narrowPath, .high, "主要通道偏窄", "展位或物品压缩了通行空间。", "先移开占道物并恢复连续通道。"),
            (.looseRug, .medium, "临时铺设物可能绊脚", "临时地垫或铺设物边缘需要处理。", "固定边缘或移出主要动线。"),
            (.unstableSupport, .medium, "现场物体稳定性待确认", "人员可能接触的物体看起来需要复核。", "暂停使用并由现场人员检查固定。"),
            (.lowLighting, .medium, "通行区域照明不足", "通行区域的照明可能不足。", "增加连续照明和清晰引导。"),
            (.sharpCorner, .check, "动线附近有突出尖角", "人员动线附近可见突出边角。", "加装防撞保护或调整位置。")
        ]
        let source = RuleSource(name: "游园会现场规则 v1", url: nil)
        let rules = definitions.enumerated().map { index, item in
            SafetyRule(id: "FAIR-\(index + 1)", type: item.0, roomTypes: zones, profiles: [], title: item.2, evidenceRequired: ["visible_region"], severity: item.1, reason: item.3, primaryAction: item.4, manualChecks: [], needsManualCheck: false, source: source)
        }
        return (try? SafetyRuleStore(rules: rules)) ?? SafetyRuleStore(requiredRule: fallbackRule)
    }()
}

enum DemoIssueFactory {
    @MainActor
    static func populateIfRequested(context: AnjuAppContext, force: Bool = false) {
        guard force || ProcessInfo.processInfo.arguments.contains("-AnjuDemoIssues") else { return }
        let fixtures: [(SafetyIssueType, WorldPoint, String)] = [
            (.looseRug, .init(x: -0.6, y: 0, z: -1.8), "演示证据：门口地毯"),
            (.floorClutter, .init(x: 0.4, y: 0, z: -2.2), "演示证据：通道纸箱"),
            (.cableCrossing, .init(x: 0.1, y: 0, z: -1.5), "演示证据：横跨地面的电线"),
            (.lowLighting, .init(x: -1, y: 1, z: -2.5), "演示证据：夜间通道"),
            (.bedsideObstruction, .init(x: 0.8, y: 0, z: -2.8), "演示证据：床边物品")
        ]
        for (type, point, evidenceText) in fixtures {
            let candidate = IssueCandidate(
                type: type,
                observation: evidenceText,
                needsManualCheck: false,
                source: .user,
                evidence: .init(snapshotFilename: "demo-fixture", worldPoint: point)
            )
            if let issue = context.detectionEngine.makeIssue(
                from: candidate,
                sessionID: context.session.id,
                roomType: context.session.roomType,
                profiles: context.session.profiles
            ) {
                context.repository.observe(issue)
            }
        }
    }
}
