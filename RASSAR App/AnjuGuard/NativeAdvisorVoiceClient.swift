import AVFoundation
import AnjuCore
import Foundation
import os

enum NativeAdvisorVoiceState: Equatable {
    case idle
    case connecting
    case listening
    case thinking
    case speaking
    case reconnecting
    case unavailable
}

enum NativeAdvisorVoiceError: Error {
    case sdkUnavailable
    case invalidConfiguration
    case joinFailed
}

#if canImport(VolcEngineRTC)
import VolcEngineRTC

final class NativeAdvisorVoiceClient: NSObject, ByteRTCEngineDelegate, ByteRTCRoomDelegate {
    static let isSDKAvailable = true

    var onStateChange: ((NativeAdvisorVoiceState) -> Void)?
    var onSubtitle: ((String) -> Void)?
    var onVideoProfileChange: ((NativeRTCVideoProfile, Set<NativeRTCVideoDegradeReason>) -> Void)?

    private var engine: ByteRTCEngine?
    private var room: ByteRTCRoom?
    private var botUserID = ""
    private var interruptionObserver: NSObjectProtocol?
    private var thermalObserver: NSObjectProtocol?
    private var idleWorkItem: DispatchWorkItem?
    private var microphoneEnabled = false
    private var videoEnabled = false
    private var videoAdaptiveState = NativeRTCVideoAdaptiveState()
    private var frameRateMonitor = NativeARFrameRateMonitor()
    private var videoProfile: NativeRTCVideoProfile = .normal
    private var lastVideoTimestamp: TimeInterval = -.infinity
    private var degradedBeganAt: TimeInterval?
    private var degradedDuration: TimeInterval = 0
    private var frameRateWindowCount = 0
    private var frameRateAverageTotal: Double = 0
    private var minimumARFrameRate = Double.greatestFiniteMagnitude
    private var maximumThermalLevel: NativeRTCThermalLevel = .nominal
    private let logger = Logger(subsystem: "com.anjuguard.app", category: "rtc-video")

    var isConnected: Bool { room != nil && engine != nil }
    var isMicrophoneEnabled: Bool { microphoneEnabled }

