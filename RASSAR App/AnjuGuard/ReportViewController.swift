import AnjuCore
import UIKit

@MainActor
final class ReportViewController: UIViewController, UITableViewDataSource, UITableViewDelegate {
    private let context: AnjuAppContext
    private let tableView = UITableView(frame: .zero, style: .insetGrouped)
    private let emptyView = UIStackView()
    private var sections: [(severity: Severity, issues: [SafetyIssue])] = []

    init(context: AnjuAppContext) {
        self.context = context
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemGroupedBackground
        configureHeader()
        configureTable()
        configureEmptyView()
        reload()
    }

    private func configureHeader() {
        let title = UILabel()
        title.text = ProductCopy.reportTitle
        title.font = .preferredFont(forTextStyle: .largeTitle)
        title.adjustsFontForContentSizeCategory = true
        title.textColor = AnjuTheme.ink
        title.numberOfLines = 0
        title.accessibilityTraits = .header
        title.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(title)

        let share = UIButton(type: .system)
        share.setImage(UIImage(systemName: "square.and.arrow.up"), for: .normal)
        share.tintColor = AnjuTheme.teal
        share.accessibilityLabel = ProductCopy.share
        share.translatesAutoresizingMaskIntoConstraints = false
        share.addAction(UIAction { [weak self] _ in self?.shareReport() }, for: .touchUpInside)
        view.addSubview(share)

        let close = UIButton(type: .system)
        close.setImage(UIImage(systemName: "xmark.circle.fill"), for: .normal)
        close.tintColor = AnjuTheme.ink
        close.accessibilityLabel = ProductCopy.close
        close.translatesAutoresizingMaskIntoConstraints = false
        close.addAction(UIAction { [weak self] _ in self?.dismiss(animated: true) }, for: .touchUpInside)
        view.addSubview(close)

        NSLayoutConstraint.activate([
            title.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
            title.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 18),
            title.trailingAnchor.constraint(lessThanOrEqualTo: share.leadingAnchor, constant: -12),
            share.trailingAnchor.constraint(equalTo: close.leadingAnchor, constant: -4),
            share.centerYAnchor.constraint(equalTo: close.centerYAnchor),
            share.widthAnchor.constraint(equalToConstant: 44),
            share.heightAnchor.constraint(equalToConstant: 44),
            close.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -12),
            close.centerYAnchor.constraint(equalTo: title.centerYAnchor),
            close.widthAnchor.constraint(equalToConstant: 44),
            close.heightAnchor.constraint(equalToConstant: 44)
        ])
        tableView.accessibilityIdentifier = "room_report"
        tableView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(tableView)
        NSLayoutConstraint.activate([
            tableView.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 12),
            tableView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            tableView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
    }

    private func configureTable() {
        tableView.dataSource = self
        tableView.delegate = self
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "issue")
        tableView.rowHeight = UITableView.automaticDimension
        tableView.estimatedRowHeight = 88
    }

    private func configureEmptyView() {
        emptyView.axis = .vertical
        emptyView.spacing = 12
        emptyView.alignment = .center
        emptyView.translatesAutoresizingMaskIntoConstraints = false
        let image = UIImageView(image: UIImage(systemName: "checkmark.shield"))
        image.tintColor = AnjuTheme.teal
        image.preferredSymbolConfiguration = .init(pointSize: 52)
        emptyView.addArrangedSubview(image)
        let title = UILabel()
        title.text = ProductCopy.emptyReport
        title.font = .preferredFont(forTextStyle: .title2)
        title.adjustsFontForContentSizeCategory = true
        title.numberOfLines = 0
        title.textAlignment = .center
        emptyView.addArrangedSubview(title)
        let detail = UILabel()
        detail.text = ProductCopy.emptyReportDetail
        detail.font = .preferredFont(forTextStyle: .body)
        detail.adjustsFontForContentSizeCategory = true
        detail.textColor = .secondaryLabel
        detail.numberOfLines = 0
        detail.textAlignment = .center
        emptyView.addArrangedSubview(detail)
        view.addSubview(emptyView)
        NSLayoutConstraint.activate([
            emptyView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 32),
            emptyView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -32),
            emptyView.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
    }

    private func reload() {
        let issues = context.repository.issues
        sections = Severity.allCases.compactMap { severity in
            let matching = issues.filter { $0.severity == severity }
            return matching.isEmpty ? nil : (severity, matching)
        }
        tableView.isHidden = sections.isEmpty
        emptyView.isHidden = !sections.isEmpty
        tableView.reloadData()
    }

    func numberOfSections(in tableView: UITableView) -> Int { sections.count }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        sections[section].issues.count
    }

    func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        ProductCopy.severityLabel(sections[section].severity)
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let issue = sections[indexPath.section].issues[indexPath.row]
        let cell = tableView.dequeueReusableCell(withIdentifier: "issue", for: indexPath)
        var content = cell.defaultContentConfiguration()
        content.text = issue.title
        content.secondaryText = issue.state == .resolved ? ProductCopy.resolved : issue.recommendation
        content.textProperties.font = .preferredFont(forTextStyle: .headline)
        content.secondaryTextProperties.font = .preferredFont(forTextStyle: .body)
        content.textProperties.color = AnjuTheme.ink
        content.image = UIImage(systemName: issue.state == .resolved ? "checkmark.circle.fill" : "mappin.circle.fill")
        content.imageProperties.tintColor = issue.state == .resolved ? AnjuTheme.teal : AnjuTheme.severityColor(issue.severity)
        cell.contentConfiguration = content
        cell.accessoryType = .disclosureIndicator
        cell.accessibilityLabel = "\(ProductCopy.severityLabel(issue.severity))，\(issue.title)，\(content.secondaryText ?? "")"
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let issue = sections[indexPath.section].issues[indexPath.row]
        let detail = IssueDetailViewController(issueID: issue.id, repository: context.repository) { [weak self] in
            self?.reload()
        }
        if let sheet = detail.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
        }
        present(detail, animated: true)
    }

    private func shareReport() {
        let lines = context.repository.issues.map {
            "\(ProductCopy.severityLabel($0.severity))｜\($0.title)：\($0.recommendation)"
        }
        let text = ([ProductCopy.reportTitle] + (lines.isEmpty ? [ProductCopy.emptyReport] : lines)).joined(separator: "\n")
        let renderer = UIGraphicsImageRenderer(bounds: view.bounds)
        let image = renderer.image { _ in view.drawHierarchy(in: view.bounds, afterScreenUpdates: true) }
        let activity = UIActivityViewController(activityItems: [text, image], applicationActivities: nil)
        if let popover = activity.popoverPresentationController {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.maxX - 44, y: view.safeAreaInsets.top, width: 1, height: 1)
        }
        present(activity, animated: true)
    }
}
