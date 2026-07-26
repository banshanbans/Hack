//
//  ViewController.swift
//  RetroAccess App
//
//  Created by Xia Su on 7/11/22.
//
import ARKit
import AnjuCore
import OSLog
import UIKit
import RealityKit
import RoomPlan
import PDFKit
//import Speech

private final class SingleRemoteRequestGate: @unchecked Sendable {
    private let lock = NSLock()
    private var isInFlight = false

    func begin() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !isInFlight else { return false }
        isInFlight = true
        return true
    }

    func end() {
        lock.lock()
        isInFlight = false
        lock.unlock()
    }
}

public class ViewController: UIViewController {
    enum NoAIAction { case rescan, exit }
    
    @IBOutlet var arView: ARView!
    var appContext: AnjuAppContext!
    var onNoAIAction: ((NoAIAction) -> Void)?
    private let captureCoordinator = RoomCaptureCoordinator()
    private let frameContextStore = FrameContextStore(capacity: 4)
    private var issueAnchorStore: IssueAnchorStore!
    private var issueOverlayCoordinator: IssueOverlayCoordinator!
    private let issueMiniMapView = IssueMiniMapView()
    private var remoteAnalysisTask: Task<Void, Never>?
    private let remoteRequestGate = SingleRemoteRequestGate()
    private var lastRemoteAnalysisTime: TimeInterval = 0
    private var lastRemoteCameraTransform: Matrix4x4Codable?
    private let remoteMotionGate = CameraMotionGate()
    private let frameQualityService = FrameQualityService()
    private let analysisQueue = DispatchQueue(label: "com.anjuguard.frame-analysis", qos: .utility)
    private let logger = Logger(subsystem: "com.anjuguard.app", category: "scan")
    private let finishButton = AnjuTheme.primaryButton(title: ProductCopy.finishScan)
    private var isScanning: Bool = false
    private var hasCompletedScan = false
    private var hasRequestedFinish = false
    private var hasPresentedReport = false
    private var isPaused = false
    private var wasScanningBeforeBackground = false
    private var finishFallbackWorkItem: DispatchWorkItem?
    var replicator = RoomObjectReplicator()
    private var ruleTimer: Timer?
    let ciContext = CIContext()
    var minimap:MiniMapLayer?
    let roombuilder=RoomBuilder(options: [.beautifyObjects])
    var manager = FileManager.default
    var extendedViewIsOut:Bool=false{
        didSet{
            if extendedViewIsOut{
                minimap?.isHidden=true
            }
            else{
                minimap?.isHidden=false
            }
        }
    }
    var voiceSynthesizer:AVSpeechSynthesizer?
    var assistiveVoice:AVSpeechSynthesisVoice?
    //let speechRecognizer = SFSpeechRecognizer()
    let audioEngine = AVAudioEngine()
    //var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    //var recognitionTask: SFSpeechRecognitionTask?
    var speechAuthorized:Bool=false
    var audioQueue = [AudioFeedback]()
    private let guidanceLabel = UILabel()
    private let zoneControl = UISegmentedControl(items: ["入口", "主通道", "展位", "休息"])
    private let temporarySuggestionPanel = UIVisualEffectView(effect: UIBlurEffect(style: .systemChromeMaterialDark))
    private let temporarySuggestionHeader = UILabel()
    private let temporarySuggestionScrollView = UIScrollView()
    private let temporarySuggestionStack = UIStackView()
    private var temporarySuggestionCount = 0
    private var currentFairZone: VenueZone = .entrance
    