    func connect(
        _ configuration: AdvisorRTCConfiguration,
        video: Bool = false,
        microphone: Bool = true
    ) throws {
        guard configuration.isUsable,
              let appID = configuration.appID,
              let roomID = configuration.roomID,
              let userID = configuration.userID,
              let botUserID = configuration.botUserID,
              let token = configuration.token else {
            throw NativeAdvisorVoiceError.invalidConfiguration
        }
        disconnect()
        onStateChange?(.connecting)
        self.botUserID = botUserID

        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.allowBluetoothHFP, .defaultToSpeaker]
        )
        try audioSession.setActive(true)

        let engineConfig = ByteRTCEngineConfig()
        engineConfig.appID = appID
        engineConfig.parameters = [:]
        guard let engine = ByteRTCEngine.createRTCEngine(engineConfig, delegate: self),
              let room = engine.createRTCRoom(roomID) else {
            throw NativeAdvisorVoiceError.sdkUnavailable
        }
        self.engine = engine
        self.room = room
        room.delegate = self
        engine.setAudioScenario(.aiClient)
        if video {
            guard configuration.supportsVideo,
                  engine.setVideoSourceType(.external, WithStreamIndex: .indexMain) == 0 else {
                disconnect()
                throw NativeAdvisorVoiceError.invalidConfiguration
            }
            configureVideoEncoder(profile: .normal, engine: engine)
        }

        let userInfo = ByteRTCUserInfo()
        userInfo.userId = userID
        userInfo.extraInfo = "{\"call_scene\":\"ANJU_ADVISOR\"}"
        let roomConfig = ByteRTCRoomConfig()
        roomConfig.isPublishAudio = microphone
        roomConfig.isPublishVideo = video
        roomConfig.isAutoSubscribeAudio = true
        roomConfig.isAutoSubscribeVideo = false
        guard room.joinRoom(
            token,
            userInfo: userInfo,
            userVisibility: true,
            roomConfig: roomConfig
        ) == 0 else {
            disconnect()
            throw NativeAdvisorVoiceError.joinFailed
        }
        videoEnabled = video
        microphoneEnabled = microphone
        if microphone { engine.startAudioCapture() }
        observeAudioInterruptions()
        observeThermalState()
        if microphone {
            scheduleIdleTimeout()
            onStateChange?(.listening)
        } else {
            onStateChange?(.idle)
        }
    }

    func enableMicrophone() throws {
        guard let engine, let room, !microphoneEnabled else { return }
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setActive(true)
        engine.startAudioCapture()
        guard room.publishStreamAudio(true) == 0 else {
            engine.stopAudioCapture()
            throw NativeAdvisorVoiceError.joinFailed
        }
        microphoneEnabled = true
        scheduleIdleTimeout()
        onStateChange?(.listening)
    }

    func disableMicrophone() {
        idleWorkItem?.cancel()
        idleWorkItem = nil
        guard microphoneEnabled else { return }
        _ = room?.publishStreamAudio(false)
        engine?.stopAudioCapture()
        microphoneEnabled = false
        onStateChange?(.idle)
    }

    func pauseMedia() {
        disableMicrophone()
        if videoEnabled { _ = room?.publishStreamVideo(false) }
        onStateChange?(.reconnecting)
    }

    func resumeVideo() {
        guard videoEnabled, room?.publishStreamVideo(true) == 0 else { return }
        onStateChange?(.idle)
    }

    func pushVideoFrame(_ pixelBuffer: CVPixelBuffer, timestamp: TimeInterval) {
        guard videoEnabled else { return }
        if let window = frameRateMonitor.record(timestamp: timestamp) {
            frameRateWindowCount += 1
            frameRateAverageTotal += window.average
            minimumARFrameRate = min(minimumARFrameRate, window.minimum)
            apply(videoAdaptiveState.updateARFrameRate(average: window.average, timestamp: timestamp))
        }
        guard
              NativeRealtimeVideoPolicy.permitsVideoFrame(
                previousTimestamp: lastVideoTimestamp,
                timestamp: timestamp,
                profile: videoProfile
              ),
              CVPixelBufferGetPixelFormatType(pixelBuffer) == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
                || CVPixelBufferGetPixelFormatType(pixelBuffer) == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        else { return }
        lastVideoTimestamp = timestamp
        let frame = ByteRTCVideoFrameData()
        frame.bufferType = .cvPixelBuffer
        frame.pixelFormat = .NV12
        frame.contentType = .normalFrame
        frame.timestamp = CMTime(seconds: timestamp, preferredTimescale: 1_000_000_000)
        frame.width = Int32(CVPixelBufferGetWidth(pixelBuffer))
        frame.height = Int32(CVPixelBufferGetHeight(pixelBuffer))
        frame.cvpixelbuffer = pixelBuffer
        frame.rotation = .rotation90
        frame.cameraId = .back
        _ = engine?.pushExternalVideoFrame(frame)
    }

    func sendInspectionImage(_ jpeg: Data, prepared: PreparedCameraInspection) throws {
        guard isConnected else { throw NativeAdvisorVoiceError.joinFailed }
        let base64 = jpeg.base64EncodedString()
        let chunkSize = max(4_000, min(60_000, prepared.maxChunkBytes) - 2_000)
        let chunks = stride(from: 0, to: base64.count, by: chunkSize).map { offset -> String in
            let start = base64.index(base64.startIndex, offsetBy: offset)
            let end = base64.index(start, offsetBy: min(chunkSize, base64.distance(from: start, to: base64.endIndex)))
            return String(base64[start..<end])
        }
        for (index, chunk) in chunks.enumerated() {
            try sendControl([
                "Command": "ExternalTextToLLM",
                "InterruptMode": 3,
                "Message": index == chunks.count - 1 ? prepared.rtcMessage : "",
                "ImageConfig": [
                    "Action": "add",
                    "GroupID": prepared.groupID,
                    "ImageType": "base64",
                    "Images": [chunk],
                    "IsPartial": chunks.count > 1,
                    "FragmentID": index + 1,
                    "FragmentCount": chunks.count,
                    "ImageDetail": "low",
                ],
            ])
        }
    }

    func deleteInspectionImage(groupID: Int) {
        try? sendControl([
            "Command": "ExternalTextToLLM",
            "InterruptMode": 3,
            "Message": "清理本轮临时检查画面。",
            "ImageConfig": ["Action": "delete", "GroupID": groupID],
        ])
    }

    func interrupt() {
        try? sendControl(["Command": "interrupt", "InterruptMode": 1, "Message": ""])
        scheduleIdleTimeout()
        onStateChange?(.listening)
    }

    func disconnect() {
        idleWorkItem?.cancel()
        idleWorkItem = nil
        if let interruptionObserver {
            NotificationCenter.default.removeObserver(interruptionObserver)
            self.interruptionObserver = nil
        }
        if let thermalObserver {
            NotificationCenter.default.removeObserver(thermalObserver)
            self.thermalObserver = nil
        }
        recordSessionMetrics()
        engine?.stopAudioCapture()
        room?.leave()
        room?.destroy()
        room = nil
        engine = nil
        botUserID = ""
        microphoneEnabled = false
        videoEnabled = false
        videoAdaptiveState = .init()
        frameRateMonitor = .init()
        videoProfile = .normal
        lastVideoTimestamp = -.infinity
        degradedBeganAt = nil
        degradedDuration = 0
        frameRateWindowCount = 0
        frameRateAverageTotal = 0
        minimumARFrameRate = .greatestFiniteMagnitude
        maximumThermalLevel = .nominal
        ByteRTCEngine.destroyRTCEngine()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        onStateChange?(.idle)
    }

    func rtcRoom(
        _ rtcRoom: ByteRTCRoom,
        onUserBinaryMessageReceived uid: String,
        message: Data
    ) {
        handle(message)
    }

    func rtcRoom(
        _ rtcRoom: ByteRTCRoom,
        onRoomBinaryMessageReceived uid: String,
        message: Data
    ) {
        handle(message)
    }

    func rtcRoom(
        _ rtcRoom: ByteRTCRoom,
        onNetworkQuality localQuality: ByteRTCNetworkQualityStats,
        remoteQualities: [ByteRTCNetworkQualityStats]
    ) {
        let quality = Int(localQuality.txQuality.rawValue)
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.apply(self.videoAdaptiveState.updateNetwork(
                quality: quality,
                timestamp: ProcessInfo.processInfo.systemUptime
            ))
        }
    }

    private func configureVideoEncoder(profile: NativeRTCVideoProfile, engine: ByteRTCEngine) {
        let encoder = ByteRTCVideoEncoderConfig()
        let longEdge = profile.longEdge
        encoder.width = longEdge
        encoder.height = longEdge * 16 / 9
        encoder.frameRate = Int(profile.framesPerSecond)
        encoder.maxBitrate = profile.maximumBitrateKbps
        _ = engine.setVideoEncoderConfig(encoder)
    }

    private func apply(_ transition: NativeRTCVideoTransition?) {
        guard let transition, transition.profile != videoProfile, let engine else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if transition.profile == .degraded {
            degradedBeganAt = now
        } else if let began = degradedBeganAt {
            degradedDuration += max(0, now - began)
            degradedBeganAt = nil
        }
        videoProfile = transition.profile
        configureVideoEncoder(profile: transition.profile, engine: engine)
        logger.info(
            "RTC video profile=\(transition.profile.rawValue, privacy: .public) reasons=\(transition.reasons.map(\.rawValue).sorted().joined(separator: ","), privacy: .public)"
        )
        onVideoProfileChange?(transition.profile, transition.reasons)
    }

    private func observeThermalState() {
        updateThermalState(ProcessInfo.processInfo.thermalState)
        thermalObserver = NotificationCenter.default.addObserver(
            forName: ProcessInfo.thermalStateDidChangeNotification,
            object: ProcessInfo.processInfo,
            queue: .main
        ) { [weak self] _ in
            self?.updateThermalState(ProcessInfo.processInfo.thermalState)
        }
    }

    private func updateThermalState(_ state: ProcessInfo.ThermalState) {
        let level: NativeRTCThermalLevel
        switch state {
        case .nominal: level = .nominal
        case .fair: level = .fair
        case .serious: level = .serious
        case .critical: level = .critical
        @unknown default: level = .serious
        }
        maximumThermalLevel = max(maximumThermalLevel, level)
        apply(videoAdaptiveState.updateThermal(
            level: level,
            timestamp: ProcessInfo.processInfo.systemUptime
        ))
    }

    private func recordSessionMetrics() {
        guard videoEnabled || frameRateWindowCount > 0 else { return }
        var totalDegraded = degradedDuration
        if let began = degradedBeganAt {
            totalDegraded += max(0, ProcessInfo.processInfo.systemUptime - began)
        }
        let average = frameRateWindowCount > 0
            ? frameRateAverageTotal / Double(frameRateWindowCount)
            : 0
        let minimum = minimumARFrameRate.isFinite ? minimumARFrameRate : 0
        logger.info(
            "RTC video summary average_ar_fps=\(average, privacy: .public) minimum_ar_fps=\(minimum, privacy: .public) maximum_thermal=\(self.maximumThermalLevel.rawValue, privacy: .public) degraded_seconds=\(totalDegraded, privacy: .public)"
        )
    }

    private func handle(_ data: Data) {
        guard let decoded = decodeTLV(data),
              let object = try? JSONSerialization.jsonObject(with: decoded.body) as? [String: Any] else { return }
        if decoded.type == "conv" {
            let code = ((object["Stage"] as? [String: Any])?["Code"] as? NSNumber)?.intValue
            DispatchQueue.main.async { [weak self] in
                switch code {
                case 2: self?.onStateChange?(.thinking)
                case 3: self?.onStateChange?(.speaking)
                default: self?.onStateChange?(.listening)
                }
            }
            return
        }
        guard decoded.type == "subv",
              let first = (object["data"] as? [[String: Any]])?.first,
              let text = first["text"] as? String,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        DispatchQueue.main.async { [weak self] in
            self?.scheduleIdleTimeout()
            self?.onSubtitle?(text)
        }
    }

    private func observeAudioInterruptions() {
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            if type == .began {
                self?.onStateChange?(.reconnecting)
            } else {
                try? AVAudioSession.sharedInstance().setActive(true)
                if self?.microphoneEnabled == true {
                    self?.engine?.startAudioCapture()
                    self?.onStateChange?(.listening)
                }
            }
        }
    }

    private func encodeTLV(type: String, body: Data) -> Data {
        var data = Data(type.prefix(4).utf8)
        while data.count < 4 { data.append(0) }
        var length = UInt32(body.count).bigEndian
        data.append(Data(bytes: &length, count: MemoryLayout<UInt32>.size))
        data.append(body)
        return data
    }

    private func sendControl(_ value: [String: Any]) throws {
        guard let room, !botUserID.isEmpty else { throw NativeAdvisorVoiceError.joinFailed }
        let body = try JSONSerialization.data(withJSONObject: value)
        room.sendUserBinaryMessage(
            botUserID,
            message: encodeTLV(type: "ctrl", body: body),
            config: .reliableOrdered
        )
    }

    private func decodeTLV(_ data: Data) -> (type: String, body: Data)? {
        guard data.count >= 8 else { return nil }
        let type = String(data: data.prefix(4), encoding: .utf8)?.trimmingCharacters(in: .controlCharacters) ?? ""
        let lengthBytes = [UInt8](data[4..<8])
        let length = lengthBytes.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        guard Int(length) <= data.count - 8 else { return nil }
        return (type, data.subdata(in: 8..<(8 + Int(length))))
    }

    private func scheduleIdleTimeout() {
        idleWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in self?.disableMicrophone() }
        idleWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 90, execute: workItem)
    }
}

