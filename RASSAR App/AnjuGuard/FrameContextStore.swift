import AnjuCore
import Foundation

struct StoredFrameContext: Sendable {
    let context: CapturedFrameContext
    let depth: DepthGrid?
}

actor FrameContextStore {
    private let capacity: Int
    private var order: [UUID] = []
    private var storage: [UUID: StoredFrameContext] = [:]

    init(capacity: Int = 4) {
        self.capacity = max(1, capacity)
    }

    func insert(_ value: StoredFrameContext) {
        order.removeAll { $0 == value.context.frameID }
        order.append(value.context.frameID)
        storage[value.context.frameID] = value
        while order.count > capacity {
            storage.removeValue(forKey: order.removeFirst())
        }
    }

    func value(for frameID: UUID) -> StoredFrameContext? {
        storage[frameID]
    }

    func remove(frameID: UUID) {
        order.removeAll { $0 == frameID }
        storage.removeValue(forKey: frameID)
    }

    func removeAll() {
        order.removeAll()
        storage.removeAll()
    }
}
