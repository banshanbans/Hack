import AVFoundation
import RoomPlan
import UIKit

final class OnboardViewController: UIViewController {
    @IBOutlet private weak var BLVAssistanceToggle: UISwitch!

    private enum Step {
        case landing
        case prepare
    }

    private struct RoomOption {
        let title: String
        let value: String
    }

    private let roomOptions = [
        RoomOption(title: "入口区", value: "entrance"),
        RoomOption(title: "主通道", value: "main_aisle"),
        RoomOption(title: "展位区", value: "booth"),
        RoomOption(title: "休息区", value: "rest_area")
    ]

    private let contentStack = UIStackView()
    private let scrollView = UIScrollView()
    private var step: Step = .landing
    private var voiceGuidanceEnabled = false
    private var selectedRoomType = "entrance"
#if DEBUG
    private var didOpenDemoReport = false
#endif

    override func viewDidLoad() {
        super.viewDidLoad()
        UIApplication.shared.isIdleTimerDisabled = false
        configureBaseView()
        showLanding()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
#if DEBUG
        openDemoReportIfRequested()
#endif
    }

#if DEBUG
    /// A local-only launch path for reviewing report UI without camera, LiDAR, or a model.
    private func openDemoReportIfRequested() {
        guard !didOpenDemoReport,
              ProcessInfo.processInfo.arguments.contains("-AnjuOpenDemoReport") else { return }
        didOpenDemoReport = true
        let context = AnjuAppContext.makeDefault(profiles: [], roomType: "entrance")
        DemoIssueFactory.populateIfRequested(context: context, force: true)
        let report = ReportViewController(context: context)
        report.modalPresentationStyle = .fullScreen
        present(report, animated: false)
    }
#endif