    public override func viewDidLoad() {
        super.viewDidLoad()
        if appContext == nil {
            appContext = AnjuAppContext.makeDefault(profiles: [], roomType: "entrance")
        }
        currentFairZone = VenueZone(rawValue: appContext.session.roomType ?? "") ?? .entrance
        Task { await appContext.remoteAnalysis.selectFairZone(currentFairZone) }
        Settings.instance.viewcontroller=self
        UIApplication.shared.isIdleTimerDisabled=true
        replicator.setView(view:arView)
        Settings.instance.setReplicator(rep: replicator)
        captureCoordinator.delegate = self
        setupRoomCapture()
        configureProductOverlay()
        issueAnchorStore = IssueAnchorStore(arView: arView)
        issueOverlayCoordinator = IssueOverlayCoordinator(containerView: arView)
        issueOverlayCoordinator.onIssueSelected = { [weak self] issue in
            self?.presentIssueDetail(issue)
        }
        
        //Add button for ending scanning process and export pdf report
        // STOP BUTTON
//        let stopButton = UIButton(frame: rect1)
//        stopButton.accessibilityLabel="Finish Scan"
//        //stopButton.setTitle("Export Results", for: .normal)
//        stopButton.addTarget(self, action: #selector(stop), for: .touchUpInside)
//        //stopButton.setTitleColor(.white, for: .normal)
//        //stopButton.backgroundColor = .blue
//        let buttonShapeView=UIView()
//        buttonShapeView.isUserInteractionEnabled=false
//        buttonShapeView.frame=CGRect(x: 0, y: 0, width: 56, height: 56)
//        let circleLayer = CAShapeLayer()
//        let radius: CGFloat = 28
//        circleLayer.path = UIBezierPath(roundedRect: CGRect(x: 0, y: 0, width: 2.0 * radius, height: 2.0 * radius), cornerRadius: radius).cgPath
//        circleLayer.frame=CGRect(x: 0, y: 0, width: 56, height: 56)
//        //circleLayer.fillColor = UIColor(red: 0.122, green: 0.216, blue: 0.267, alpha: 1).cgColor
//        circleLayer.fillColor = UIColor(red: 0.122, green: 0.216, blue: 0.267, alpha: 0).cgColor
//        buttonShapeView.layer.addSublayer(circleLayer)
//        let exportIcon=UIImage(named: "export")!.resizeImage(newSize: CGSize(width: 40, height: 40))
//        let iconView=UIImageView(image: exportIcon)
//        iconView.frame=CGRect(x: 8, y: 8, width: 40, height: 40)
//        buttonShapeView.addSubview(iconView)
//        stopButton.addSubview(buttonShapeView)
//        stopButton.isAccessibilityElement=true
//        self.arView.addSubview(stopButton)
        self.arView.isAccessibilityElement=true
        minimap=MiniMapLayer(replicator: replicator, session: captureCoordinator.session, radius: 82, center: CGPoint(x:view.bounds.midX,y:view.bounds.height-150))
        view.layer.addSublayer(minimap!)
        if Settings.instance.BLVAssistance{
            voiceSynthesizer=AVSpeechSynthesizer()
            assistiveVoice=AVSpeechSynthesisVoice(language: "zh-CN")
            speak(content: ProductCopy.prepareTitle)
        }
        let customAction = UIAccessibilityCustomAction(
            name: ProductCopy.finishScan,
            target: self,
            selector: #selector(finishFromAccessibility(_:))
        )
        arView.accessibilityCustomActions = [customAction]
        DemoIssueFactory.populateIfRequested(context: appContext)
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appWillEnterForeground),
            name: UIApplication.willEnterForegroundNotification,
            object: nil
        )
    }

    deinit {
        finishFallbackWorkItem?.cancel()
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func finishFromAccessibility(_ action: UIAccessibilityCustomAction) -> Bool {
        requestFinishScan()
        return true
    }

    @objc private func appDidEnterBackground() {
        wasScanningBeforeBackground = isScanning
        isScanning = false
        captureCoordinator.pause()
        remoteAnalysisTask?.cancel()
        Task {
            await appContext.remoteAnalysis.cancelPending()
            await frameContextStore.removeAll()
        }
    }

    @objc private func appWillEnterForeground() {
        guard wasScanningBeforeBackground, !hasCompletedScan, !isPaused else { return }
        wasScanningBeforeBackground = false
        isScanning = true
        captureCoordinator.start()
    }
    private func setupRoomCapture() {
        ruleTimer = Timer.scheduledTimer(withTimeInterval: 0.75, repeats: true, block: { [weak self] _ in
            guard let self, self.isScanning else { return }
            self.minimap?.update()
        })
    }
    public override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        startSession()
    }
    
    public override func viewWillDisappear(_ flag: Bool) {
        super.viewWillDisappear(flag)
        if isBeingDismissed || presentingViewController == nil {
            stopSession()
        }
    }
    
    private func startSession() {
        guard !hasCompletedScan else { return }
        hasRequestedFinish = false
        isScanning = true
        finishButton.isEnabled = true
        captureCoordinator.start()
    }
    
    private func stopSession() {
        isScanning = false
        captureCoordinator.stop()
        stopAnalysisWork()
    }

    private func stopAnalysisWork(cancelRemote: Bool = true) {
        ruleTimer?.invalidate()
        ruleTimer = nil
        remoteAnalysisTask?.cancel()
        Task {
            if cancelRemote { await appContext.remoteAnalysis.cancelPending() }
            await frameContextStore.removeAll()
        }
    }

    @MainActor
    private func releaseScanResourcesForReview() {
        issueOverlayCoordinator?.removeAll()
        issueAnchorStore?.removeAll()

        arView.session.pause()
        arView.session.delegate = nil
        arView.scene.anchors.removeAll()
        arView.session = ARSession()
        ciContext.clearCaches()

        minimap?.removeFromSuperlayer()
        minimap = nil
        audioQueue.removeAll(keepingCapacity: false)
        voiceSynthesizer?.stopSpeaking(at: .immediate)
        voiceSynthesizer = nil
        assistiveVoice = nil

        replicator.releaseResourcesAfterScan()
        captureCoordinator.releaseResourcesAfterScan()
        if Settings.instance.viewcontroller === self {
            Settings.instance.viewcontroller = nil
        }
        if Settings.instance.replicator === replicator {
            Settings.instance.replicator = nil
        }
        Settings.instance.miniMap = nil
    }

}

