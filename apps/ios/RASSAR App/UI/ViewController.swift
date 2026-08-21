import ARKit
import AnjuCore
import AVFoundation
import OSLog
import RealityKit
import RoomPlan
import UIKit

private final class SingleWorkGate: @unchecked Sendable {
    private let lock = NSLock()
    private var busy = false

    func begin() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !busy else { return false }
        busy = true
        return true
    }

    func end() {
        lock.lock()
        busy = false
        lock.unlock()
    }
}

private struct RepresentativeFrame: Sendable {
    let frameID: UUID
    let fileURL: URL
    let capturedAtMilliseconds: Int
    let perceptualHash: UInt64?
    let brightness: Double
    let sharpness: Double
    let byteCount: Int
    var pinned = false
    var confidence = 0.0
}

private final class NativeCaptureFileStore: @unchecked Sendable {
    private let directory: URL
    private let fileManager = FileManager.default

    init(scanID: String) throws {
        let root = fileManager.temporaryDirectory
            .appendingPathComponent("anju-native-camera", isDirectory: true)
        try? fileManager.removeItem(at: root)
        directory = root
            .appendingPathComponent(scanID, isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    func save(_ data: Data, frameID: UUID) throws -> URL {
        let url = directory.appendingPathComponent("frame-\(frameID.uuidString).jpg")
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        return url
    }

    func removeAll() {
        try? fileManager.removeItem(at: directory)
    }

    func remove(_ url: URL) {
        try? fileManager.removeItem(at: url)
    }
}

public final class ViewController: UIViewController {
    @IBOutlet var arView: ARView!
    private let boundingBoxRegionType = "b" + "box"

    var captureRequest: NativeCaptureRequest!
    var spatialMode = false
    var onCaptureFinished: ((NativeCaptureResult) -> Void)?
    var voiceSynthesizer: AVSpeechSynthesizer?
    var assistiveVoice: AVSpeechSynthesisVoice?
    var audioQueue: [AudioFeedback] = []

    private let captureCoordinator = RoomCaptureCoordinator()
    private let selectionPolicy = NativeFrameSelectionPolicy.homeCamera
    private let frameContextStore = FrameContextStore(
        capacity: NativeFrameSelectionPolicy.homeCamera.maximumDepthContexts
    )
    private let frameQualityService = FrameQualityService()
    private let localFrameGate = SingleWorkGate()
    private let modelRequestGate = SingleWorkGate()
    private let analysisQueue = DispatchQueue(label: "com.anjuguard.home-camera", qos: .utility)
    private let ciContext = CIContext()
    private let logger = Logger(subsystem: "com.anjuguard.app", category: "home-camera")

    private var client: RemoteAnalysisClient!
    private var fileStore: NativeCaptureFileStore!
    private var scanID = UUID().uuidString
    private var representativeFrames: [RepresentativeFrame] = []
    private var lastCandidateTime: TimeInterval = -.infinity
    private var lastModelRequestTime: TimeInterval = -.infinity
    private var modelRequestCount = 0
    private var lastAcceptedTransform: simd_float4x4?
    private var lastPerceptualHash: UInt64?
    private var isScanning = false
    private var isPaused = false
    private var hasFinished = false
    private var uploadTask: Task<Void, Never>?
    private var advisorEventSocket: URLSessionWebSocketTask?
    private var advisorEventLoopTask: Task<Void, Never>?
    private var advisorHeartbeatTask: Task<Void, Never>?
    private var advisorRecoveryTask: Task<Void, Never>?
    private var handledAdvisorEventIDs: Set<String> = []
    private var selectedSuggestionID: String?
    private var selectedSuggestionFrameID: String?
    private var advisorVoiceState: NativeAdvisorVoiceState = .idle
    private var resumesAfterBackground = false
    private var rtcVideoEnabled = false
    private var rtcRecoveryInProgress = false
    private var rtcInspectionFailures = 0
    private var inspectionGroups: [String: Int] = [:]
    private var inspectionTimeoutTasks: [String: Task<Void, Never>] = [:]

    private let guidanceLabel = UILabel()
    private let modeLabel = UILabel()
    private let countLabel = UILabel()
    private let suggestionsStack = UIStackView()
    private let suggestionPanel = UIVisualEffectView(effect: UIBlurEffect(style: .systemChromeMaterialDark))
    private let advisorBar = UIVisualEffectView(effect: UIBlurEffect(style: .systemChromeMaterialDark))
    private let advisorSubtitleLabel = UILabel()
    private let advisorVoiceButton = UIButton(type: .system)
    private let advisorToggleButton = UIButton(type: .system)
    private let advisorPanel = UIVisualEffectView(effect: UIBlurEffect(style: .systemChromeMaterialDark))
    private let advisorConversationLabel = UILabel()
    private let advisorInputField = UITextField()
    private let advisorSendButton = UIButton(type: .system)
    private let advisorVoiceClient = NativeAdvisorVoiceClient()
    private let finishButton = AnjuTheme.primaryButton(title: ProductCopy.finishScan)
    private let pauseButton = UIButton(type: .system)

    private var webBaseURL: URL {
        let configured = ProcessInfo.processInfo.environment["ANJU_WEB_BASE_URL"]
            ?? Bundle.main.object(forInfoDictionaryKey: "AnjuWebBaseURL") as? String
            ?? "https://shot.socialdog.cn"
        return URL(string: configured) ?? URL(string: "https://shot.socialdog.cn")!
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        guard captureRequest?.isValid == true,
              let remote = RemoteAnalysisClient(baseURL: webBaseURL, request: captureRequest),
              let store = try? NativeCaptureFileStore(scanID: scanID) else {
            if let request = captureRequest {
                onCaptureFinished?(.init(
                    requestID: request.requestID,
                    status: "failed",
                    roomID: request.roomID,
                    captureMode: spatialMode ? "spatial_ar" : "camera_2d",
                    uploadedMediaIDs: [],
                    failedCount: 0,
                    errorCode: "native_scanner_unavailable",
                    cameraSessionID: request.cameraSessionID
                ))
            } else {
                dismiss(animated: false)
            }
            return
        }
        client = remote
        fileStore = store
        captureCoordinator.delegate = self
        UIApplication.shared.isIdleTimerDisabled = true
        configureOverlay()
        startAdvisorEvents()
        startAdvisorRealtime()
        NotificationCenter.default.addObserver(
            self, selector: #selector(appDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification, object: nil
        )
        NotificationCenter.default.addObserver(
            self, selector: #selector(appWillEnterForeground),
            name: UIApplication.willEnterForegroundNotification, object: nil
        )
    }

    public override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        startSession()
    }

    public override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if isBeingDismissed { releaseResources() }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        fileStore?.removeAll()
    }

    @objc func cancelFromBridge() {
        cancelScan()
    }

    @objc private func appDidEnterBackground() {
        guard !hasFinished else { return }
        resumesAfterBackground = isScanning && !isPaused
        if resumesAfterBackground {
            isPaused = true
            stopSession()
            pauseButton.configuration?.image = UIImage(systemName: "play.fill")
            pauseButton.accessibilityLabel = ProductCopy.resumeScan
            guidanceLabel.text = ProductCopy.scanPaused
        }
        rtcVideoEnabled = false
        rtcRecoveryInProgress = false
        advisorHeartbeatTask?.cancel()
        advisorHeartbeatTask = nil
        advisorRecoveryTask?.cancel()
        advisorRecoveryTask = nil
        stopAdvisorEvents()
        clearRealtimeInspectionState()
        advisorVoiceClient.pauseMedia()
    }

