import AnjuCore
import UIKit

enum ProductCopy {
    static let appName = "安心家 AI"
    static let homeTitle = "家庭安全检查"
    static let homeSubtitle = "网页负责完整检查流程，iPhone 在需要时提供拍照和实时扫描。"
    static let startRoom = "开启扫描"
    static let prepareTitle = "先选择扫描区域"
    static let bedroom = "卧室"
    static let livingRoom = "客厅"
    static let bathroom = "卫生间"
    static let corridor = "通道"
    static let beginScan = "开始扫描这个区域"
    static let scanning = "辅助筛查现场"
    static let scanMore = "再看看地面和人员通道"
    static let finishScan = "结束扫描并保存"
    static let finishScanHint = "停止采集并上传代表帧，随后可在照片页确认并开始 AI 检查"
    static let homeCameraScanning = "AI 适老顾问：请缓慢移动，尽量拍到地面和通道"
    static let spatialCameraMode = "空间定位模式：扫描期间可显示临时锚点"
    static let camera2DModeWarning = "当前设备暂不支持空间定位功能"
    static let temporarySuggestionEmpty = "实时建议仅供扫描时参考，不计入评分"
    static let pauseScan = "暂停扫描"
    static let resumeScan = "继续扫描"
    static let scanPaused = "扫描已暂停"
    static let cancelScan = "取消"
    static let representativeFrameLimitReached = "已收集足够的代表帧，可结束扫描"
    static let frameSaveFailed = "这一帧未能保存，请继续缓慢移动"
    static let uploadingRepresentativeFrames = "正在上传代表帧……"
    static let advisorTitle = "AI 适老顾问"
    static let advisorDefaultSubtitle = "可随时问我“这个地方可能有什么问题”"
    static let advisorInputPlaceholder = "输入扫描中的问题"
    static let advisorSend = "发送"
    static let advisorOpen = "展开顾问"
    static let advisorClose = "收起顾问"
    static let advisorConnecting = "正在连接语音顾问……"
    static let advisorListening = "正在听，你可以开始说话"
    static let advisorThinking = "正在理解你的问题"
    static let depthContextBusy = "正在处理前一处画面，请继续缓慢扫描"
    static let rtcVideoThermalDegraded = "设备温度较高，已降低实时画质"
    static let advisorSpeaking = "顾问正在回答，点击麦克风可打断"
    static let advisorReconnecting = "语音连接中断，正在恢复"
    static let advisorVoiceUnavailable = "语音暂不可用，可以继续文字咨询"
    static let advisorMicrophoneDenied = "没有麦克风权限，可以继续文字咨询"
    static let advisorMessageFailed = "这次没有回答成功，请稍后再试"
    static let advisorSuggestionHint = "选中后，可以用“这个地方”向顾问追问"
    static func advisorSelected(_ title: String) -> String { "已选中“\(title)”，可以继续追问" }
    static func advisorTemporarySuggestion(_ title: String, advice: String) -> String {
        "可能存在“\(title)”，\(advice)"
    }
    static let moveCloser = "再靠近一点看看墙边"
    static let moveAway = "稍微退后一点"
    static let slowDown = "慢一点，画面会更清楚"
    static let turnOnLight = "打开灯后再看看这里"
    static let scanCorner = "把墙角也放进画面里"
    static func savedRepresentativeFrames(_ count: Int, limit: Int) -> String {
        "已保存代表帧 \(count)/\(limit)"
    }
    static let finishingScan = "正在汇总扫描结果"
    static let reportTitle = "家庭安全检查结果"
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
    static let cameraFrameUnusable = "请稳住手机并调整光线，画面清晰后 AI 会继续检查"
    static let directAnalysisNoCandidate = "AI 已检查当前画面，请继续缓慢移动"
    static func directAnalysisCandidatesFound(_ count: Int) -> String { "AI 发现 \(count) 个待确认位置，正在定位" }
    static let partialReport = "部分内容稍后补充"
    static let rescan = "重新扫描"
    static let exitToHome = "退出"

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
        case .wetFloor: "地面有点滑"
        case .levelChange: "脚下有高差"
        case .crowdedPath: "人流挡路"
        case .markedExitObstruction: "出口通道受阻"
        case .lowHangingObstruction: "低位悬挂物"
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