private extension ViewController {
    func configureProductOverlay() {
        guidanceLabel.text = ProductCopy.scanning
        guidanceLabel.font = .preferredFont(forTextStyle: .headline)
        guidanceLabel.adjustsFontForContentSizeCategory = true
        guidanceLabel.textColor = .white
        guidanceLabel.textAlignment = .center
        guidanceLabel.numberOfLines = 0
        guidanceLabel.backgroundColor = UIColor.black.withAlphaComponent(0.58)
        guidanceLabel.layer.cornerRadius = 12
        guidanceLabel.layer.masksToBounds = true
        guidanceLabel.translatesAutoresizingMaskIntoConstraints = false
        arView.addSubview(guidanceLabel)

        zoneControl.selectedSegmentIndex = VenueZone.allCases.firstIndex(of: currentFairZone) ?? 0
        zoneControl.selectedSegmentTintColor = AnjuTheme.teal
        zoneControl.setTitleTextAttributes([.foregroundColor: UIColor.white], for: .selected)
        zoneControl.backgroundColor = UIColor.black.withAlphaComponent(0.58)
        zoneControl.accessibilityLabel = "扫描区域"
        zoneControl.translatesAutoresizingMaskIntoConstraints = false
        zoneControl.addAction(UIAction { [weak self] action in
            guard let self, let control = action.sender as? UISegmentedControl,
                  VenueZone.allCases.indices.contains(control.selectedSegmentIndex) else { return }
            self.currentFairZone = VenueZone.allCases[control.selectedSegmentIndex]
            Task { await self.appContext.remoteAnalysis.selectFairZone(self.currentFairZone) }
            self.guidanceLabel.text = "已切换区域，请缓慢扫描"
        }, for: .valueChanged)
        arView.addSubview(zoneControl)

        let pause = UIButton(type: .system)
        var pauseConfiguration = UIButton.Configuration.filled()
        pauseConfiguration.image = UIImage(systemName: "pause.fill")
        pauseConfiguration.baseBackgroundColor = UIColor.black.withAlphaComponent(0.58)
        pauseConfiguration.baseForegroundColor = .white
        pauseConfiguration.cornerStyle = .capsule
        pause.configuration = pauseConfiguration
        pause.accessibilityLabel = "暂停扫描"
        pause.translatesAutoresizingMaskIntoConstraints = false
        pause.addAction(UIAction { [weak self, weak pause] _ in
            guard let self, let pause else { return }
            self.togglePause(button: pause)
        }, for: .touchUpInside)
        arView.addSubview(pause)

        finishButton.accessibilityHint = "停止扫描并查看房间报告"
        finishButton.translatesAutoresizingMaskIntoConstraints = false
        finishButton.addAction(UIAction { [weak self] _ in self?.requestFinishScan() }, for: .touchUpInside)
        arView.addSubview(finishButton)

        issueMiniMapView.translatesAutoresizingMaskIntoConstraints = false
        arView.addSubview(issueMiniMapView)

        temporarySuggestionPanel.layer.cornerRadius = 16
        temporarySuggestionPanel.layer.masksToBounds = true
        temporarySuggestionPanel.translatesAutoresizingMaskIntoConstraints = false
        temporarySuggestionPanel.accessibilityLabel = "本次扫描的临时建议记录"
        arView.addSubview(temporarySuggestionPanel)

        temporarySuggestionHeader.text = "本次发现记录 · 0 条"
        temporarySuggestionHeader.textColor = .white
        temporarySuggestionHeader.font = .preferredFont(forTextStyle: .headline)
        temporarySuggestionHeader.adjustsFontForContentSizeCategory = true
        temporarySuggestionHeader.translatesAutoresizingMaskIntoConstraints = false
        temporarySuggestionPanel.contentView.addSubview(temporarySuggestionHeader)

        temporarySuggestionScrollView.translatesAutoresizingMaskIntoConstraints = false
        temporarySuggestionScrollView.alwaysBounceVertical = true
        temporarySuggestionPanel.contentView.addSubview(temporarySuggestionScrollView)

        temporarySuggestionStack.axis = .vertical
        temporarySuggestionStack.spacing = 8
        temporarySuggestionStack.translatesAutoresizingMaskIntoConstraints = false
        temporarySuggestionScrollView.addSubview(temporarySuggestionStack)

        NSLayoutConstraint.activate([
            guidanceLabel.topAnchor.constraint(equalTo: arView.safeAreaLayoutGuide.topAnchor, constant: 12),
            guidanceLabel.centerXAnchor.constraint(equalTo: arView.centerXAnchor),
            guidanceLabel.widthAnchor.constraint(lessThanOrEqualTo: arView.widthAnchor, multiplier: 0.66),
            guidanceLabel.heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
            zoneControl.topAnchor.constraint(equalTo: guidanceLabel.bottomAnchor, constant: 10),
            zoneControl.leadingAnchor.constraint(equalTo: arView.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            zoneControl.trailingAnchor.constraint(equalTo: arView.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            zoneControl.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            pause.leadingAnchor.constraint(equalTo: arView.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            pause.centerYAnchor.constraint(equalTo: guidanceLabel.centerYAnchor),
            pause.widthAnchor.constraint(equalToConstant: 48),
            pause.heightAnchor.constraint(equalToConstant: 48),
            finishButton.centerXAnchor.constraint(equalTo: arView.centerXAnchor),
            finishButton.bottomAnchor.constraint(equalTo: arView.safeAreaLayoutGuide.bottomAnchor, constant: -18),
            finishButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 180),
            temporarySuggestionPanel.leadingAnchor.constraint(equalTo: arView.safeAreaLayoutGuide.leadingAnchor, constant: 14),
            temporarySuggestionPanel.trailingAnchor.constraint(equalTo: arView.safeAreaLayoutGuide.trailingAnchor, constant: -14),
            temporarySuggestionPanel.bottomAnchor.constraint(equalTo: finishButton.topAnchor, constant: -12),
            temporarySuggestionPanel.heightAnchor.constraint(equalToConstant: 166),
            temporarySuggestionHeader.topAnchor.constraint(equalTo: temporarySuggestionPanel.contentView.topAnchor, constant: 12),
            temporarySuggestionHeader.leadingAnchor.constraint(equalTo: temporarySuggestionPanel.contentView.leadingAnchor, constant: 14),
            temporarySuggestionHeader.trailingAnchor.constraint(equalTo: temporarySuggestionPanel.contentView.trailingAnchor, constant: -14),
            temporarySuggestionScrollView.topAnchor.constraint(equalTo: temporarySuggestionHeader.bottomAnchor, constant: 8),
            temporarySuggestionScrollView.leadingAnchor.constraint(equalTo: temporarySuggestionPanel.contentView.leadingAnchor),
            temporarySuggestionScrollView.trailingAnchor.constraint(equalTo: temporarySuggestionPanel.contentView.trailingAnchor),
            temporarySuggestionScrollView.bottomAnchor.constraint(equalTo: temporarySuggestionPanel.contentView.bottomAnchor, constant: -8),
            temporarySuggestionStack.topAnchor.constraint(equalTo: temporarySuggestionScrollView.contentLayoutGuide.topAnchor),
            temporarySuggestionStack.leadingAnchor.constraint(equalTo: temporarySuggestionScrollView.contentLayoutGuide.leadingAnchor, constant: 14),
            temporarySuggestionStack.trailingAnchor.constraint(equalTo: temporarySuggestionScrollView.contentLayoutGuide.trailingAnchor, constant: -14),
            temporarySuggestionStack.bottomAnchor.constraint(equalTo: temporarySuggestionScrollView.contentLayoutGuide.bottomAnchor),
            temporarySuggestionStack.widthAnchor.constraint(equalTo: temporarySuggestionScrollView.frameLayoutGuide.widthAnchor, constant: -28),
            issueMiniMapView.leadingAnchor.constraint(equalTo: arView.safeAreaLayoutGuide.leadingAnchor, constant: 14),
            issueMiniMapView.bottomAnchor.constraint(equalTo: temporarySuggestionPanel.topAnchor, constant: -12),
            issueMiniMapView.widthAnchor.constraint(equalToConstant: 132),
            issueMiniMapView.heightAnchor.constraint(equalToConstant: 132)
        ])
    }

    func recordTemporarySuggestion(_ candidate: IssueCandidate, zone: VenueZone) {
        temporarySuggestionCount += 1
        temporarySuggestionHeader.text = "本次发现记录 · \(temporarySuggestionCount) 条"

        let title = UILabel()
        title.text = "\(temporarySuggestionCount). \(candidate.title ?? ProductCopy.shortLabel(for: candidate.type))"
        title.textColor = .white
        title.font = .preferredFont(forTextStyle: .subheadline)
        title.adjustsFontForContentSizeCategory = true
        title.numberOfLines = 0

        let advice = UILabel()
        advice.text = candidate.recommendation ?? candidate.observation ?? "请现场确认"
        advice.textColor = UIColor.white.withAlphaComponent(0.78)
        advice.font = .preferredFont(forTextStyle: .caption1)
        advice.adjustsFontForContentSizeCategory = true
        advice.numberOfLines = 2

        let row = UIStackView(arrangedSubviews: [title, advice])
        row.axis = .vertical
        row.spacing = 2
        row.isLayoutMarginsRelativeArrangement = true
        row.layoutMargins = .init(top: 7, left: 10, bottom: 7, right: 10)
        row.backgroundColor = UIColor.black.withAlphaComponent(0.22)
        row.layer.cornerRadius = 10
        row.isAccessibilityElement = true
        row.accessibilityLabel = "\(zoneDisplayName(zone))，\(title.text ?? "临时建议")，\(advice.text ?? "")"
        temporarySuggestionStack.insertArrangedSubview(row, at: 0)
        temporarySuggestionScrollView.setContentOffset(.zero, animated: true)
        UIAccessibility.post(notification: .announcement, argument: candidate.recommendation ?? candidate.title)
    }

    func zoneDisplayName(_ zone: VenueZone) -> String {
        switch zone {
        case .entrance: "入口"
        case .mainAisle: "主通道"
        case .booth: "展位"
        case .restArea: "休息区"
        }
    }

    func requestFinishScan() {
        guard !hasRequestedFinish, !hasPresentedReport else { return }
        hasRequestedFinish = true
        isScanning = false
        isPaused = false
        Settings.instance.miniMap = minimap
        guidanceLabel.text = ProductCopy.finishingScan
        guidanceLabel.accessibilityLabel = ProductCopy.finishingScan
        UIAccessibility.post(notification: .announcement, argument: ProductCopy.finishingScan)

        var configuration = finishButton.configuration
        configuration?.title = ProductCopy.finishingScan
        configuration?.showsActivityIndicator = true
        finishButton.configuration = configuration
        finishButton.isEnabled = false

        stopAnalysisWork(cancelRemote: false)
        let didRequestSessionStop = captureCoordinator.stop()
        scheduleFinishFallback(delay: didRequestSessionStop ? 2 : 0)
    }

    func scheduleFinishFallback(delay: TimeInterval) {
        finishFallbackWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            self?.completeScanIfNeeded(error: nil)
        }
        finishFallbackWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
    }

    func completeScanIfNeeded(error: Error?) {
        guard !hasPresentedReport else { return }
        hasPresentedReport = true
        hasCompletedScan = true
        hasRequestedFinish = true
        isScanning = false
        finishFallbackWorkItem?.cancel()
        finishFallbackWorkItem = nil
        if let error {
            logger.error("Room capture ended with recoverable error: \(error.localizedDescription, privacy: .public)")
        }
        guard let context = appContext else {
            logger.fault("Scan completed without an application context")
            guidanceLabel.text = ProductCopy.partialReport
            guidanceLabel.accessibilityLabel = ProductCopy.partialReport
            finishButton.configuration?.showsActivityIndicator = false
            finishButton.configuration?.title = ProductCopy.partialReport
            UIAccessibility.post(notification: .announcement, argument: ProductCopy.partialReport)
            return
        }
        let pendingAnalysis = remoteAnalysisTask
        releaseScanResourcesForReview()
        Task { [weak self] in
            await pendingAnalysis?.value
            do {
                switch try await context.remoteAnalysis.completeFairScan() {
                case let .report(reviewed):
                    do {
                        try await MainActor.run { try context.applyFairReport(reviewed) }
                    } catch {
                        self?.logger.error("Fair report validation failed; keeping direct analysis candidates as manual checks")
                        await MainActor.run { context.markFairReviewIncomplete() }
                    }
                case .noSuccessfulAnalysis:
                    await MainActor.run { [weak self] in self?.presentNoAIResultActions() }
                    return
                }
            } catch {
                self?.logger.notice("Report finalization unavailable; report remains clearly partial")
                await MainActor.run { context.markFairReviewIncomplete() }
            }
            await MainActor.run { [weak self] in
                guard let self else { return }
                let report = ReportViewController(context: context)
                report.modalPresentationStyle = .fullScreen
                self.present(report, animated: true)
            }
        }
    }

    func togglePause(button: UIButton) {
        if isPaused {
            isPaused = false
            isScanning = true
            captureCoordinator.start()
            button.configuration?.image = UIImage(systemName: "pause.fill")
            button.accessibilityLabel = "暂停扫描"
            guidanceLabel.text = ProductCopy.scanning
        } else {
            isPaused = true
            isScanning = false
            captureCoordinator.pause()
            button.configuration?.image = UIImage(systemName: "play.fill")
            button.accessibilityLabel = "继续扫描"
            guidanceLabel.text = "已经暂停，准备好后再继续"
        }
    }

    private func presentNoAIResultActions() {
        let alert = UIAlertController(
            title: ProductCopy.fairAIIncompleteTitle,
            message: ProductCopy.fairAIIncompleteMessage,
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: ProductCopy.rescan, style: .default) { [weak self] _ in
            self?.onNoAIAction?(.rescan)
        })
        alert.addAction(UIAlertAction(title: ProductCopy.exitToHome, style: .cancel) { [weak self] _ in
            self?.onNoAIAction?(.exit)
        })
        present(alert, animated: true)
    }