#else

final class NativeAdvisorVoiceClient {
    static let isSDKAvailable = false
    var onStateChange: ((NativeAdvisorVoiceState) -> Void)?
    var onSubtitle: ((String) -> Void)?
    var onVideoProfileChange: ((NativeRTCVideoProfile, Set<NativeRTCVideoDegradeReason>) -> Void)?
    var isConnected: Bool { false }
    var isMicrophoneEnabled: Bool { false }

    func connect(_ configuration: AdvisorRTCConfiguration, video: Bool = false, microphone: Bool = true) throws {
        onStateChange?(.unavailable)
        throw NativeAdvisorVoiceError.sdkUnavailable
    }

    func interrupt() {}
    func enableMicrophone() throws { throw NativeAdvisorVoiceError.sdkUnavailable }
    func disableMicrophone() { onStateChange?(.idle) }
    func pauseMedia() {}
    func resumeVideo() {}
    func pushVideoFrame(_ pixelBuffer: CVPixelBuffer, timestamp: TimeInterval) {}
    func sendInspectionImage(_ jpeg: Data, prepared: PreparedCameraInspection) throws { throw NativeAdvisorVoiceError.sdkUnavailable }
    func deleteInspectionImage(groupID: Int) {}
    func disconnect() { onStateChange?(.idle) }
}

#endif