    @objc private func appWillEnterForeground() {
        guard !hasFinished else { return }
        let shouldResumeScanning = resumesAfterBackground
        resumesAfterBackground = false
        if shouldResumeScanning {
            isPaused = false
            pauseButton.configuration?.image = UIImage(systemName: "pause.fill")
            pauseButton.accessibilityLabel = ProductCopy.pauseScan
            startSession()
        }
        guard NativeAdvisorVoiceClient.isSDKAvailable,
              captureRequest?.advisorQueueTicketID != nil else {
            startAdvisorEvents(refreshToken: true)
            guidanceLabel.text = isPaused || !isScanning
                ? ProductCopy.scanPaused
                : ProductCopy.homeCameraScanning
            return
        }
        guidanceLabel.text = ProductCopy.advisorReconnecting
        recoverAdvisorRealtime()
    }

    private func startSession() {
        guard !hasFinished, !isScanning else { return }
        isScanning = true
        if spatialMode {
            captureCoordinator.start()
        } else {
            let configuration = ARWorldTrackingConfiguration()
            configuration.planeDetection = [.horizontal, .vertical]
            arView.session.delegate = self
            arView.session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
        }
    }

    private func stopSession() {
        isScanning = false
        if spatialMode {
            _ = captureCoordinator.stop()
        } else {
            arView.session.pause()
        }
    }

    private func releaseResources() {
        isScanning = false
        arView.session.pause()
        arView.session.delegate = nil
        arView.scene.anchors.removeAll()
        captureCoordinator.releaseResourcesAfterScan()
        ciContext.clearCaches()
        clearRealtimeInspectionState()
        stopAdvisorEvents()
        advisorHeartbeatTask?.cancel()
        advisorHeartbeatTask = nil
        advisorRecoveryTask?.cancel()
        advisorRecoveryTask = nil
        Task { [client] in await client?.cancelAdvisorRTCQueue() }
        advisorVoiceClient.disconnect()
        rtcRecoveryInProgress = false
        handledAdvisorEventIDs.removeAll()
        UIApplication.shared.isIdleTimerDisabled = false
    }