    func presentIssueDetail(_ issue: SafetyIssue) {
        let detail = IssueDetailViewController(issueID: issue.id, repository: appContext.repository) { [weak self] in
            guard let self else { return }
            self.issueAnchorStore.synchronize(self.appContext.repository.issues)
        }
        if let sheet = detail.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
        }
        present(detail, animated: true)
    }

    func scheduleRemoteAnalysisIfNeeded(_ frame: ARFrame) {
        guard case .normal = frame.camera.trackingState else { return }
        let transform = frame.camera.transform
        guard let currentTransform = Matrix4x4Codable(values: [
            transform.columns.0.x, transform.columns.0.y, transform.columns.0.z, transform.columns.0.w,
            transform.columns.1.x, transform.columns.1.y, transform.columns.1.z, transform.columns.1.w,
            transform.columns.2.x, transform.columns.2.y, transform.columns.2.z, transform.columns.2.w,
            transform.columns.3.x, transform.columns.3.y, transform.columns.3.z, transform.columns.3.w
        ]), remoteMotionGate.hasMeaningfulChange(previous: lastRemoteCameraTransform, current: currentTransform) else { return }
        guard let context = appContext,
              context.remoteAnalysis.isEnabled,
              frame.timestamp - lastRemoteAnalysisTime >= 5,
              remoteRequestGate.begin() else { return }
        lastRemoteAnalysisTime = frame.timestamp
        lastRemoteCameraTransform = currentTransform
        let frameID = UUID()
        let remote = context.remoteAnalysis
        let roomType = currentFairZone.rawValue
        let store = frameContextStore
        let requestGate = remoteRequestGate
        let sourceFrame = frame

        let task = Task { @MainActor [weak self] in
            guard let self else {
                requestGate.end()
                return
            }
            defer {
                requestGate.end()
                self.remoteAnalysisTask = nil
            }
            let prepared: (StoredFrameContext, Data)? = await withCheckedContinuation { continuation in
                self.analysisQueue.async { [weak self] in
                    guard let self,
                          self.frameQualityService.evaluate(pixelBuffer: sourceFrame.capturedImage).map(\.isUsable) == true,
                          let stored = ARFrameContextBuilder.makeStoredContext(frame: sourceFrame, frameID: frameID),
                          let jpeg = self.makeJPEG(from: sourceFrame.capturedImage) else {
                        continuation.resume(returning: nil)
                        return
                    }
                    continuation.resume(returning: (stored, jpeg))
                }
            }
            guard !Task.isCancelled else { return }
            guard let (stored, jpeg) = prepared else {
                self.guidanceLabel.text = ProductCopy.cameraFrameUnusable
                self.guidanceLabel.accessibilityLabel = ProductCopy.cameraFrameUnusable
                return
            }
            await store.insert(stored)
            defer { Task { await store.remove(frameID: frameID) } }
            do {
                let candidates = try await remote.analyze(frameID: frameID, jpegData: jpeg, roomType: roomType)
                self.guidanceLabel.text = candidates.isEmpty
                    ? ProductCopy.directAnalysisNoCandidate
                    : ProductCopy.directAnalysisCandidatesFound(candidates.count)
                let resolver = WorldPointResolver()
                for candidate in candidates {
                    let candidateZone = candidate.evidence.zoneID.flatMap(VenueZone.init(rawValue:)) ?? self.currentFairZone
                    self.recordTemporarySuggestion(candidate, zone: candidateZone)
                    var evidence = candidate.evidence
                    if let box = evidence.boundingBox {
                        if let depth = stored.depth,
                           let point = resolver.resolve(boundingBox: box, frame: stored.context, depth: depth) {
                            evidence.worldPoint = point
                        } else if let point = self.raycastWorldPoint(
                            boundingBox: box,
                            frameContext: stored.context,
                            sourceFrame: sourceFrame
                        ) {
                            evidence.worldPoint = point
                        }
                    }
                    let enriched = IssueCandidate(
                        type: candidate.type,
                        title: candidate.title,
                        observation: candidate.observation,
                        recommendation: candidate.recommendation,
                        needsManualCheck: candidate.needsManualCheck,
                        confidence: candidate.confidence,
                        source: candidate.source,
                        evidence: evidence,
                        worldTransform: evidence.worldPoint.flatMap(LegacyIssueAdapter.translationMatrix)
                    )
                    if context.observeFairDirectCandidate(enriched) != nil {
                        self.issueAnchorStore.synchronize(context.repository.issues)
                    }
                }
            } catch is CancellationError {
                return
            } catch {
                self.logger.notice("Remote Pro frame analysis unavailable; frame was not accepted")
                self.guidanceLabel.text = ProductCopy.remoteUnavailable
                UIAccessibility.post(notification: .announcement, argument: ProductCopy.remoteUnavailable)
            }
        }
        remoteAnalysisTask = task
    }

    func makeJPEG(from pixelBuffer: CVPixelBuffer) -> Data? {
        let image = CIImage(cvPixelBuffer: pixelBuffer).oriented(.right)
        let scale = min(1, 1280 / max(image.extent.width, image.extent.height))
        let resized = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cgImage = ciContext.createCGImage(resized, from: resized.extent) else { return nil }
        return UIImage(cgImage: cgImage).jpegData(compressionQuality: 0.72)
    }

    func raycastWorldPoint(
        boundingBox: NormalizedBoundingBox,
        frameContext: CapturedFrameContext,
        sourceFrame: ARFrame
    ) -> WorldPoint? {
        guard let capturedBox = frameContext.modelImageOrientation.capturedImageBox(from: boundingBox) else { return nil }
        let normalizedPoint = CGPoint(
            x: (capturedBox.xMin + capturedBox.xMax) * 0.5,
            y: capturedBox.yMax
        ).applying(sourceFrame.displayTransform(for: .portrait, viewportSize: arView.bounds.size))
        let screenPoint = CGPoint(
            x: normalizedPoint.x * arView.bounds.width,
            y: normalizedPoint.y * arView.bounds.height
        )
        for target in [ARRaycastQuery.Target.existingPlaneGeometry, .estimatedPlane] {
            if let result = arView.raycast(from: screenPoint, allowing: target, alignment: .any).first {
                let position = result.worldTransform.columns.3
                guard position.x.isFinite, position.y.isFinite, position.z.isFinite else { continue }
                return WorldPoint(x: position.x, y: position.y, z: position.z)
            }
        }
        return nil
    }
}

