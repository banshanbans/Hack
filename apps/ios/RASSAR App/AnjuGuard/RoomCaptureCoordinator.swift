import ARKit
import RoomPlan

protocol RoomCaptureCoordinatorDelegate: AnyObject {
    func roomCaptureCoordinator(_ coordinator: RoomCaptureCoordinator, didUpdate room: CapturedRoom)
    func roomCaptureCoordinatorDidStart(_ coordinator: RoomCaptureCoordinator)
    func roomCaptureCoordinator(_ coordinator: RoomCaptureCoordinator, didFinish data: CapturedRoomData, error: Error?)
    func roomCaptureCoordinator(_ coordinator: RoomCaptureCoordinator, didProvide instruction: RoomCaptureSession.Instruction)
}

final class RoomCaptureCoordinator: NSObject {
    weak var delegate: RoomCaptureCoordinatorDelegate?
    private(set) var session = RoomCaptureSession()
    private(set) var isRunning = false
    private var hasStarted = false
    private var isFinishing = false

    override init() {
        super.init()
        session.delegate = self
    }

    var currentFrame: ARFrame? { session.arSession.currentFrame }

    func start() {
        guard !isRunning, !isFinishing else { return }
        hasStarted = true
        isRunning = true
        session.run(configuration: .init())
    }

    @discardableResult
    func stop() -> Bool {
        guard hasStarted, !isFinishing else { return false }
        isFinishing = true
        isRunning = false
        session.stop()
        return true
    }

    func pause() {
        guard isRunning, !isFinishing else { return }
        isRunning = false
        session.arSession.pause()
    }

    /// A completed scan never resumes. Detach RoomPlan and ARKit delegates and
    /// replace the capture session so the captured-room graph can be released
    /// while the server deterministically finalizes the direct Pro findings.
    func releaseResourcesAfterScan() {
        session.arSession.pause()
        session.arSession.delegate = nil
        session.delegate = nil
        session = RoomCaptureSession()
        isRunning = false
        hasStarted = false
        isFinishing = false
    }
}

extension RoomCaptureCoordinator: RoomCaptureSessionDelegate {
    func captureSession(_ session: RoomCaptureSession, didAdd room: CapturedRoom) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.delegate?.roomCaptureCoordinator(self, didUpdate: room)
        }
    }

    func captureSession(_ session: RoomCaptureSession, didChange room: CapturedRoom) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.delegate?.roomCaptureCoordinator(self, didUpdate: room)
        }
    }

    func captureSession(_ session: RoomCaptureSession, didUpdate room: CapturedRoom) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.delegate?.roomCaptureCoordinator(self, didUpdate: room)
        }
    }

    func captureSession(_ session: RoomCaptureSession, didRemove room: CapturedRoom) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.delegate?.roomCaptureCoordinator(self, didUpdate: room)
        }
    }

    func captureSession(_ session: RoomCaptureSession, didStartWith configuration: RoomCaptureSession.Configuration) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.delegate?.roomCaptureCoordinatorDidStart(self)
        }
    }

    func captureSession(_ session: RoomCaptureSession, didEndWith data: CapturedRoomData, error: Error?) {
        isRunning = false
        hasStarted = false
        isFinishing = false
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.delegate?.roomCaptureCoordinator(self, didFinish: data, error: error)
        }
    }

    func captureSession(_ session: RoomCaptureSession, didProvide instruction: RoomCaptureSession.Instruction) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.delegate?.roomCaptureCoordinator(self, didProvide: instruction)
        }
    }
}