    private func configureBaseView() {
        view.subviews.forEach { $0.removeFromSuperview() }
        view.backgroundColor = AnjuTheme.sand

        contentStack.axis = .vertical
        contentStack.spacing = 18
        contentStack.alignment = .fill
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.alwaysBounceVertical = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scrollView)
        scrollView.addSubview(contentStack)
        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            contentStack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor, constant: 24),
            contentStack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor, constant: -24),
            contentStack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: 40),
            contentStack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -40),
            contentStack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor, constant: -48)
        ])
    }

    private func resetContent() {
        contentStack.arrangedSubviews.forEach {
            contentStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
    }

    private func showLanding() {
        step = .landing
        resetContent()
        contentStack.addArrangedSubview(makeEyebrow(ProductCopy.appName))
        contentStack.addArrangedSubview(makeTitle(ProductCopy.homeTitle))
        contentStack.addArrangedSubview(makeSubtitle(ProductCopy.homeSubtitle))
        contentStack.setCustomSpacing(42, after: contentStack.arrangedSubviews.last!)

        let button = AnjuTheme.primaryButton(title: ProductCopy.startRoom)
        button.accessibilityHint = "进入扫描区域选择"
        button.addTarget(self, action: #selector(showPreparation), for: .touchUpInside)
        contentStack.addArrangedSubview(button)
    }

    @objc private func showPreparation() {
        step = .prepare
        resetContent()
        contentStack.addArrangedSubview(makeTitle(ProductCopy.prepareTitle))
        let roomControl = UISegmentedControl(items: roomOptions.map(\.title))
        roomControl.selectedSegmentIndex = roomOptions.firstIndex { $0.value == selectedRoomType } ?? 0
        roomControl.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        roomControl.accessibilityLabel = "扫描区域"
        roomControl.addAction(UIAction { [weak self] action in
            guard let self,
                  let control = action.sender as? UISegmentedControl,
                  self.roomOptions.indices.contains(control.selectedSegmentIndex) else { return }
            self.selectedRoomType = self.roomOptions[control.selectedSegmentIndex].value
        }, for: .valueChanged)
        contentStack.addArrangedSubview(roomControl)

        for tip in ProductCopy.fairPreparationTips {
            let label = makeSubtitle("• \(tip)")
            label.textColor = AnjuTheme.ink
            contentStack.addArrangedSubview(label)
        }
        let voiceRow = UIStackView()
        voiceRow.axis = .horizontal
        voiceRow.alignment = .center
        voiceRow.spacing = 12
        let voiceLabel = makeSubtitle("朗读扫描提示")
        voiceRow.addArrangedSubview(voiceLabel)
        let voiceSwitch = UISwitch()
        voiceSwitch.isOn = voiceGuidanceEnabled
        voiceSwitch.accessibilityLabel = "朗读扫描提示"
        voiceSwitch.addAction(UIAction { [weak self] action in
            guard let control = action.sender as? UISwitch else { return }
            self?.voiceGuidanceEnabled = control.isOn
        }, for: .valueChanged)
        voiceRow.addArrangedSubview(voiceSwitch)
        contentStack.addArrangedSubview(voiceRow)
        contentStack.setCustomSpacing(30, after: contentStack.arrangedSubviews.last!)
        let button = AnjuTheme.primaryButton(title: ProductCopy.beginScan)
        button.addTarget(self, action: #selector(beginScan), for: .touchUpInside)
        contentStack.addArrangedSubview(button)
    }

    @objc private func beginScan() {
        let authorization = AVCaptureDevice.authorizationStatus(for: .video)
        switch authorization {
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    granted ? self?.openScanner() : self?.showPermissionHelp()
                }
            }
        case .authorized:
            openScanner()
        case .denied, .restricted:
            showPermissionHelp()
        @unknown default:
            showPermissionHelp()
        }
    }

    private func openScanner() {
        let context = AnjuAppContext.makeDefault(profiles: [], roomType: selectedRoomType)
        Settings.instance.BLVAssistance = voiceGuidanceEnabled
        guard RoomCaptureSession.isSupported else {
            showUnsupported(context: context)
            return
        }
        guard let scanner = storyboard?.instantiateViewController(withIdentifier: "MainView") as? ViewController else { return }
        scanner.appContext = context
        scanner.onNoAIAction = { [weak self, weak scanner] action in
            scanner?.dismiss(animated: true) {
                switch action {
                case .rescan: self?.showPreparation()
                case .exit: self?.showLanding()
                }
            }
        }
        scanner.modalPresentationStyle = .fullScreen
        present(scanner, animated: true)
    }

    private func showPermissionHelp() {
        let alert = UIAlertController(
            title: ProductCopy.cameraPermissionTitle,
            message: ProductCopy.cameraPermissionMessage,
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: ProductCopy.cancel, style: .cancel))
        alert.addAction(UIAlertAction(title: ProductCopy.openSettings, style: .default) { _ in
            guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
            UIApplication.shared.open(url)
        })
        present(alert, animated: true)
    }

    private func showUnsupported(context: AnjuAppContext) {
        let alert = UIAlertController(
            title: ProductCopy.unsupportedTitle,
            message: ProductCopy.unsupportedMessage,
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: ProductCopy.cancel, style: .cancel))
        alert.addAction(UIAlertAction(title: ProductCopy.demoReport, style: .default) { [weak self] _ in
            DemoIssueFactory.populateIfRequested(context: context, force: true)
            let report = ReportViewController(context: context)
            report.modalPresentationStyle = .fullScreen
            self?.present(report, animated: true)
        })
        present(alert, animated: true)
    }

    private func makeEyebrow(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = .preferredFont(forTextStyle: .headline)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = AnjuTheme.teal
        return label
    }

    private func makeTitle(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = .preferredFont(forTextStyle: .largeTitle)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = AnjuTheme.ink
        label.numberOfLines = 0
        return label
    }

    private func makeSubtitle(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = .preferredFont(forTextStyle: .body)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = AnjuTheme.ink.withAlphaComponent(0.72)
        label.numberOfLines = 0
        return label
    }

}
