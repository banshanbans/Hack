import AVFoundation
import AnjuCore
import RoomPlan
import UIKit
import WebKit

private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?

    init(target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

final class OnboardViewController: UIViewController {
    private static let productionWebURL = "https://shot.socialdog.cn"
    private static let bridgeName = "anjuNative"

    private var webView: WKWebView!
    private let errorView = UIView()
    private let errorLabel = UILabel()
    private var activeRequest: NativeCaptureRequest?
    private weak var activeScanner: ViewController?

    private var webBaseURL: URL {
        let configured = ProcessInfo.processInfo.environment["ANJU_WEB_BASE_URL"]
            ?? Bundle.main.object(forInfoDictionaryKey: "AnjuWebBaseURL") as? String
            ?? Self.productionWebURL
        guard let url = URL(string: configured), url.scheme?.lowercased() == "https" else {
            return URL(string: Self.productionWebURL)!
        }
        return url
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        UIApplication.shared.isIdleTimerDisabled = false
        configureWebView()
        configureErrorView()
        loadHome()
    }

    deinit {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: Self.bridgeName)
    }

    private func configureWebView() {
        view.subviews.forEach { $0.removeFromSuperview() }
        view.backgroundColor = .systemBackground
        let contentController = WKUserContentController()
        contentController.add(WeakScriptMessageHandler(target: self), name: Self.bridgeName)
        let spatial = RoomCaptureSession.isSupported ? "true" : "false"
        let advisorRTCLease = NativeAdvisorVoiceClient.isSDKAvailable ? "true" : "false"
        let bridgeScript = """
        Object.defineProperty(window, '__ANJU_NATIVE__', {
          value: Object.freeze({
            bridge_version: 1,
            capabilities: Object.freeze({photo_capture: true, live_scan: true, spatial_tracking: \(spatial), advisor_rtc_lease: \(advisorRTCLease)})
          }),
          configurable: false,
          writable: false
        });
        """
        contentController.addUserScript(WKUserScript(
            source: bridgeScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.userContentController = contentController
        configuration.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .automatic
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
    }

    private func configureErrorView() {
        errorView.backgroundColor = .systemBackground
        errorView.translatesAutoresizingMaskIntoConstraints = false
        errorView.isHidden = true
        view.addSubview(errorView)

        let icon = UIImageView(image: UIImage(systemName: "wifi.exclamationmark"))
        icon.tintColor = .secondaryLabel
        icon.preferredSymbolConfiguration = .init(pointSize: 42, weight: .regular)
        icon.translatesAutoresizingMaskIntoConstraints = false
        errorView.addSubview(icon)

        errorLabel.text = "无法打开安心家 AI\n请检查网络后重试"
        errorLabel.numberOfLines = 0
        errorLabel.textAlignment = .center
        errorLabel.font = .preferredFont(forTextStyle: .title3)
        errorLabel.adjustsFontForContentSizeCategory = true
        errorLabel.translatesAutoresizingMaskIntoConstraints = false
        errorView.addSubview(errorLabel)

        let retry = UIButton(type: .system)
        var configuration = UIButton.Configuration.filled()
        configuration.title = "重试"
        configuration.cornerStyle = .large
        configuration.contentInsets = .init(top: 16, leading: 36, bottom: 16, trailing: 36)
        retry.configuration = configuration
        retry.accessibilityHint = "重新加载线上页面"
        retry.addTarget(self, action: #selector(retryLoad), for: .touchUpInside)
        retry.translatesAutoresizingMaskIntoConstraints = false
        errorView.addSubview(retry)

        NSLayoutConstraint.activate([
            errorView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            errorView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            errorView.topAnchor.constraint(equalTo: view.topAnchor),
            errorView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            icon.centerXAnchor.constraint(equalTo: errorView.centerXAnchor),
            icon.bottomAnchor.constraint(equalTo: errorLabel.topAnchor, constant: -20),
            errorLabel.centerXAnchor.constraint(equalTo: errorView.centerXAnchor),
            errorLabel.centerYAnchor.constraint(equalTo: errorView.centerYAnchor),
            errorLabel.leadingAnchor.constraint(greaterThanOrEqualTo: errorView.leadingAnchor, constant: 28),
            errorLabel.trailingAnchor.constraint(lessThanOrEqualTo: errorView.trailingAnchor, constant: -28),
            retry.topAnchor.constraint(equalTo: errorLabel.bottomAnchor, constant: 28),
            retry.centerXAnchor.constraint(equalTo: errorView.centerXAnchor),
            retry.heightAnchor.constraint(greaterThanOrEqualToConstant: 56)
        ])
    }

    private func loadHome() {
        var components = URLComponents(url: webBaseURL, resolvingAgainstBaseURL: false)
        components?.fragment = "/home"
        guard let url = components?.url else { return }
        errorView.isHidden = true
        webView.load(URLRequest(url: url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 30))
    }

    @objc private func retryLoad() {
        loadHome()
    }

    private func handleBridgeMessage(_ message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.protocol.lowercased() == "https",
              message.frameInfo.securityOrigin.host.lowercased() == webBaseURL.host?.lowercased(),
              JSONSerialization.isValidJSONObject(message.body),
              let data = try? JSONSerialization.data(withJSONObject: message.body),
              let request = try? JSONDecoder().decode(NativeCaptureRequest.self, from: data),
              request.isValid else {
            return
        }

        if request.command == .cancelNativeCapture {
            cancelActiveCapture(requestID: request.requestID)
            return
        }
        guard activeRequest == nil else {
            sendResult(.init(
                requestID: request.requestID, status: "failed", roomID: request.roomID,
                captureMode: request.command == .capturePhoto ? "photo" : "camera_2d",
                uploadedMediaIDs: [], failedCount: 0, errorCode: "native_capture_busy"
            ))
            return
        }
        activeRequest = request
        switch request.command {
        case .capturePhoto:
            startPhotoCapture(request)
        case .startLiveScan:
            startLiveScan(request)
        case .cancelNativeCapture:
            break
        }
    }

    private func startPhotoCapture(_ request: NativeCaptureRequest) {
        guard request.remainingSlots > 0, UIImagePickerController.isSourceTypeAvailable(.camera) else {
            finishActiveRequest(.init(
                requestID: request.requestID, status: "failed", roomID: request.roomID,
                captureMode: "photo", uploadedMediaIDs: [], failedCount: 1, errorCode: "camera_unavailable"
            ))
            return
        }
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.delegate = self
        picker.modalPresentationStyle = .fullScreen
        present(picker, animated: true)
    }

    private func startLiveScan(_ request: NativeCaptureRequest) {
        guard request.remainingSlots > 0,
              let scanner = storyboard?.instantiateViewController(withIdentifier: "MainView") as? ViewController else {
            finishActiveRequest(.init(
                requestID: request.requestID, status: "failed", roomID: request.roomID,
                captureMode: "camera_2d", uploadedMediaIDs: [], failedCount: 0, errorCode: "media_limit_reached"
            ))
            return
        }
        scanner.captureRequest = request
        scanner.spatialMode = RoomCaptureSession.isSupported
        scanner.onCaptureFinished = { [weak self, weak scanner] result in
            scanner?.dismiss(animated: true) {
                self?.finishActiveRequest(result)
            }
        }
        activeScanner = scanner
        scanner.modalPresentationStyle = .fullScreen
        present(scanner, animated: true)
    }

    private func cancelActiveCapture(requestID: String) {
        guard let request = activeRequest, request.requestID == requestID else { return }
        activeScanner?.cancelFromBridge()
        if presentedViewController is UIImagePickerController {
            dismiss(animated: true)
            finishActiveRequest(.init(
                requestID: request.requestID, status: "cancelled", roomID: request.roomID,
                captureMode: "photo", uploadedMediaIDs: [], failedCount: 0, errorCode: nil
            ))
        }
    }

    private func finishActiveRequest(_ result: NativeCaptureResult) {
        activeRequest = nil
        activeScanner = nil
        sendResult(result)
    }

    private func sendResult(_ result: NativeCaptureResult) {
        guard let data = try? JSONEncoder().encode(result),
              let json = String(data: data, encoding: .utf8) else { return }
        let script = "window.dispatchEvent(new CustomEvent('anju:native-capture-result',{detail:\(json)}));"
        webView.evaluateJavaScript(script)
    }

    private func preparedJPEG(from image: UIImage) -> Data? {
        let policy = NativeFrameSelectionPolicy.homeCamera
        let longest = max(image.size.width, image.size.height)
        let scale = min(1, CGFloat(policy.maximumImageEdge) / max(longest, 1))
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let normalized = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        return normalized.jpegData(compressionQuality: policy.jpegQuality)
    }
}

extension OnboardViewController: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.bridgeName else { return }
        handleBridgeMessage(message)
    }
}

extension OnboardViewController: WKNavigationDelegate, WKUIDelegate {
    @available(iOS 15.0, *)
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        guard frame.isMainFrame,
              origin.protocol.lowercased() == "https",
              origin.host.lowercased() == webBaseURL.host?.lowercased(),
              type == .microphone else {
            decisionHandler(.deny)
            return
        }
        do {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: [.defaultToSpeaker, .allowBluetooth]
            )
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
            decisionHandler(.grant)
        } catch {
            decisionHandler(.deny)
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if url.scheme == "about" || (url.scheme == "https" && url.host?.lowercased() == webBaseURL.host?.lowercased()) {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
            if ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                UIApplication.shared.open(url)
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        errorView.isHidden = true
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        errorView.isHidden = false
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        errorView.isHidden = false
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url { UIApplication.shared.open(url) }
        return nil
    }
}

extension OnboardViewController: UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        guard let request = activeRequest else {
            picker.dismiss(animated: true)
            return
        }
        picker.dismiss(animated: true) { [weak self] in
            self?.finishActiveRequest(.init(
                requestID: request.requestID, status: "cancelled", roomID: request.roomID,
                captureMode: "photo", uploadedMediaIDs: [], failedCount: 0, errorCode: nil
            ))
        }
    }

    func imagePickerController(
        _ picker: UIImagePickerController,
        didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
    ) {
        guard let request = activeRequest,
              let image = info[.originalImage] as? UIImage,
              let jpeg = preparedJPEG(from: image),
              let client = RemoteAnalysisClient(baseURL: webBaseURL, request: request) else {
            picker.dismiss(animated: true)
            if let request = activeRequest {
                finishActiveRequest(.init(
                    requestID: request.requestID, status: "failed", roomID: request.roomID,
                    captureMode: "photo", uploadedMediaIDs: [], failedCount: 1, errorCode: "photo_processing_failed"
                ))
            }
            return
        }
        picker.dismiss(animated: true)
        Task { [weak self] in
            do {
                let mediaID = try await client.upload(
                    jpegData: jpeg, sourceKind: "photo", sourceID: nil,
                    frameIndex: nil, capturedAtMilliseconds: Int(Date().timeIntervalSince1970 * 1000)
                )
                await MainActor.run {
                    self?.finishActiveRequest(.init(
                        requestID: request.requestID, status: "completed", roomID: request.roomID,
                        captureMode: "photo", uploadedMediaIDs: [mediaID], failedCount: 0, errorCode: nil
                    ))
                }
            } catch {
                await MainActor.run {
                    self?.finishActiveRequest(.init(
                        requestID: request.requestID, status: "failed", roomID: request.roomID,
                        captureMode: "photo", uploadedMediaIDs: [], failedCount: 1, errorCode: "photo_upload_failed"
                    ))
                }
            }
        }
    }
}
