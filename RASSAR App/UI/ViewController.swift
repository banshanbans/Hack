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
public class ViewController: UIViewController {
    
    @IBOutlet var arView: ARView!
    var appContext: AnjuAppContext!
    private let captureCoordinator = RoomCaptureCoordinator()
    private let frameContextStore = FrameContextStore(capacity: 4)
    private var issueAnchorStore: IssueAnchorStore!
    private var issueOverlayCoordinator: IssueOverlayCoordinator!
    private let issueMiniMapView = IssueMiniMapView()
    private var remoteAnalysisTask: Task<Void, Never>?
    private var lastRemoteAnalysisTime: TimeInterval = 0
    private var lastQualityAnalysisTime: TimeInterval = 0
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
    private var announcedIssueIDs: Set<UUID> = []
    private var finalResults: CapturedRoom?
    var replicator = RoomObjectReplicator()
    private var visionTimer: Timer?
    private var ruleTimer: Timer?
    private var AnchorList=[ARAnchor]()
    var ODResults: [VNObservation]=[VNObservation]();
    private var requests = [VNRequest]()
    private var detectionOverlay: CALayer! = nil
    var bufferSize: CGSize = .zero
    var rootLayer: CALayer! = nil
    
    var detector:ObjectDetection=ObjectDetection()
    var boundingBoxes = [BoundingBox]()
    var colors: [UIColor] = []
    let maxBoundingBoxes = 10
    let ciContext = CIContext()
    var resizedPixelBuffer: CVPixelBuffer?
    var showBbox:Bool=false
    var minimap:MiniMapLayer?
    var resizers:[YOLOResizer]=[YOLOResizer]()
    let roombuilder=RoomBuilder(options: [.beautifyObjects])
    var manager = FileManager.default
    let screenSize: CGRect = UIScreen.main.bounds
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
    private var bboxOverlay: CALayer! = nil
    
    var voiceSynthesizer:AVSpeechSynthesizer?
    var assistiveVoice:AVSpeechSynthesisVoice?
    //let speechRecognizer = SFSpeechRecognizer()
    let audioEngine = AVAudioEngine()
    //var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    //var recognitionTask: SFSpeechRecognitionTask?
    var speechAuthorized:Bool=false
    var audioQueue = [AudioFeedback]()
    private let guidanceLabel = UILabel()
    
    public override func viewDidLoad() {
        super.viewDidLoad()
        if appContext == nil {
            appContext = AnjuAppContext.makeDefault(profiles: ["older_adult"], roomType: "bedroom")
        }
        Settings.instance.viewcontroller=self
        Settings.instance.community = legacyCommunities(for: appContext.session.profiles)
        UIApplication.shared.isIdleTimerDisabled=true
        replicator.setView(view:arView)
        Settings.instance.setReplicator(rep: replicator)
        showBbox=false
        captureCoordinator.delegate = self
        setupRoomCapture()
        setupLayers()
        configureProductOverlay()
        issueAnchorStore = IssueAnchorStore(arView: arView)
        issueOverlayCoordinator = IssueOverlayCoordinator(containerView: arView)
        issueOverlayCoordinator.onIssueSelected = { [weak self] issue in
            self?.presentIssueDetail(issue)
        }
        
        setUpBoundingBoxes()
        setUpCoreImage()
        setUpYOLOResizers()
        visionTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true, block: { [weak self] _ in
            guard let self, self.isScanning else { return }
            for resizer in self.resizers {
                self.updateOD(resizer: resizer)
            }
        })
        
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
        rootLayer.addSublayer(minimap!)
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
        rootLayer=view.layer
        bufferSize=CGSize(width: rootLayer.bounds.width, height: rootLayer.bounds.height)
        
