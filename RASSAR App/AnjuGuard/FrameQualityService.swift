import AnjuCore
import CoreVideo
import Foundation

struct FrameQualityResult: Equatable, Sendable {
    let brightness: Double
    let sharpness: Double

    var isUsable: Bool {
        NativeFrameSelectionPolicy.homeCamera.acceptsQuality(
            brightness: brightness,
            sharpness: sharpness
        )
    }
}

final class FrameQualityService: @unchecked Sendable {
    /// Deterministic quality gate only. It never creates or classifies a risk.
    func evaluate(pixelBuffer: CVPixelBuffer) -> FrameQualityResult? {
        guard CVPixelBufferGetPlaneCount(pixelBuffer) > 0 else { return nil }
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) else { return nil }
        let width = CVPixelBufferGetWidthOfPlane(pixelBuffer, 0)
        let height = CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
        let rowStride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
        let bytes = base.assumingMemoryBound(to: UInt8.self)
        guard width >= 5, height >= 5 else { return nil }
        var luminanceTotal = 0
        var edgeTotal = 0
        var sampleCount = 0
        for y in stride(from: 2, to: height - 2, by: 12) {
            for x in stride(from: 2, to: width - 2, by: 12) {
                let center = Int(bytes[y * rowStride + x])
                luminanceTotal += center
                let laplacian = abs(
                    center * 4
                    - Int(bytes[y * rowStride + x - 2])
                    - Int(bytes[y * rowStride + x + 2])
                    - Int(bytes[(y - 2) * rowStride + x])
                    - Int(bytes[(y + 2) * rowStride + x])
                )
                edgeTotal += laplacian
                sampleCount += 1
            }
        }
        guard sampleCount > 0 else { return nil }
        return FrameQualityResult(
            brightness: Double(luminanceTotal) / Double(sampleCount),
            sharpness: Double(edgeTotal) / Double(sampleCount)
        )
    }
}
