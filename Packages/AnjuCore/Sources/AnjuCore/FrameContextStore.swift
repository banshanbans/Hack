import Foundation

public struct StoredFrameContext: Sendable {
    public let context: CapturedFrameContext
    public let depth: DepthGrid?

    public init(context: CapturedFrameContext, depth: DepthGrid?) {
        self.context = context
        self.depth = depth
    }
}

/// A bounded AR frame/depth cache whose entries may be pinned to an RTC inspection.
/// Locked entries are never evicted, so delayed visual callbacks cannot resolve against
/// a newer depth frame by accident.
public actor FrameContextStore {
    private let capacity: Int
    private var order: [UUID] = []
    private var storage: [UUID: StoredFrameContext] = [:]
    private var inspectionFrames: [String: UUID] = [:]
    private var frameInspections: [UUID: Set<String>] = [:]

    public init(capacity: Int = 8) {
        self.capacity = max(1, capacity)
    }

    /// Returns false when every cached context is inspection-locked.
    @discardableResult
    public func insert(_ value: StoredFrameContext) -> Bool {
        let frameID = value.context.frameID
        if storage[frameID] != nil {
            order.removeAll { $0 == frameID }
            order.append(frameID)
            storage[frameID] = value
            return true
        }

        while storage.count >= capacity {
            guard let candidate = order.first(where: { frameInspections[$0, default: []].isEmpty }) else {
                return false
            }
            removeUnlocked(frameID: candidate)
        }
        order.append(frameID)
        storage[frameID] = value
        return true
    }

    /// Pins an existing frame to a provider-issued inspection ID.
    @discardableResult
    public func lock(frameID: UUID, inspectionID: String) -> Bool {
        guard !inspectionID.isEmpty, storage[frameID] != nil else { return false }
        if let existingFrame = inspectionFrames[inspectionID] {
            return existingFrame == frameID
        }
        inspectionFrames[inspectionID] = frameID
        frameInspections[frameID, default: []].insert(inspectionID)
        return true
    }

    public func value(for frameID: UUID) -> StoredFrameContext? {
        storage[frameID]
    }

    /// Resolves a context only when both provider IDs refer to the exact same cached frame.
    public func value(inspectionID: String, expectedFrameID: UUID) -> StoredFrameContext? {
        guard inspectionFrames[inspectionID] == expectedFrameID else { return nil }
        return storage[expectedFrameID]
    }

    public func frameID(for inspectionID: String) -> UUID? {
        inspectionFrames[inspectionID]
    }

    /// Unlocks an inspection and optionally discards its frame after the terminal event has
    /// been rendered. Other inspections may still keep the same frame pinned.
    @discardableResult
    public func unlock(inspectionID: String, removeContext: Bool = false) -> Bool {
        guard let frameID = inspectionFrames.removeValue(forKey: inspectionID) else { return false }
        frameInspections[frameID]?.remove(inspectionID)
        if frameInspections[frameID]?.isEmpty == true {
            frameInspections.removeValue(forKey: frameID)
            if removeContext {
                removeUnlocked(frameID: frameID)
            }
        }
        return true
    }

    /// Explicit removal is rejected while a frame is still pinned.
    @discardableResult
    public func remove(frameID: UUID) -> Bool {
        guard frameInspections[frameID, default: []].isEmpty else { return false }
        removeUnlocked(frameID: frameID)
        return true
    }

    public func removeAll() {
        order.removeAll()
        storage.removeAll()
        inspectionFrames.removeAll()
        frameInspections.removeAll()
    }

    public var count: Int { storage.count }
    public var lockedCount: Int { inspectionFrames.count }

    private func removeUnlocked(frameID: UUID) {
        order.removeAll { $0 == frameID }
        storage.removeValue(forKey: frameID)
        frameInspections.removeValue(forKey: frameID)
    }
}
