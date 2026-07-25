import AnjuCore
import CoreVideo
import Foundation

final class FrameQualityService: @unchecked Sendable {
    private let lock = NSLock()
    private var consecutiveLowLightFrames = 0

    /// Samples the full-range Y plane. Three consecutive dark keyframes are required.
    func lowLightCandidate(pixelBuffer: CVPixelBuffer, frameID: UUID) -> IssueCandidate? {
        guard CVPixelBufferGetPlaneCount(pixelBuffer) > 0 else { return nil }
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) else { return nil }
        let width = CVPixelBufferGetWidthOfPlane(pixelBuffer, 0)
        let height = CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
        let rowStride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
        let bytes = base.assumingMemoryBound(to: UInt8.self)
        var total = 0
        var count = 0
        for y in stride(from: 0, to: height, by: 24) {
            for x in stride(from: 0, to: width, by: 24) {
                total += Int(bytes[y * rowStride + x])
                count += 1
            }
        }
        guard count > 0 else { return nil }
        let average = Double(total) / Double(count) / 255
        lock.lock()
        consecutiveLowLightFrames = average < 0.18 ? consecutiveLowLightFrames + 1 : 0
        let stable = consecutiveLowLightFrames >= 3
        lock.unlock()
        guard stable,
              let box = NormalizedBoundingBox(xMin: 0, yMin: 0, xMax: 1, yMax: 1) else { return nil }
        return IssueCandidate(
            type: .lowLighting,
            needsManualCheck: true,
            source: .localVision,
            evidence: .init(frameID: frameID, boundingBox: box)
        )
    }
}
