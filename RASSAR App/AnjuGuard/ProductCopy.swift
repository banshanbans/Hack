import AnjuCore
import UIKit

enum ProductCopy {
    static let appName = "长者友好家"
    static let homeTitle = "游园会现场安全辅助筛查"
    static let homeSubtitle = "用 iPhone 分区扫描和空间定位，找出值得现场确认的通行风险"
    static let startRoom = "开始游园会扫描"
    static let focusTitle = "这次想重点看看什么"
    static let focusSubtitle = "可以多选，我们会优先展示相关问题"
    static let continueAction = "继续"
    static let prepareTitle = "先选择游园会扫描区域"
    static let prepareSubtitle = "按入口、主通道、展位和休息区分段扫描，不依赖无限扩张的单一地图"
    static let roomTypeTitle = "当前游园会区域"
    static let bedroom = "卧室"
    static let livingRoom = "客厅"
    static let bathroom = "卫生间"
    static let corridor = "通道"
    static let beginScan = "开始扫描这个区域"
    static let scanning = "正在辅助筛查游园会现场"
    static let scanMore = "再看看地面和人员通道"
    static let finishScan = "结束扫描并复核"
    static let finishingScan = "Pro 正在复核代表画面"
    static let rugNeedsCheckObservation = "看到一块地毯，边缘和通道位置需要再确认。"
    static let reportTitle = "游园会现场辅助筛查结果"
    static let emptyReport = "暂时没有发现明显问题"
    static let emptyReportDetail = "你仍可以按日常使用习惯，再看看地面和通道。"
    static let highPriority = "建议先处理"
    static let mediumPriority = "有空可以改善"
    static let checkPriority = "建议再确认"
    static let viewAdvice = "看看怎么改"
    static let confirmIssue = "这是问题"
    static let dismissIssue = "这里没问题"
    static let markResolved = "标记已处理"
    static let resolved = "已处理"
    static let close = "关闭"
    static let share = "分享报告"
    static let cameraPermissionTitle = "需要打开相机"
    static let cameraPermissionMessage = "打开相机，才能一起看看这个房间。你可以前往设置允许访问。"
    static let openSettings = "前往设置"
    static let cancel = "暂不"
    static let unsupportedTitle = "这台设备暂不支持空间扫描"
    static let unsupportedMessage = "请使用支持空间扫描的 iPhone。现在仍可以查看离线演示报告。"
    static let demoReport = "查看演示报告"
    static let remoteUnavailable = "这次没有看清，稍后再试也可以"
    static let partialReport = "部分内容稍后补充"
    static let fairDisclaimer = "仅为游园会现场辅助筛查参考，不代表场馆验收或施工报价。"

    static func severityLabel(_ severity: Severity) -> String {
        switch severity {
        case .high: highPriority
        case .medium: mediumPriority
        case .check: checkPriority
        }
    }

    static func shortLabel(for type: SafetyIssueType) -> String {
        switch type {
        case .looseRug: "容易绊脚"
        case .floorClutter: "通道有杂物"
        case .cableCrossing: "电线挡路"
        case .narrowPath: "通道有点窄"
        case .missingGrabBar: "建议加扶手"
        case .sharpCorner: "小心尖角"
        case .lowLighting: "光线有点暗"
        case .unstableSupport: "需要再确认"
        case .highReachItem: "物品放得高"
        case .bedsideObstruction: "床边被挡住"
        }
    }
}

enum AnjuTheme {
    static let ink = UIColor(red: 0.10, green: 0.18, blue: 0.20, alpha: 1)
    static let teal = UIColor(red: 0.08, green: 0.45, blue: 0.42, alpha: 1)
    static let sand = UIColor(red: 0.96, green: 0.94, blue: 0.88, alpha: 1)
    static let high = UIColor(red: 0.78, green: 0.24, blue: 0.20, alpha: 1)
    static let medium = UIColor(red: 0.78, green: 0.49, blue: 0.08, alpha: 1)
    static let check = UIColor(red: 0.34, green: 0.39, blue: 0.43, alpha: 1)

    static func severityColor(_ severity: Severity) -> UIColor {
        switch severity {
        case .high: high
        case .medium: medium
        case .check: check
        }
    }

    static func primaryButton(title: String) -> UIButton {
        let button = UIButton(type: .system)
        var configuration = UIButton.Configuration.filled()
        configuration.title = title
        configuration.baseBackgroundColor = teal
        configuration.baseForegroundColor = .white
        configuration.cornerStyle = .large
        configuration.contentInsets = .init(top: 16, leading: 24, bottom: 16, trailing: 24)
        button.configuration = configuration
        button.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        button.titleLabel?.adjustsFontForContentSizeCategory = true
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 56).isActive = true
        return button
    }
}
