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
}

@MainActor
final class AnjuAppContext {
    let session: ScanSession
    let ruleStore: SafetyRuleStore
    let detectionEngine: IssueDetectionEngine
    let repository: ScanIssueRepository
    let remoteAnalysis: any RemoteAnalysisServing

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
        if let url = Bundle.main.url(forResource: "SafetyRules.zh-CN", withExtension: "json"),
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