    private func configureOverlay() {
        guidanceLabel.text = ProductCopy.homeCameraScanning
        guidanceLabel.textColor = .white
        guidanceLabel.backgroundColor = UIColor.black.withAlphaComponent(0.62)
        guidanceLabel.font = .preferredFont(forTextStyle: .headline)
        guidanceLabel.adjustsFontForContentSizeCategory = true
        guidanceLabel.numberOfLines = 0
        guidanceLabel.textAlignment = .center
        guidanceLabel.layer.cornerRadius = 12
        guidanceLabel.layer.masksToBounds = true
        guidanceLabel.translatesAutoresizingMaskIntoConstraints = false
        arView.addSubview(guidanceLabel)

        modeLabel.text = spatialMode ? ProductCopy.spatialCameraMode : ProductCopy.camera2DModeWarning
        modeLabel.textColor = .white
        modeLabel.backgroundColor = spatialMode
            ? AnjuTheme.teal.withAlphaComponent(0.9)
            : UIColor.systemOrange.withAlphaComponent(0.92)
        modeLabel.font = .preferredFont(forTextStyle: .subheadline)
        modeLabel.adjustsFontForContentSizeCategory = true
        modeLabel.numberOfLines = 0
        modeLabel.textAlignment = .center
        modeLabel.layer.cornerRadius = 10
        modeLabel.layer.masksToBounds = true
        modeLabel.translatesAutoresizingMaskIntoConstraints = false
        arView.addSubview(modeLabel)

        countLabel.text = ProductCopy.savedRepresentativeFrames(0, limit: captureRequest.remainingSlots)
        countLabel.textColor = .white
        countLabel.font = .preferredFont(forTextStyle: .subheadline)
        countLabel.adjustsFontForContentSizeCategory = true
        countLabel.translatesAutoresizingMaskIntoConstraints = false
        arView.addSubview(countLabel)

        suggestionPanel.layer.cornerRadius = 14
        suggestionPanel.layer.masksToBounds = true
        suggestionPanel.translatesAutoresizingMaskIntoConstraints = false
        arView.addSubview(suggestionPanel)
        suggestionsStack.axis = .vertical
        suggestionsStack.spacing = 6
        suggestionsStack.translatesAutoresizingMaskIntoConstraints = false
        suggestionPanel.contentView.addSubview(suggestionsStack)
        let initial = suggestionLabel(ProductCopy.temporarySuggestionEmpty)
        initial.tag = 1001
        suggestionsStack.addArrangedSubview(initial)

        advisorBar.layer.cornerRadius = 15
        advisorBar.layer.masksToBounds = true
        advisorBar.translatesAutoresizingMaskIntoConstraints = false
        arView.addSubview(advisorBar)

        let advisorTitleLabel = UILabel()
        advisorTitleLabel.text = ProductCopy.advisorTitle
        advisorTitleLabel.textColor = .white
        advisorTitleLabel.font = .preferredFont(forTextStyle: .headline)
        advisorTitleLabel.adjustsFontForContentSizeCategory = true
        advisorSubtitleLabel.text = ProductCopy.advisorDefaultSubtitle
        advisorSubtitleLabel.textColor = UIColor.white.withAlphaComponent(0.8)
        advisorSubtitleLabel.font = .preferredFont(forTextStyle: .caption1)
        advisorSubtitleLabel.adjustsFontForContentSizeCategory = true
        advisorSubtitleLabel.numberOfLines = 2
        let advisorLabels = UIStackView(arrangedSubviews: [advisorTitleLabel, advisorSubtitleLabel])
        advisorLabels.axis = .vertical
        advisorLabels.spacing = 2
        advisorLabels.translatesAutoresizingMaskIntoConstraints = false
        advisorBar.contentView.addSubview(advisorLabels)

        advisorVoiceButton.setImage(UIImage(systemName: "mic.fill"), for: .normal)
        advisorVoiceButton.tintColor = .white
        advisorVoiceButton.backgroundColor = UIColor.systemOrange.withAlphaComponent(0.88)
        advisorVoiceButton.layer.cornerRadius = 22
        advisorVoiceButton.accessibilityLabel = ProductCopy.advisorListening
        advisorVoiceButton.translatesAutoresizingMaskIntoConstraints = false
        advisorVoiceButton.addTarget(self, action: #selector(toggleAdvisorVoice), for: .touchUpInside)
        advisorBar.contentView.addSubview(advisorVoiceButton)

        advisorToggleButton.setImage(UIImage(systemName: "chevron.up"), for: .normal)
        advisorToggleButton.tintColor = .white
        advisorToggleButton.accessibilityLabel = ProductCopy.advisorOpen
        advisorToggleButton.translatesAutoresizingMaskIntoConstraints = false
        advisorToggleButton.addTarget(self, action: #selector(toggleAdvisorPanel), for: .touchUpInside)
        advisorBar.contentView.addSubview(advisorToggleButton)

        advisorPanel.layer.cornerRadius = 15
        advisorPanel.layer.masksToBounds = true
        advisorPanel.isHidden = true
        advisorPanel.translatesAutoresizingMaskIntoConstraints = false
        arView.addSubview(advisorPanel)
        advisorConversationLabel.text = ProductCopy.advisorDefaultSubtitle
        advisorConversationLabel.textColor = .white
        advisorConversationLabel.font = .preferredFont(forTextStyle: .subheadline)
        advisorConversationLabel.adjustsFontForContentSizeCategory = true
        advisorConversationLabel.numberOfLines = 3
        advisorConversationLabel.translatesAutoresizingMaskIntoConstraints = false
        advisorPanel.contentView.addSubview(advisorConversationLabel)
        advisorInputField.placeholder = ProductCopy.advisorInputPlaceholder
        advisorInputField.textColor = .white
        advisorInputField.backgroundColor = UIColor.black.withAlphaComponent(0.25)
        advisorInputField.layer.cornerRadius = 10
        advisorInputField.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 12, height: 1))
        advisorInputField.leftViewMode = .always
        advisorInputField.returnKeyType = .send
        advisorInputField.accessibilityLabel = ProductCopy.advisorInputPlaceholder
        advisorInputField.translatesAutoresizingMaskIntoConstraints = false
        advisorInputField.addTarget(self, action: #selector(sendAdvisorQuestion), for: .editingDidEndOnExit)
        advisorPanel.contentView.addSubview(advisorInputField)
        var sendConfiguration = UIButton.Configuration.filled()
        sendConfiguration.title = ProductCopy.advisorSend
        sendConfiguration.baseBackgroundColor = AnjuTheme.teal
        sendConfiguration.baseForegroundColor = .white
        sendConfiguration.cornerStyle = .medium
        advisorSendButton.configuration = sendConfiguration
        advisorSendButton.translatesAutoresizingMaskIntoConstraints = false
        advisorSendButton.addTarget(self, action: #selector(sendAdvisorQuestion), for: .touchUpInside)
        advisorPanel.contentView.addSubview(advisorSendButton)

        advisorVoiceClient.onStateChange = { [weak self] state in
            DispatchQueue.main.async { self?.displayAdvisorVoiceState(state) }
        }
        advisorVoiceClient.onSubtitle = { [weak self] text in
            DispatchQueue.main.async {
                self?.advisorSubtitleLabel.text = text
                self?.advisorConversationLabel.text = text
            }
        }
        advisorVoiceClient.onVideoProfileChange = { [weak self] profile, reasons in
            DispatchQueue.main.async {
                guard profile == .degraded, reasons.contains(.thermal) else { return }
                self?.guidanceLabel.text = ProductCopy.rtcVideoThermalDegraded
                UIAccessibility.post(
                    notification: .announcement,
                    argument: ProductCopy.rtcVideoThermalDegraded
                )
            }
        }

        var pauseConfiguration = UIButton.Configuration.filled()
        pauseConfiguration.image = UIImage(systemName: "pause.fill")
        pauseConfiguration.baseBackgroundColor = UIColor.black.withAlphaComponent(0.62)
        pauseConfiguration.baseForegroundColor = .white
        pauseConfiguration.cornerStyle = .capsule
        pauseButton.configuration = pauseConfiguration
        pauseButton.accessibilityLabel = ProductCopy.pauseScan
        pauseButton.translatesAutoresizingMaskIntoConstraints = false
        pauseButton.addTarget(self, action: #selector(togglePause), for: .touchUpInside)
        arView.addSubview(pauseButton)

        let cancelButton = UIButton(type: .system)
        var cancelConfiguration = UIButton.Configuration.filled()
        cancelConfiguration.title = ProductCopy.cancelScan
        cancelConfiguration.baseBackgroundColor = UIColor.black.withAlphaComponent(0.62)
        cancelConfiguration.baseForegroundColor = .white
        cancelConfiguration.cornerStyle = .capsule
        cancelButton.configuration = cancelConfiguration
        cancelButton.translatesAutoresizingMaskIntoConstraints = false
        cancelButton.addTarget(self, action: #selector(cancelScan), for: .touchUpInside)
        arView.addSubview(cancelButton)

        finishButton.accessibilityHint = ProductCopy.finishScanHint
        finishButton.isEnabled = false
        finishButton.translatesAutoresizingMaskIntoConstraints = false
        finishButton.addTarget(self, action: #selector(finishScan), for: .touchUpInside)
        arView.addSubview(finishButton)

        NSLayoutConstraint.activate([
            guidanceLabel.topAnchor.constraint(equalTo: arView.safeAreaLayoutGuide.topAnchor, constant: 12),
            guidanceLabel.centerXAnchor.constraint(equalTo: arView.centerXAnchor),
            guidanceLabel.leadingAnchor.constraint(greaterThanOrEqualTo: arView.leadingAnchor, constant: 72),
            guidanceLabel.trailingAnchor.constraint(lessThanOrEqualTo: arView.trailingAnchor, constant: -72),
            guidanceLabel.heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
            modeLabel.topAnchor.constraint(equalTo: guidanceLabel.bottomAnchor, constant: 10),
            modeLabel.centerXAnchor.constraint(equalTo: arView.centerXAnchor),
            modeLabel.leadingAnchor.constraint(greaterThanOrEqualTo: arView.leadingAnchor, constant: 24),
            modeLabel.trailingAnchor.constraint(lessThanOrEqualTo: arView.trailingAnchor, constant: -24),
            modeLabel.heightAnchor.constraint(greaterThanOrEqualToConstant: 40),
            advisorBar.topAnchor.constraint(equalTo: modeLabel.bottomAnchor, constant: 10),
            advisorBar.leadingAnchor.constraint(equalTo: arView.safeAreaLayoutGuide.leadingAnchor, constant: 14),
            advisorBar.trailingAnchor.constraint(equalTo: arView.safeAreaLayoutGuide.trailingAnchor, constant: -14),
            advisorBar.heightAnchor.constraint(greaterThanOrEqualToConstant: 70),
            advisorLabels.leadingAnchor.constraint(equalTo: advisorBar.contentView.leadingAnchor, constant: 14),
            advisorLabels.centerYAnchor.constraint(equalTo: advisorBar.contentView.centerYAnchor),
            advisorLabels.trailingAnchor.constraint(lessThanOrEqualTo: advisorVoiceButton.leadingAnchor, constant: -10),
            advisorVoiceButton.trailingAnchor.constraint(equalTo: advisorToggleButton.leadingAnchor, constant: -4),
            advisorVoiceButton.centerYAnchor.constraint(equalTo: advisorBar.contentView.centerYAnchor),
            advisorVoiceButton.widthAnchor.constraint(equalToConstant: 44),
            advisorVoiceButton.heightAnchor.constraint(equalToConstant: 44),
            advisorToggleButton.trailingAnchor.constraint(equalTo: advisorBar.contentView.trailingAnchor, constant: -8),
            advisorToggleButton.centerYAnchor.constraint(equalTo: advisorBar.contentView.centerYAnchor),
            advisorToggleButton.widthAnchor.constraint(equalToConstant: 44),
            advisorToggleButton.heightAnchor.constraint(equalToConstant: 44),
            pauseButton.leadingAnchor.constraint(equalTo: arView.safeAreaLayoutGuide.leadingAnchor, constant: 14),
            pauseButton.centerYAnchor.constraint(equalTo: guidanceLabel.centerYAnchor),
            pauseButton.widthAnchor.constraint(equalToConstant: 48),
            pauseButton.heightAnchor.constraint(equalToConstant: 48),
            cancelButton.trailingAnchor.constraint(equalTo: arView.safeAreaLayoutGuide.trailingAnchor, constant: -14),
            cancelButton.centerYAnchor.constraint(equalTo: guidanceLabel.centerYAnchor),
            cancelButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            countLabel.leadingAnchor.constraint(equalTo: arView.safeAreaLayoutGuide.leadingAnchor, constant: 18),
            countLabel.bottomAnchor.constraint(equalTo: suggestionPanel.topAnchor, constant: -10),
            suggestionPanel.leadingAnchor.constraint(equalTo: arView.safeAreaLayoutGuide.leadingAnchor, constant: 14),
            suggestionPanel.trailingAnchor.constraint(equalTo: arView.safeAreaLayoutGuide.trailingAnchor, constant: -14),
            suggestionPanel.bottomAnchor.constraint(equalTo: finishButton.topAnchor, constant: -12),
            suggestionPanel.heightAnchor.constraint(lessThanOrEqualToConstant: 150),
            advisorPanel.leadingAnchor.constraint(equalTo: suggestionPanel.leadingAnchor),
            advisorPanel.trailingAnchor.constraint(equalTo: suggestionPanel.trailingAnchor),
            advisorPanel.bottomAnchor.constraint(equalTo: suggestionPanel.bottomAnchor),
            advisorPanel.heightAnchor.constraint(greaterThanOrEqualToConstant: 150),
            advisorConversationLabel.leadingAnchor.constraint(equalTo: advisorPanel.contentView.leadingAnchor, constant: 14),
            advisorConversationLabel.trailingAnchor.constraint(equalTo: advisorPanel.contentView.trailingAnchor, constant: -14),
            advisorConversationLabel.topAnchor.constraint(equalTo: advisorPanel.contentView.topAnchor, constant: 12),
            advisorInputField.leadingAnchor.constraint(equalTo: advisorConversationLabel.leadingAnchor),
            advisorInputField.topAnchor.constraint(equalTo: advisorConversationLabel.bottomAnchor, constant: 10),
            advisorInputField.bottomAnchor.constraint(equalTo: advisorPanel.contentView.bottomAnchor, constant: -12),
            advisorInputField.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            advisorSendButton.leadingAnchor.constraint(equalTo: advisorInputField.trailingAnchor, constant: 8),
            advisorSendButton.trailingAnchor.constraint(equalTo: advisorConversationLabel.trailingAnchor),
            advisorSendButton.centerYAnchor.constraint(equalTo: advisorInputField.centerYAnchor),
            advisorSendButton.widthAnchor.constraint(equalToConstant: 70),
            advisorSendButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            suggestionsStack.leadingAnchor.constraint(equalTo: suggestionPanel.contentView.leadingAnchor, constant: 14),
            suggestionsStack.trailingAnchor.constraint(equalTo: suggestionPanel.contentView.trailingAnchor, constant: -14),
            suggestionsStack.topAnchor.constraint(equalTo: suggestionPanel.contentView.topAnchor, constant: 12),
            suggestionsStack.bottomAnchor.constraint(equalTo: suggestionPanel.contentView.bottomAnchor, constant: -12),
            finishButton.centerXAnchor.constraint(equalTo: arView.centerXAnchor),
            finishButton.bottomAnchor.constraint(equalTo: arView.safeAreaLayoutGuide.bottomAnchor, constant: -18),
            finishButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 188)
        ])
        UIAccessibility.post(notification: .announcement, argument: modeLabel.text)
    }

    private func suggestionLabel(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.textColor = .white
        label.font = .preferredFont(forTextStyle: .subheadline)
        label.adjustsFontForContentSizeCategory = true
        label.numberOfLines = 2
        return label
    }

    private func suggestionButton(_ suggestion: CameraSuggestion, frameID: UUID) -> UIButton {
        let button = UIButton(type: .system)
        var configuration = UIButton.Configuration.plain()
        configuration.title = "• \(suggestion.title)：\(suggestion.shortAdvice)"
        configuration.baseForegroundColor = .white
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 5, leading: 0, bottom: 5, trailing: 0)
        button.configuration = configuration
        button.contentHorizontalAlignment = .leading
        button.titleLabel?.font = .preferredFont(forTextStyle: .subheadline)
        button.titleLabel?.adjustsFontForContentSizeCategory = true
        button.titleLabel?.numberOfLines = 2
        button.accessibilityHint = ProductCopy.advisorSuggestionHint
        button.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.selectedSuggestionID = suggestion.suggestionID
            self.selectedSuggestionFrameID = frameID.uuidString
            let copy = ProductCopy.advisorSelected(suggestion.title)
            self.advisorSubtitleLabel.text = copy
            self.advisorConversationLabel.text = copy
            self.advisorPanel.isHidden = false
            self.suggestionPanel.isHidden = true
            self.advisorToggleButton.setImage(UIImage(systemName: "chevron.down"), for: .normal)
            self.advisorToggleButton.accessibilityLabel = ProductCopy.advisorClose
            UIAccessibility.post(notification: .announcement, argument: copy)
        }, for: .touchUpInside)
        return button
    }

    @objc private func toggleAdvisorPanel() {
        let shouldOpen = advisorPanel.isHidden
        advisorPanel.isHidden = !shouldOpen
        suggestionPanel.isHidden = shouldOpen
        advisorToggleButton.setImage(
            UIImage(systemName: shouldOpen ? "chevron.down" : "chevron.up"),
            for: .normal
        )
        advisorToggleButton.accessibilityLabel = shouldOpen ? ProductCopy.advisorClose : ProductCopy.advisorOpen
        if shouldOpen { advisorInputField.becomeFirstResponder() }
    }

    @objc private func sendAdvisorQuestion() {
        let question = (advisorInputField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty, advisorSendButton.isEnabled else { return }
        advisorInputField.resignFirstResponder()
        advisorSendButton.isEnabled = false
        advisorConversationLabel.text = ProductCopy.advisorThinking
        let client = self.client!
        Task { [weak self] in
            do {
                let response = try await client.advisorMessage(
                    question,
                    suggestionID: self?.selectedSuggestionID,
                    frameID: self?.selectedSuggestionFrameID
                )
                await MainActor.run {
                    guard let self else { return }
                    self.advisorInputField.text = ""
                    self.advisorConversationLabel.text = response.assistantTurn.text
                    self.advisorSubtitleLabel.text = response.assistantTurn.text
                    self.advisorSendButton.isEnabled = true
                    UIAccessibility.post(notification: .announcement, argument: response.assistantTurn.text)
                }
            } catch is CancellationError {
                return
            } catch {
                await MainActor.run {
                    self?.advisorConversationLabel.text = ProductCopy.advisorMessageFailed
                    self?.advisorSubtitleLabel.text = ProductCopy.advisorMessageFailed
                    self?.advisorSendButton.isEnabled = true
                }
            }
        }
    }

    @objc private func toggleAdvisorVoice() {
        if advisorVoiceState == .speaking {
            advisorVoiceClient.interrupt()
            return
        }
        if advisorVoiceClient.isMicrophoneEnabled {
            advisorVoiceClient.disableMicrophone()
            return
        }
        Task { [weak self] in
            guard let self else { return }
            let allowed = await self.requestMicrophonePermission()
            guard allowed else {
                await MainActor.run {
                    self.advisorSubtitleLabel.text = ProductCopy.advisorMicrophoneDenied
                    self.advisorConversationLabel.text = ProductCopy.advisorMicrophoneDenied
                    self.displayAdvisorVoiceState(.unavailable)
                }
                return
            }
            do {
                if self.advisorVoiceClient.isConnected {
                    try await MainActor.run { try self.advisorVoiceClient.enableMicrophone() }
                } else {
                    let configuration = try await self.client.startAdvisorVoice()
                    guard configuration.isUsable, NativeAdvisorVoiceClient.isSDKAvailable else {
                        throw NativeAdvisorVoiceError.sdkUnavailable
                    }
                    try await MainActor.run {
                        try self.advisorVoiceClient.connect(configuration, microphone: true)
                    }
                }
            } catch {
                await MainActor.run {
                    self.advisorSubtitleLabel.text = ProductCopy.advisorVoiceUnavailable
                    self.advisorConversationLabel.text = ProductCopy.advisorVoiceUnavailable
                    self.displayAdvisorVoiceState(.unavailable)
                }
            }
        }
    }

    private func startAdvisorRealtime() {
        guard NativeAdvisorVoiceClient.isSDKAvailable else { return }
        let client = self.client!
        Task { [weak self] in
            do {
                let configuration = try await client.startAdvisorRealtime()
                guard configuration.supportsVideo else { return }
                try await MainActor.run {
                    guard let self, !self.hasFinished else { return }
                    try self.advisorVoiceClient.connect(
                        configuration,
                        video: true,
                        microphone: false
                    )
                    self.rtcVideoEnabled = true
                    self.rtcRecoveryInProgress = false
                    self.guidanceLabel.text = ProductCopy.homeCameraScanning
                    self.startAdvisorHeartbeat()
                }
            } catch {
                await MainActor.run {
                    self?.rtcVideoEnabled = false
                    self?.rtcRecoveryInProgress = false
                    self?.guidanceLabel.text = ProductCopy.remoteUnavailable
                }
            }
        }
    }

    private func startAdvisorHeartbeat() {
        advisorHeartbeatTask?.cancel()
        let client = self.client!
        advisorHeartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(
                        nanoseconds: NativeAdvisorLeaseRecoveryPolicy.heartbeatIntervalSeconds * 1_000_000_000
                    )
                    guard !Task.isCancelled else { return }
                    _ = try await client.heartbeatAdvisorRTCQueue()
                } catch is CancellationError {
                    return
                } catch {
                    Task {
                        await client.recordAnalytics(
                            "advisor_rtc_lease_recovery_started", payload: ["trigger": "heartbeat_failed"]
                        )
                    }
                    await MainActor.run {
                        guard let self, !self.hasFinished else { return }
                        self.rtcVideoEnabled = false
                        self.guidanceLabel.text = ProductCopy.advisorReconnecting
                        self.recoverAdvisorRealtime()
                    }
                    return
                }
            }
        }
    }

    private func recoverAdvisorRealtime() {
        guard !hasFinished else { return }
        advisorRecoveryTask?.cancel()
        advisorHeartbeatTask?.cancel()
        advisorHeartbeatTask = nil
        let client = self.client!
        rtcVideoEnabled = false
        rtcRecoveryInProgress = true
        clearRealtimeInspectionState()
        advisorRecoveryTask = Task { [weak self] in
            do {
                let configuration = try await client.recoverAdvisorRealtime()
                guard configuration.supportsVideo else { throw RemoteAnalysisError.invalidResponse }
                Task {
                    await client.recordAnalytics("advisor_rtc_lease_recovered", payload: ["holder": "ios_native"])
                }
                try await MainActor.run {
                    guard let self, !self.hasFinished else { return }
                    self.advisorRecoveryTask = nil
                    self.rtcRecoveryInProgress = false
                    try self.advisorVoiceClient.connect(configuration, video: true, microphone: false)
                    self.rtcVideoEnabled = true
                    if self.isPaused || !self.isScanning {
                        self.advisorVoiceClient.pauseMedia()
                        self.guidanceLabel.text = ProductCopy.scanPaused
                    } else {
                        self.guidanceLabel.text = ProductCopy.homeCameraScanning
                    }
                    self.startAdvisorHeartbeat()
                    self.startAdvisorEvents(refreshToken: true)
                }
            } catch is CancellationError {
                return
            } catch {
                Task {
                    await client.recordAnalytics("advisor_rtc_http_fallback", payload: ["reason": "recovery_failed"])
                }
                await MainActor.run {
                    guard let self, !self.hasFinished else { return }
                    self.advisorRecoveryTask = nil
                    self.rtcVideoEnabled = false
                    self.rtcRecoveryInProgress = false
                    self.guidanceLabel.text = self.isPaused || !self.isScanning
                        ? ProductCopy.scanPaused
                        : ProductCopy.remoteUnavailable
                    self.startAdvisorEvents(refreshToken: true)
                }
            }
        }
    }

    private func requestMicrophonePermission() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return true
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                AVCaptureDevice.requestAccess(for: .audio) { continuation.resume(returning: $0) }
            }
        default:
            return false
        }
    }

    @MainActor
    private func displayAdvisorVoiceState(_ state: NativeAdvisorVoiceState) {
        advisorVoiceState = state
        let copy: String
        let symbol: String
        switch state {
        case .idle:
            copy = ProductCopy.advisorDefaultSubtitle
            symbol = "mic.fill"
        case .connecting:
            copy = ProductCopy.advisorConnecting
            symbol = "mic.fill"
        case .listening:
            copy = ProductCopy.advisorListening
            symbol = "mic.slash.fill"
        case .thinking:
            copy = ProductCopy.advisorThinking
            symbol = "waveform"
        case .speaking:
            copy = ProductCopy.advisorSpeaking
            symbol = "stop.fill"
        case .reconnecting:
            copy = ProductCopy.advisorReconnecting
            symbol = "arrow.clockwise"
        case .unavailable:
            copy = ProductCopy.advisorVoiceUnavailable
            symbol = "mic.slash.fill"
        }
        advisorVoiceButton.setImage(UIImage(systemName: symbol), for: .normal)
        advisorVoiceButton.accessibilityLabel = copy
        advisorSubtitleLabel.text = copy
        if state != .idle || advisorConversationLabel.text?.isEmpty == true {
            advisorConversationLabel.text = copy
        }
        if state != .idle { UIAccessibility.post(notification: .announcement, argument: copy) }
    }

    private func startAdvisorEvents(refreshToken: Bool = false) {
        stopAdvisorEvents()
        let client = self.client!
        advisorEventLoopTask = Task { [weak self] in
            let delays: [UInt64] = [1, 2, 4, 8, 15]
            var retryIndex = 0
            var needsToken = refreshToken
            while !Task.isCancelled {
                do {
                    guard let socket = try await client.advisorEventSocket(refreshToken: needsToken) else { return }
                    needsToken = true
                    await MainActor.run {
                        guard let self, !self.hasFinished else { return }
                        self.advisorEventSocket?.cancel(with: .goingAway, reason: nil)
                        self.advisorEventSocket = socket
                        socket.resume()
                    }
                    while !Task.isCancelled {
                        let message = try await socket.receive()
                        let data: Data
                        switch message {
                        case let .data(value): data = value
                        case let .string(value): data = Data(value.utf8)
                        @unknown default: continue
                        }
                        guard let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                              let type = payload["type"] as? String else { continue }
                        if type == "ready" { retryIndex = 0 }
                        if type == "turn",
                           let turn = payload["turn"] as? [String: Any],
                           let turnID = turn["turn_id"] as? String,
                           turn["role"] as? String == "assistant",
                           let text = turn["text"] as? String,
                           !text.isEmpty,
                           self?.shouldHandleAdvisorEvent("turn:\(turnID)") == true {
                            await MainActor.run {
                                self?.advisorSubtitleLabel.text = text
                                self?.advisorConversationLabel.text = text
                            }
                        } else if type == "camera_suggestion_added",
                                  let inspectionID = payload["inspection_id"] as? String,
                                  let frameIDText = payload["frame_id"] as? String,
                                  let value = payload["suggestion"],
                                  let suggestionData = try? JSONSerialization.data(withJSONObject: value),
                                  let suggestion = try? JSONDecoder().decode(CameraSuggestion.self, from: suggestionData),
                                  let frameID = UUID(uuidString: frameIDText),
                                  self?.shouldHandleAdvisorEvent(
                                    "suggestion:\(suggestion.suggestionID ?? inspectionID)"
                                  ) == true {
                            await self?.display(
                                CameraSuggestionResponse(
                                    frameID: frameIDText,
                                    temporary: true,
                                    suggestions: [suggestion]
                                ),
                                frameID: frameID,
                                inspectionID: inspectionID
                            )
                        } else if type == "inspection_state",
                                  let inspectionID = payload["inspection_id"] as? String,
                                  let state = payload["status"] as? String,
                                  ["suggested", "inspected", "expired"].contains(state),
                                  self?.shouldHandleAdvisorEvent(
                                    "inspection:\(inspectionID):\(state)"
                                  ) == true {
                            await self?.finishInspection(inspectionID)
                        }
                    }
                } catch is CancellationError {
                    return
                } catch {
                    guard !Task.isCancelled else { return }
                    let reconnectAttempt = retryIndex + 1
                    Task {
                        await client.recordAnalytics(
                            "advisor_events_reconnecting", payload: ["attempt": String(reconnectAttempt)]
                        )
                    }
                    await MainActor.run {
                        self?.advisorEventSocket?.cancel(with: .goingAway, reason: nil)
                        self?.advisorEventSocket = nil
                        if self?.advisorVoiceState != .idle {
                            self?.displayAdvisorVoiceState(.reconnecting)
                        }
                    }
                    let seconds = delays[min(retryIndex, delays.count - 1)]
                    retryIndex += 1
                    try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)
                }
            }
        }
    }

    private func stopAdvisorEvents() {
        advisorEventLoopTask?.cancel()
        advisorEventLoopTask = nil
        advisorEventSocket?.cancel(with: .goingAway, reason: nil)
        advisorEventSocket = nil
    }

    @MainActor
    private func shouldHandleAdvisorEvent(_ identifier: String) -> Bool {
        handledAdvisorEventIDs.insert(identifier).inserted
    }

    private func clearRealtimeInspectionState() {
        inspectionTimeoutTasks.values.forEach { $0.cancel() }
        inspectionTimeoutTasks.removeAll()
        inspectionGroups.values.forEach { advisorVoiceClient.deleteInspectionImage(groupID: $0) }
        inspectionGroups.removeAll()
        Task { await frameContextStore.removeAll() }
    }

    @objc private func togglePause() {
        guard !hasFinished else { return }
        isPaused.toggle()
        if isPaused {
            isScanning = false
            if spatialMode { captureCoordinator.pause() } else { arView.session.pause() }
            advisorVoiceClient.pauseMedia()
            pauseButton.configuration?.image = UIImage(systemName: "play.fill")
            pauseButton.accessibilityLabel = ProductCopy.resumeScan
            guidanceLabel.text = ProductCopy.scanPaused
        } else {
            pauseButton.configuration?.image = UIImage(systemName: "pause.fill")
            pauseButton.accessibilityLabel = ProductCopy.pauseScan
            startSession()
            advisorVoiceClient.resumeVideo()
            guidanceLabel.text = ProductCopy.homeCameraScanning
        }
    }

    private func processFrameIfNeeded(_ frame: ARFrame) {
        guard isScanning, !isPaused, !hasFinished,
              representativeFrames.count < NativeRealtimeVideoPolicy.maximumCachedFrames,
              frame.timestamp - lastCandidateTime >= selectionPolicy.candidateInterval,
              localFrameGate.begin() else { return }
        lastCandidateTime = frame.timestamp
        let frameID = UUID()
        let transform = frame.camera.transform
        let shouldAcceptSpatial = !spatialMode || hasSpatialMovement(from: lastAcceptedTransform, to: transform)
        guard shouldAcceptSpatial else {
            localFrameGate.end()
            return
        }
        let capturedAt = Int(Date().timeIntervalSince1970 * 1000)
        analysisQueue.async { [weak self] in
            guard let self else { return }
            let quality = self.frameQualityService.evaluate(pixelBuffer: frame.capturedImage)
            let jpeg = quality?.isUsable == true ? self.makeJPEG(from: frame.capturedImage) : nil
            let inspectionJPEG = quality?.isUsable == true
                ? self.makeJPEG(from: frame.capturedImage, maximumEdge: 720, quality: 0.68)
                : nil
            let hash = self.perceptualHash(frame.capturedImage)
            let storedContext = ARFrameContextBuilder.makeStoredContext(frame: frame, frameID: frameID)
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                defer { self.localFrameGate.end() }
                guard !self.hasFinished, let jpeg else {
                    self.guidanceLabel.text = ProductCopy.cameraFrameUnusable
                    return
                }
                if !self.spatialMode, let hash,
                   let previous = self.lastPerceptualHash,
                   !self.selectionPolicy.acceptsPerceptualHash(previous: previous, current: hash) {
                    return
                }
                do {
                    let url = try self.fileStore.save(jpeg, frameID: frameID)
                    self.representativeFrames.append(.init(
                        frameID: frameID, fileURL: url, capturedAtMilliseconds: capturedAt,
                        perceptualHash: hash, brightness: quality?.brightness ?? 0,
                        sharpness: quality?.sharpness ?? 0, byteCount: jpeg.count
                    ))
                    self.enforceRepresentativeCacheLimit()
                    self.finishButton.isEnabled = true
                    self.lastAcceptedTransform = transform
                    self.lastPerceptualHash = hash
                    self.countLabel.text = ProductCopy.savedRepresentativeFrames(
                        min(self.representativeFrames.count, self.captureRequest.remainingSlots),
                        limit: self.captureRequest.remainingSlots
                    )
                    let beginInspection = { [weak self] in
                        self?.inspectIfNeeded(
                            frameID: frameID,
                            jpeg: inspectionJPEG ?? jpeg,
                            timestamp: frame.timestamp,
                            capturedAtMilliseconds: capturedAt,
                            width: CVPixelBufferGetHeight(frame.capturedImage),
                            height: CVPixelBufferGetWidth(frame.capturedImage),
                            hash: hash,
                            quality: quality
                        )
                    }
                    if let storedContext {
                        Task { [weak self] in
                            guard let self else { return }
                            let inserted = await self.frameContextStore.insert(storedContext)
                            await MainActor.run {
                                guard !self.hasFinished else { return }
                                if inserted { beginInspection() }
                                else { self.guidanceLabel.text = ProductCopy.depthContextBusy }
                            }
                        }
                    } else {
                        beginInspection()
                    }
                    if self.representativeFrames.count >= NativeRealtimeVideoPolicy.maximumCachedFrames {
                        self.guidanceLabel.text = ProductCopy.representativeFrameLimitReached
                    }
                } catch {
                    self.guidanceLabel.text = ProductCopy.frameSaveFailed
                }
            }
        }
    }

    private func inspectIfNeeded(
        frameID: UUID,
        jpeg: Data,
        timestamp: TimeInterval,
        capturedAtMilliseconds: Int,
        width: Int,
        height: Int,
        hash: UInt64?,
        quality: FrameQualityResult?
    ) {
        guard !rtcRecoveryInProgress,
              selectionPolicy.permitsModelRequest(
                  elapsed: timestamp - lastModelRequestTime,
                  completedRequests: modelRequestCount
              ),
              modelRequestGate.begin() else { return }
        lastModelRequestTime = timestamp
        modelRequestCount += 1
        let client = self.client!
        Task { [weak self] in
            defer { self?.modelRequestGate.end() }
            do {
                if let self, self.rtcVideoEnabled, self.advisorVoiceClient.isConnected,
                   let hash, let quality {
                    let prepared = try await client.prepareInspection(
                        frameID: frameID,
                        capturedAtMilliseconds: capturedAtMilliseconds,
                        width: width,
                        height: height,
                        perceptualHash: String(format: "%016llx", hash),
                        brightness: quality.brightness,
                        sharpness: quality.sharpness,
                        motion: 0
                    )
                    guard await self.frameContextStore.lock(
                        frameID: frameID,
                        inspectionID: prepared.inspectionID
                    ) else {
                        await MainActor.run { self.guidanceLabel.text = ProductCopy.depthContextBusy }
                        return
                    }
                    do {
                        try await MainActor.run {
                            guard !self.hasFinished else { throw CancellationError() }
                            self.inspectionGroups[prepared.inspectionID] = prepared.groupID
                            try self.advisorVoiceClient.sendInspectionImage(jpeg, prepared: prepared)
                            self.scheduleInspectionTimeout(prepared.inspectionID)
                            self.rtcInspectionFailures = 0
                            self.guidanceLabel.text = ProductCopy.advisorThinking
                        }
                    } catch {
                        await self.finishInspection(prepared.inspectionID)
                        throw error
                    }
                } else {
                    let response = try await client.inspect(frameID: frameID, jpegData: jpeg)
                    guard !Task.isCancelled else { return }
                    await self?.display(response, frameID: frameID, inspectionID: nil)
                }
            } catch is CancellationError {
                return
            } catch {
                await MainActor.run {
                    guard let self else { return }
                    self.rtcInspectionFailures += 1
                    if self.rtcVideoEnabled, self.rtcInspectionFailures >= 3 {
                        self.rtcVideoEnabled = false
                        self.guidanceLabel.text = ProductCopy.remoteUnavailable
                    } else {
                        self.guidanceLabel.text = ProductCopy.remoteUnavailable
                    }
                }
            }
        }
    }

    @MainActor
    private func display(
        _ response: CameraSuggestionResponse,
        frameID: UUID,
        inspectionID: String?
    ) async {
        suggestionsStack.arrangedSubviews.forEach {
            suggestionsStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        if response.suggestions.isEmpty {
            suggestionsStack.addArrangedSubview(suggestionLabel(ProductCopy.directAnalysisNoCandidate))
        } else {
            if let index = representativeFrames.firstIndex(where: { $0.frameID == frameID }) {
                representativeFrames[index].pinned = true
                representativeFrames[index].confidence = max(
                    representativeFrames[index].confidence,
                    response.suggestions.map(\.confidence).max() ?? 0
                )
            }
            if let first = response.suggestions.first {
                advisorSubtitleLabel.text = ProductCopy.advisorTemporarySuggestion(first.title, advice: first.shortAdvice)
            }
            for suggestion in response.suggestions.prefix(3) {
                suggestionsStack.addArrangedSubview(suggestionButton(suggestion, frameID: frameID))
                if spatialMode {
                    let anchored = await addSpatialAnchor(
                        for: suggestion,
                        frameID: frameID,
                        inspectionID: inspectionID
                    )
                    if !anchored { add2DRegion(for: suggestion) }
                } else { add2DRegion(for: suggestion) }
            }
            UIAccessibility.post(
                notification: .announcement,
                argument: ProductCopy.directAnalysisCandidatesFound(response.suggestions.count)
            )
        }
    }

    @MainActor
    private func addSpatialAnchor(
        for suggestion: CameraSuggestion,
        frameID: UUID,
        inspectionID: String?
    ) async -> Bool {
        let stored: StoredFrameContext?
        if let inspectionID {
            stored = await frameContextStore.value(
                inspectionID: inspectionID,
                expectedFrameID: frameID
            )
        } else {
            stored = await frameContextStore.value(for: frameID)
        }
        guard let region = suggestion.region,
              region.type == boundingBoxRegionType,
              let x = region.x, let y = region.y, let width = region.width, let height = region.height,
              let box = NormalizedBoundingBox(xMin: x, yMin: y, xMax: x + width, yMax: y + height),
              let stored,
              let depth = stored.depth,
              let point = WorldPointResolver().resolve(boundingBox: box, frame: stored.context, depth: depth) else {
            return false
        }
        let anchor = AnchorEntity(world: SIMD3<Float>(point.x, point.y, point.z))
        let mesh = MeshResource.generateSphere(radius: 0.045)
        let material = SimpleMaterial(color: .systemOrange, roughness: 0.35, isMetallic: false)
        anchor.addChild(ModelEntity(mesh: mesh, materials: [material]))
        arView.scene.addAnchor(anchor)
        return true
    }

    @MainActor
    private func scheduleInspectionTimeout(_ inspectionID: String) {
        inspectionTimeoutTasks[inspectionID]?.cancel()
        inspectionTimeoutTasks[inspectionID] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(35))
            guard !Task.isCancelled else { return }
            await self?.finishInspection(inspectionID)
        }
    }

    private func finishInspection(_ inspectionID: String) async {
        await MainActor.run {
            inspectionTimeoutTasks.removeValue(forKey: inspectionID)?.cancel()
            if let groupID = inspectionGroups.removeValue(forKey: inspectionID) {
                advisorVoiceClient.deleteInspectionImage(groupID: groupID)
            }
        }
        await frameContextStore.unlock(inspectionID: inspectionID, removeContext: true)
    }

    private func add2DRegion(for suggestion: CameraSuggestion) {
        guard let region = suggestion.region,
              region.type == boundingBoxRegionType,
              let x = region.x, let y = region.y, let width = region.width, let height = region.height else { return }
        arView.subviews.filter { $0.accessibilityIdentifier == "temporary-risk-region" }.forEach { $0.removeFromSuperview() }
        let box = UIView(frame: CGRect(
            x: x * arView.bounds.width,
            y: y * arView.bounds.height,
            width: width * arView.bounds.width,
            height: height * arView.bounds.height
        ))
        box.isUserInteractionEnabled = false
        box.layer.borderColor = UIColor.systemOrange.cgColor
        box.layer.borderWidth = 3
        box.layer.cornerRadius = 8
        box.accessibilityIdentifier = "temporary-risk-region"
        arView.insertSubview(box, belowSubview: guidanceLabel)
    }

    private func hasSpatialMovement(from previous: simd_float4x4?, to current: simd_float4x4) -> Bool {
        guard let previous else { return true }
        let previousPosition = SIMD3<Float>(previous.columns.3.x, previous.columns.3.y, previous.columns.3.z)
        let currentPosition = SIMD3<Float>(current.columns.3.x, current.columns.3.y, current.columns.3.z)
        if Double(simd_distance(previousPosition, currentPosition)) >= selectionPolicy.minimumTranslationMeters { return true }
        let previousRotation = simd_quatf(previous)
        let currentRotation = simd_quatf(current)
        let dot = min(1, abs(simd_dot(previousRotation.vector, currentRotation.vector)))
        return Double(2 * acos(dot)) >= selectionPolicy.minimumRotationRadians
    }

    private func enforceRepresentativeCacheLimit() {
        while representativeFrames.count > NativeRealtimeVideoPolicy.maximumCachedFrames
            || representativeFrames.reduce(0, { $0 + $1.byteCount }) > NativeRealtimeVideoPolicy.maximumCacheBytes {
            let candidates = representativeFrames.indices.filter { !representativeFrames[$0].pinned }
            let eligible = candidates.isEmpty ? Array(representativeFrames.indices) : candidates
            let index = eligible.min { left, right in
                let lhs = representativeFrames[left]
                let rhs = representativeFrames[right]
                let lhsScore = lhs.confidence + lhs.sharpness / 100 - abs(lhs.brightness - 128) / 1_000
                let rhsScore = rhs.confidence + rhs.sharpness / 100 - abs(rhs.brightness - 128) / 1_000
                return lhsScore < rhsScore
            }
            guard let index else { break }
            fileStore.remove(representativeFrames[index].fileURL)
            representativeFrames.remove(at: index)
        }
    }

    private func selectedRepresentativeFrames() -> [RepresentativeFrame] {
        let identifiers = NativeRealtimeVideoPolicy.selectRepresentativeIDs(
            representativeFrames.map { frame in
                NativeRepresentativeCandidate(
                    id: frame.frameID.uuidString,
                    perceptualHash: frame.perceptualHash,
                    pinned: frame.pinned,
                    confidence: frame.confidence,
                    brightness: frame.brightness,
                    sharpness: frame.sharpness
                )
            },
            limit: captureRequest.remainingSlots
        )
        let byID = Dictionary(uniqueKeysWithValues: representativeFrames.map { ($0.frameID.uuidString, $0) })
        return identifiers.compactMap { byID[$0] }
    }

    private func makeJPEG(
        from pixelBuffer: CVPixelBuffer,
        maximumEdge: Double? = nil,
        quality: Double? = nil
    ) -> Data? {
        let image = CIImage(cvPixelBuffer: pixelBuffer).oriented(.right)
        let scale = min(
            1,
            CGFloat(maximumEdge ?? selectionPolicy.maximumImageEdge) / max(image.extent.width, image.extent.height)
        )
        let resized = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cgImage = ciContext.createCGImage(resized, from: resized.extent) else { return nil }
        return UIImage(cgImage: cgImage).jpegData(
            compressionQuality: quality ?? selectionPolicy.jpegQuality
        )
    }

    private func perceptualHash(_ pixelBuffer: CVPixelBuffer) -> UInt64? {
        guard CVPixelBufferGetPlaneCount(pixelBuffer) > 0 else { return nil }
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) else { return nil }
        let width = CVPixelBufferGetWidthOfPlane(pixelBuffer, 0)
        let height = CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
        let stride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
        guard width >= 8, height >= 8 else { return nil }
        let bytes = base.assumingMemoryBound(to: UInt8.self)
        var samples: [UInt8] = []
        for row in 0..<8 {
            for column in 0..<8 {
                let x = min(width - 1, (column * width + width / 2) / 8)
                let y = min(height - 1, (row * height + height / 2) / 8)
                samples.append(bytes[y * stride + x])
            }
        }
        let average = samples.reduce(0) { $0 + Int($1) } / samples.count
        return samples.enumerated().reduce(UInt64(0)) { value, item in
            item.element >= average ? value | (UInt64(1) << UInt64(item.offset)) : value
        }
    }

    @objc private func finishScan() {
        guard !hasFinished else { return }
        hasFinished = true
        advisorVoiceClient.disconnect()
        stopAdvisorEvents()
        advisorHeartbeatTask?.cancel()
        advisorHeartbeatTask = nil
        advisorRecoveryTask?.cancel()
        advisorRecoveryTask = nil
        rtcRecoveryInProgress = false
        clearRealtimeInspectionState()
        stopSession()
        finishButton.isEnabled = false
        guidanceLabel.text = ProductCopy.uploadingRepresentativeFrames
        let frames = selectedRepresentativeFrames()
        let client = self.client!
        let request = captureRequest!
        uploadTask = Task { [weak self] in
            await client.cancelAdvisorRTCQueue()
            await client.cancelPending()
            var uploaded: [String] = []
            var failed = 0
            for (index, frame) in frames.enumerated() {
                guard !Task.isCancelled else { return }
                do {
                    let data = try Data(contentsOf: frame.fileURL)
                    let mediaID = try await client.upload(
                        jpegData: data,
                        sourceKind: "ios_camera_frame",
                        sourceID: frame.frameID.uuidString,
                        frameIndex: index,
                        capturedAtMilliseconds: frame.capturedAtMilliseconds
                    )
                    uploaded.append(mediaID)
                } catch {
                    failed += 1
                }
            }
            await MainActor.run {
                guard let self else { return }
                self.fileStore.removeAll()
                self.releaseResources()
                let status: String
                let errorCode: String?
                if uploaded.isEmpty {
                    status = "failed"
                    errorCode = frames.isEmpty ? "no_representative_frames" : "frame_upload_failed"
                } else if failed > 0 {
                    status = "partial"
                    errorCode = "frame_upload_partial"
                } else {
                    status = "completed"
                    errorCode = nil
                }
                self.onCaptureFinished?(.init(
                    requestID: request.requestID,
                    status: status,
                    roomID: request.roomID,
                    captureMode: self.spatialMode ? "spatial_ar" : "camera_2d",
                    uploadedMediaIDs: uploaded,
                    failedCount: failed,
                    errorCode: errorCode,
                    cameraSessionID: request.cameraSessionID
                ))
            }
        }
    }

    @objc private func cancelScan() {
        guard !hasFinished else { return }
        hasFinished = true
        advisorVoiceClient.disconnect()
        stopAdvisorEvents()
        advisorHeartbeatTask?.cancel()
        advisorHeartbeatTask = nil
        advisorRecoveryTask?.cancel()
        advisorRecoveryTask = nil
        rtcRecoveryInProgress = false
        clearRealtimeInspectionState()
        stopSession()
        uploadTask?.cancel()
        let client = self.client!
        let request = captureRequest!
        Task { [weak self] in
            await client.cancelAdvisorRTCQueue()
            await client.cancelPending()
            await MainActor.run {
                guard let self else { return }
                self.fileStore.removeAll()
                self.releaseResources()
                self.onCaptureFinished?(.init(
                    requestID: request.requestID,
                    status: "cancelled",
                    roomID: request.roomID,
                    captureMode: self.spatialMode ? "spatial_ar" : "camera_2d",
                    uploadedMediaIDs: [],
                    failedCount: 0,
                    errorCode: nil,
                    cameraSessionID: request.cameraSessionID
                ))
            }
        }
    }
}