        ruleTimer = Timer.scheduledTimer(withTimeInterval: 0.75, repeats: true, block: { [weak self] _ in
            guard let self, self.isScanning else { return }
            self.replicator.updateAccessibilityIssue(in:self.captureCoordinator.session)
            self.synchronizeLegacyIssues()
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

    private func stopAnalysisWork() {
        visionTimer?.invalidate()
        ruleTimer?.invalidate()
        remoteAnalysisTask?.cancel()
        Task {
            await appContext.remoteAnalysis.cancelPending()
            await frameContextStore.removeAll()
        }
    }

    private func legacyCommunities(for profiles: Set<String>) -> [Community] {
        var result: [Community] = []
        if !profiles.isDisjoint(with: ["older_adult", "night_walking"]) {
            result.append(.elder)
        }
        if !profiles.isDisjoint(with: ["limited_mobility", "mobility_aid"]) {
            result.append(.wheelchair)
        }
        return result.isEmpty ? [.elder] : result
    }
    func setUpBoundingBoxes() {
        for _ in 0 ..< maxBoundingBoxes {
            boundingBoxes.append(BoundingBox())
        }
        
        // Make colors for the bounding boxes. There is one color for each class,
        // 20 classes in total.
        for r: CGFloat in [0.1,0.2, 0.3,0.4,0.5, 0.6,0.7, 0.8,0.9, 1.0] {
            for g: CGFloat in [0.3,0.5, 0.7,0.9] {
                for b: CGFloat in [0.4,0.6 ,0.8] {
                    let color = UIColor(red: r, green: g, blue: b, alpha: 1)
                    colors.append(color)
                }
            }
        }
        DispatchQueue.main.async {
            let boxes = self.boundingBoxes
            guard let videoLayer  = self.bboxOverlay else {return}
            for box in boxes {
                box.addToLayer(videoLayer)
            }
        }
    }
    
    func setUpCoreImage() {
        let status = CVPixelBufferCreate(nil, Settings.instance.yoloInputWidth, Settings.instance.yoloInputHeight,
                                         kCVPixelFormatType_32BGRA, nil,
                                         &resizedPixelBuffer)
        if status != kCVReturnSuccess {
            print("Error: could not create resized pixel buffer", status)
        }
    }
    func setupLayers() {
        detectionOverlay = CALayer() // container layer that has all the renderings of the observations
        detectionOverlay.name = "DetectionOverlay"
        detectionOverlay.bounds = CGRect(x: 0.0,
                                         y: 0.0,
                                         width: 0,
                                         height: 0)
        detectionOverlay.position = CGPoint(x: 0, y: 0)
        rootLayer.addSublayer(detectionOverlay)
        
        bboxOverlay = CALayer() // container layer that has all the renderings of the observations
        bboxOverlay.name = "BoundingBoxOverlay"
        bboxOverlay.bounds = CGRect(x: 0.0,
                                         y: 0.0,
                                         width: 0,
                                         height: 0)
        bboxOverlay.position = CGPoint(x: 0, y: 0)
        rootLayer.addSublayer(bboxOverlay)
    }
    func setUpYOLOResizers(){
        //Firstly, we have a null resizer that does nothing.
        //TODO: First test the resized one, then update the showing func to show both results
        //resizers.append(YOLOResizer(fullBufferSize: CGSize(width:1440,height:1920), fullScreenSize: CGSize(width:428,height:926), croppingPosition: .middle, croppingRatio: 1))
        
        //Then add a middle part resizer
        let middleResizer=YOLOResizer(fullBufferSize: CGSize(width:1440,height:1920), fullScreenSize: CGSize(width:screenSize.width,height:screenSize.height), croppedBufferSize: CGSize(width: 700, height: 700), croppingPosition: .middle, rotate: .up)
        resizers.append(middleResizer)
        rootLayer.addSublayer(middleResizer.getNotifyingFrame())
    }
    func updateOD(resizer:YOLOResizer){
        //try to add od here
        guard let currentFrame = captureCoordinator.currentFrame else {
            return
        }
        let buffer = currentFrame.capturedImage
        //visionRequest(buffer)
        predict(pixelBuffer: buffer,resizer: resizer)
    }
    func predict(pixelBuffer: CVPixelBuffer,resizer:YOLOResizer) {
        
        // Measure how long it takes to predict a single video frame.
        let startTime = CACurrentMediaTime()
        let observations = detector.detectAndProcess(image: resizer.resizeImage(buffer: pixelBuffer))
        let elapsed = CACurrentMediaTime() - startTime
        let resizedBbox=resizer.resizeResults(initialResults:observations)
        showOnMainThread(resizedBbox, elapsed)
    }
    
    func showOnMainThread(_ boundingBoxes: [Prediction], _ elapsed: CFTimeInterval) {
        DispatchQueue.main.async { [weak self] in
            // For debugging, to make sure the resized CVPixelBuffer is correct.
            //var debugImage: CGImage?
            //VTCreateCGImageFromCVPixelBuffer(resizedPixelBuffer, nil, &debugImage)
            //self.debugImageView.image = UIImage(cgImage: debugImage!)
            
            self?.show(predictions: boundingBoxes)
        }
    }
    
    func show(predictions: [Prediction]){
        //var centers:[CGPoint]=[CGPoint]()
        
        var ODAnchors=[DetectedObjectAnchor]()
        for i in 0..<boundingBoxes.count {
            if i < predictions.count {
                let prediction = predictions[i]
                
                let rect = prediction.rect
                // Show the bounding box.
                let label = String(format: "%@ %.1f", detector.names[prediction.classIndex], prediction.score)
                let color = colors[prediction.classIndex]
                if showBbox && !extendedViewIsOut{
                    //print("showing result")
                    //print(label)
                    //print(rect.origin)
                    //print(rect.size)
                    boundingBoxes[i].show(frame: rect, label: label, color: color)
                }
                //Conduct raycast to find 3D pos of item
                if Settings.instance.raycastEnabled == false{
                    return
                }
                //let center=CGPoint(x: rect.origin.x/view.bounds.width, y: rect.origin.y/view.bounds.height)
                let name = detector.names[prediction.classIndex]
                let normalizedName = name.lowercased()
                let sampleY = normalizedName.contains("rug") || normalizedName.contains("carpet")
                    ? rect.maxY - rect.height * 0.12
                    : rect.midY
                let center = CGPoint(x: rect.midX, y: sampleY)
                //let session=roomCaptureSession!.arSession
//                let cameraTransform=roomCaptureView.captureSession.arSession.currentFrame?.camera.transform
//                let cameraPosition = SIMD3(x: cameraTransform!.columns.3.x, y: cameraTransform!.columns.3.y, z: cameraTransform!.columns.3.z)
//                let query=session.currentFrame?.raycastQuery(from: center, allowing: .estimatedPlane, alignment:.any)
//                print(query?.origin)
//                print(cameraPosition)
                //Only cast for centered points
                if view.bounds.insetBy(dx: 24, dy: 24).contains(center) {
                    if let cast = preferredRaycast(from: center) {
                        //print("A successful cast")
                        let resultAnchor = ARAnchor(transform:  cast.worldTransform)
                        let odAnchor=DetectedObjectAnchor(anchor: resultAnchor, rect:rect,cat: name, identifier: UUID.init())
                        if odAnchor.category != nil{
                            ODAnchors.append(odAnchor)
                        }
                        if normalizedName.contains("rug") || normalizedName.contains("carpet") {
                            observeLocalRug(at: cast.worldTransform, confidence: prediction.score)
                        }
                        //replicator.addODAnchor(anchor:odAnchor)
    //                    session.add(anchor: odAnchor)
                        //let resultAnchor = AnchorEntity(world: cast.worldTransform)
                        //resultAnchor.addChild(sphere(radius: 0.05, color: .lightGray))
                        //arView.scene.addAnchor(resultAnchor)
                    }
                }
                //centers.append(CGPoint(x: rect.origin.x, y: rect.origin.y))
                
            } else {
                boundingBoxes[i].hide()
            }
        }
        replicator.addODAnchor(anchors: ODAnchors)
    }

    private func preferredRaycast(from point: CGPoint) -> ARRaycastResult? {
        if let result = arView.raycast(from: point, allowing: .existingPlaneGeometry, alignment: .any).first {
            return result
        }
        if let result = arView.raycast(from: point, allowing: .existingPlaneInfinite, alignment: .any).first {
            return result
        }
        return arView.raycast(from: point, allowing: .estimatedPlane, alignment: .any).first
    }

    private func observeLocalRug(at transform: simd_float4x4, confidence: Float) {
        let point = WorldPoint(
            x: transform.columns.3.x,
            y: transform.columns.3.y,
            z: transform.columns.3.z
        )
        let candidate = IssueCandidate(
            type: .looseRug,
            observation: ProductCopy.rugNeedsCheckObservation,
            needsManualCheck: true,
            confidence: confidence,
            source: .localVision,
            evidence: .init(worldPoint: point),
            worldTransform: LegacyIssueAdapter.translationMatrix(for: point)
        )
        guard let issue = appContext.detectionEngine.makeIssue(
            from: candidate,
            sessionID: appContext.session.id,
            roomType: appContext.session.roomType,
            profiles: appContext.session.profiles
        ) else { return }
        appContext.repository.observe(issue)
    }
    public override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?)
    {
        super.touchesBegan(touches, with: event)
        if !extendedViewIsOut{
            if let touch = touches.first{
                let view = self.view!
                let touchLocation = touch.location(in: view)
                let locationInView = view.convert(touchLocation, to: nil)
                //print(locationInView)
                let transformedLocation=CGPoint(x: locationInView.x+35, y: locationInView.y+35)
                if let sublayers = detectionOverlay.sublayers{
                    for layer in sublayers{
                        if layer.contains(transformedLocation){
                            if layer is IssueLayer{
                                let issueLayer = layer as! IssueLayer
                                //This is where we used to add popping up layer. Now cancel this to use as cancel issue
                                //rootLayer.addSublayer(issueLayer.getExtendedLayer())
                                //let issueView=PopupView(issue: issueLayer.issue,controller:self)
                                //self.view.addSubview(issueView)
                                self.arView.addSubview(issueLayer.getExtendedView(parent: self))
                                extendedViewIsOut=true
                                //issueLayer.issue.cancel()
                                //print("Trying to add another layer")
                            }
                        }
                        else{
                            //print("Layer doesn't contain click")
                        }
                    }
                }
            }
        }
        
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

        NSLayoutConstraint.activate([
            guidanceLabel.topAnchor.constraint(equalTo: arView.safeAreaLayoutGuide.topAnchor, constant: 12),
            guidanceLabel.centerXAnchor.constraint(equalTo: arView.centerXAnchor),
            guidanceLabel.widthAnchor.constraint(lessThanOrEqualTo: arView.widthAnchor, multiplier: 0.66),
            guidanceLabel.heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
            pause.leadingAnchor.constraint(equalTo: arView.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            pause.centerYAnchor.constraint(equalTo: guidanceLabel.centerYAnchor),
            pause.widthAnchor.constraint(equalToConstant: 48),
            pause.heightAnchor.constraint(equalToConstant: 48),
            finishButton.centerXAnchor.constraint(equalTo: arView.centerXAnchor),
            finishButton.bottomAnchor.constraint(equalTo: arView.safeAreaLayoutGuide.bottomAnchor, constant: -18),
            finishButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 180),
            issueMiniMapView.leadingAnchor.constraint(equalTo: arView.safeAreaLayoutGuide.leadingAnchor, constant: 14),
            issueMiniMapView.bottomAnchor.constraint(equalTo: finishButton.topAnchor, constant: -14),
            issueMiniMapView.widthAnchor.constraint(equalToConstant: 132),
            issueMiniMapView.heightAnchor.constraint(equalToConstant: 132)
        ])
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

        stopAnalysisWork()
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
        synchronizeLegacyIssues()

        if let error {
            logger.error("Room capture ended with recoverable error: \(error.localizedDescription, privacy: .public)")
        }
        let report = ReportViewController(context: appContext)
        report.modalPresentationStyle = .fullScreen
        present(report, animated: true)
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

    func synchronizeLegacyIssues() {
        for legacy in replicator.getAllIssuesToBePresented() where !legacy.cancelled {
            guard let candidate = LegacyIssueAdapter.candidate(from: legacy),
                  let issue = appContext.detectionEngine.makeIssue(
                    from: candidate,
                    sessionID: appContext.session.id,
                    roomType: appContext.session.roomType,
                    profiles: appContext.session.profiles
                  ) else { continue }
            if let stored = appContext.repository.observe(issue),
               stored.severity == .high,
               announcedIssueIDs.insert(stored.id).inserted,
               Settings.instance.BLVAssistance {
                speak(content: ProductCopy.shortLabel(for: stored.type))
            }
        }
        issueAnchorStore?.synchronize(appContext.repository.issues)
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
        guard appContext.remoteAnalysis.isEnabled,
              frame.timestamp - lastRemoteAnalysisTime >= 5,
              remoteAnalysisTask == nil else { return }
        lastRemoteAnalysisTime = frame.timestamp
        let frameID = UUID()
        let remote = appContext.remoteAnalysis
        let roomType = appContext.session.roomType
        let profiles = appContext.session.profiles
        let sessionID = appContext.session.id
        let detectionEngine = appContext.detectionEngine
        let repository = appContext.repository
        let store = frameContextStore
        let sourceFrame = frame

        analysisQueue.async { [weak self] in
            guard let self,
                  let stored = ARFrameContextBuilder.makeStoredContext(frame: sourceFrame, frameID: frameID),
                  let jpeg = self.makeJPEG(from: sourceFrame.capturedImage) else {
                DispatchQueue.main.async { [weak self] in self?.remoteAnalysisTask = nil }
                return
            }
            let task = Task { [weak self] in
                await store.insert(stored)
                defer {
                    Task { await store.remove(frameID: frameID) }
                    Task { @MainActor [weak self] in self?.remoteAnalysisTask = nil }
                }
                do {
                    let candidates = try await remote.analyze(frameID: frameID, jpegData: jpeg, roomType: roomType)
                    let resolver = WorldPointResolver()
                    for candidate in candidates {
                        var evidence = candidate.evidence
                        if let box = evidence.boundingBox,
                           let depth = stored.depth,
                           let point = resolver.resolve(boundingBox: box, frame: stored.context, depth: depth) {
                            evidence.worldPoint = point
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
                        await MainActor.run {
                            if let issue = detectionEngine.makeIssue(
                                from: enriched,
                                sessionID: sessionID,
                                roomType: roomType,
                                profiles: profiles
                            ) {
                                repository.observe(issue)
                            }
                        }
                    }
                } catch is CancellationError {
                    return
                } catch {
                    self?.logger.notice("Remote analysis unavailable; local scan continues")
                }
            }
            DispatchQueue.main.async { [weak self] in self?.remoteAnalysisTask = task }
        }
    }

    func scheduleQualityAnalysisIfNeeded(_ frame: ARFrame) {
        guard frame.timestamp - lastQualityAnalysisTime >= 2 else { return }
        lastQualityAnalysisTime = frame.timestamp
        let frameID = UUID()
        let pixelBuffer = frame.capturedImage
        let quality = frameQualityService
        guard let context = appContext else { return }
        analysisQueue.async {
            guard let candidate = quality.lowLightCandidate(pixelBuffer: pixelBuffer, frameID: frameID) else { return }
            DispatchQueue.main.async {
                guard let issue = context.detectionEngine.makeIssue(
                        from: candidate,
                        sessionID: context.session.id,
                        roomType: context.session.roomType,
                        profiles: context.session.profiles
                      ) else { return }
                context.repository.observe(issue)
            }
        }
    }

    func makeJPEG(from pixelBuffer: CVPixelBuffer) -> Data? {
        let image = CIImage(cvPixelBuffer: pixelBuffer).oriented(.right)
        let scale = min(1, 1280 / max(image.extent.width, image.extent.height))
        let resized = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cgImage = ciContext.createCGImage(resized, from: resized.extent) else { return nil }
        return UIImage(cgImage: cgImage).jpegData(compressionQuality: 0.72)
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
            self.detectionOverlay.sublayers = nil
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
        scheduleQualityAnalysisIfNeeded(frame)

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