extension ViewController: RoomCaptureCoordinatorDelegate {
    func roomCaptureCoordinator(_ coordinator: RoomCaptureCoordinator, didUpdate room: CapturedRoom) {
        replicator.anchor(
            objects: room.objects,
            surfaces: room.walls + room.doors + room.openings + room.windows,
            in: coordinator.session
        )
        minimap?.update()
    }

    func roomCaptureCoordinatorDidStart(_ coordinator: RoomCaptureCoordinator) {
        arView.session.pause()
        arView.session = coordinator.session.arSession
        arView.session.delegate = self
    }

    func roomCaptureCoordinator(_ coordinator: RoomCaptureCoordinator, didFinish data: CapturedRoomData, error: Error?) {
        completeScanIfNeeded(error: error)
    }

    func roomCaptureCoordinator(_ coordinator: RoomCaptureCoordinator, didProvide instruction: RoomCaptureSession.Instruction) {
        let message: String
        switch instruction{
        case .moveCloseToWall:
            message = "再靠近一点看看墙边"
        case .moveAwayFromWall:
            message = "稍微退后一点"
        case .slowDown:
            message = "慢一点，画面会更清楚"
        case .turnOnLight:
            message = "打开灯后再看看这里"
        case .normal:
            message = ProductCopy.scanning
        case .lowTexture:
            message = "把墙角也放进画面里"
        @unknown default:
            message = ProductCopy.scanMore
        }
        guidanceLabel.text = message
        guidanceLabel.accessibilityLabel = message
        UIAccessibility.post(notification: .announcement, argument: message)
    }
}