extension ViewController: ARSessionDelegate {
    public func session(_ session: ARSession, didUpdate frame: ARFrame) {
        DispatchQueue.main.async { [weak self] in
            self?.advisorVoiceClient.pushVideoFrame(frame.capturedImage, timestamp: frame.timestamp)
            self?.processFrameIfNeeded(frame)
        }
    }
}

extension ViewController: RoomCaptureCoordinatorDelegate {
    func roomCaptureCoordinator(_ coordinator: RoomCaptureCoordinator, didUpdate room: CapturedRoom) {}

    func roomCaptureCoordinatorDidStart(_ coordinator: RoomCaptureCoordinator) {
        arView.session.pause()
        arView.session = coordinator.session.arSession
        arView.session.delegate = self
    }

    func roomCaptureCoordinator(_ coordinator: RoomCaptureCoordinator, didFinish data: CapturedRoomData, error: Error?) {}

    func roomCaptureCoordinator(_ coordinator: RoomCaptureCoordinator, didProvide instruction: RoomCaptureSession.Instruction) {
        guard isScanning else { return }
        switch instruction {
        case .moveCloseToWall: guidanceLabel.text = ProductCopy.moveCloser
        case .moveAwayFromWall: guidanceLabel.text = ProductCopy.moveAway
        case .slowDown: guidanceLabel.text = ProductCopy.slowDown
        case .turnOnLight: guidanceLabel.text = ProductCopy.turnOnLight
        case .lowTexture: guidanceLabel.text = ProductCopy.scanCorner
        case .normal: guidanceLabel.text = ProductCopy.homeCameraScanning
        @unknown default: guidanceLabel.text = ProductCopy.scanMore
        }
    }
}
