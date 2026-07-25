import AnjuCore
import UIKit

@MainActor
final class IssueDetailViewController: UIViewController {
    private let issueID: UUID
    private let repository: ScanIssueRepository
    private let onChange: () -> Void

    init(issueID: UUID, repository: ScanIssueRepository, onChange: @escaping () -> Void) {
        self.issueID = issueID
        self.repository = repository
        self.onChange = onChange
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        configureView()
    }

    private func configureView() {
        guard let issue = repository.issue(id: issueID) else {
            dismiss(animated: true)
            return
        }
        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        let scrollView = UIScrollView()
        scrollView.alwaysBounceVertical = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scrollView)
        scrollView.addSubview(stack)
        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: 64),
            stack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -24),
            stack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor, constant: -48)
        ])

        let header = UILabel()
        header.text = ProductCopy.severityLabel(issue.severity)
        header.font = .preferredFont(forTextStyle: .headline)
        header.adjustsFontForContentSizeCategory = true
        header.textColor = AnjuTheme.severityColor(issue.severity)
        stack.addArrangedSubview(header)

        let title = makeLabel(issue.title, style: .title1, color: AnjuTheme.ink)
        title.accessibilityTraits = .header
        stack.addArrangedSubview(title)
        stack.addArrangedSubview(makeSection(title: "为什么值得注意", body: issue.observation))
        stack.addArrangedSubview(makeSection(title: "现在可以怎么做", body: issue.recommendation))

        if issue.needsManualCheck {
            let note = makeLabel("这项内容只根据当前证据给出提示，建议在现场再确认。", style: .callout, color: AnjuTheme.check)
            note.backgroundColor = AnjuTheme.check.withAlphaComponent(0.09)
            note.layer.cornerRadius = 10
            note.layer.masksToBounds = true
            stack.addArrangedSubview(note)
        }

        let confirm = AnjuTheme.primaryButton(title: ProductCopy.confirmIssue)
        confirm.addAction(UIAction { [weak self] _ in self?.setState(.confirmed) }, for: .touchUpInside)
        stack.addArrangedSubview(confirm)

        let resolved = UIButton(type: .system)
        var resolvedConfiguration = UIButton.Configuration.bordered()
        resolvedConfiguration.title = issue.state == .resolved ? ProductCopy.resolved : ProductCopy.markResolved
        resolvedConfiguration.cornerStyle = .large
        resolved.configuration = resolvedConfiguration
        resolved.heightAnchor.constraint(greaterThanOrEqualToConstant: 52).isActive = true
        resolved.addAction(UIAction { [weak self] _ in self?.setState(.resolved) }, for: .touchUpInside)
        stack.addArrangedSubview(resolved)

        let dismissButton = UIButton(type: .system)
        dismissButton.setTitle(ProductCopy.dismissIssue, for: .normal)
        dismissButton.setTitleColor(AnjuTheme.ink, for: .normal)
        dismissButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
        dismissButton.addAction(UIAction { [weak self] _ in self?.setState(.dismissed) }, for: .touchUpInside)
        stack.addArrangedSubview(dismissButton)

        let close = UIButton(type: .system)
        close.setImage(UIImage(systemName: "xmark.circle.fill"), for: .normal)
        close.tintColor = AnjuTheme.ink
        close.accessibilityLabel = ProductCopy.close
        close.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(close)
        NSLayoutConstraint.activate([
            close.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            close.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            close.widthAnchor.constraint(equalToConstant: 44),
            close.heightAnchor.constraint(equalToConstant: 44)
        ])
        close.addAction(UIAction { [weak self] _ in self?.dismiss(animated: true) }, for: .touchUpInside)
    }

    private func makeSection(title: String, body: String) -> UIView {
        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 5
        stack.addArrangedSubview(makeLabel(title, style: .headline, color: AnjuTheme.ink))
        stack.addArrangedSubview(makeLabel(body, style: .body, color: AnjuTheme.ink.withAlphaComponent(0.82)))
        return stack
    }

    private func makeLabel(_ text: String, style: UIFont.TextStyle, color: UIColor) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = .preferredFont(forTextStyle: style)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = color
        label.numberOfLines = 0
        return label
    }

    private func setState(_ state: IssueState) {
        repository.setState(id: issueID, state: state)
        onChange()
        dismiss(animated: true)
    }
}