extension ViewController: ARSessionDelegate {
    
    public func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
        //        for a in anchors{
        //            //session.add(anchor: a)
        //            //arView.scene.addAnchor(NotifyingEntity(anchor:a))
        //
        //            let mesh = MeshResource.generateSphere(radius: 0.3)
        //            let material = SimpleMaterial(color: .systemRed, roughness: 0.27, isMetallic: false)
        //            let model = ModelEntity(mesh: mesh, materials: [material])
        //            let anchorEntity = AnchorEntity(anchor: a)
        //            anchorEntity.anchor?.addChild(model)
        //            arView.scene.addAnchor(anchorEntity)
        //}
        //arView.scene.addRoomObjectEntities(for: anchors)
        
    }
    
    public func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        //arView.scene.updateRoomObjectEntities(for: anchors)
        
    }
    public func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let camera = frame.camera
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let issues = self.appContext.repository.issues
            self.issueAnchorStore.synchronize(issues)
            self.issueOverlayCoordinator.update(
                issues: issues,
                camera: camera,
                viewportSize: self.arView.bounds.size
            )
            self.issueMiniMapView.update(issues: issues, cameraTransform: camera.transform)
        }
        scheduleRemoteAnalysisIfNeeded(frame)

        //Rotate the minimap with the real-time camera orientation
        let cameraTrans=session.currentFrame?.camera.eulerAngles
        if let trans=cameraTrans {
            var angle=trans.y
            if angle<0{
                angle += .pi*2
            }
            //let rotation = CATransform3DMakeRotation(CGFloat(angle), 0, 0, 1)
            DispatchQueue.main.async { [weak self] in
                if let map = self?.minimap, map.isDrawn() {
                    map.set_rotation(angle:angle)
                }
            }
        }
    }
}
