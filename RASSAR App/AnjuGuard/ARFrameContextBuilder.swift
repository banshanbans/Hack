import ARKit
import AnjuCore
import CoreVideo
import UIKit

enum ARFrameContextBuilder {
    static func makeStoredContext(
        frame: ARFrame,
        frameID: UUID,
        orientation: UIInterfaceOrientation = .portrait
    ) -> StoredFrameContext? {
        let transform = frame.camera.transform
        let transformValues: [Float] = [
            transform.columns.0.x, transform.columns.0.y, transform.columns.0.z, transform.columns.0.w,
            transform.columns.1.x, transform.columns.1.y, transform.columns.1.z, transform.columns.1.w,
            transform.columns.2.x, transform.columns.2.y, transform.columns.2.z, transform.columns.2.w,
            transform.columns.3.x, transform.columns.3.y, transform.columns.3.z, transform.columns.3.w
        ]
        guard let matrix = Matrix4x4Codable(values: transformValues) else { return nil }
        let intrinsics = frame.camera.intrinsics
        let imageWidth = CVPixelBufferGetWidth(frame.capturedImage)
        let imageHeight = CVPixelBufferGetHeight(frame.capturedImage)
        let context = CapturedFrameContext(
            frameID: frameID,
            timestamp: frame.timestamp,
            cameraTransform: matrix,
            intrinsics: .init(
                fx: intrinsics.columns.0.x,
                fy: intrinsics.columns.1.y,
                cx: intrinsics.columns.2.x,
                cy: intrinsics.columns.2.y
            ),
            imageWidth: imageWidth,
            imageHeight: imageHeight,
            orientationRawValue: orientation.rawValue
        )
        let depthBuffer = frame.smoothedSceneDepth?.depthMap ?? frame.sceneDepth?.depthMap
        return StoredFrameContext(context: context, depth: depthBuffer.flatMap(makeDepthGrid))
    }

    private static func makeDepthGrid(_ buffer: CVPixelBuffer) -> DepthGrid? {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_DepthFloat32,
              let address = CVPixelBufferGetBaseAddress(buffer) else { return nil }
        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        let stride = CVPixelBufferGetBytesPerRow(buffer) / MemoryLayout<Float32>.stride
        let pointer = address.assumingMemoryBound(to: Float32.self)
        var values = [Float](repeating: 0, count: width * height)
        for y in 0..<height {
            for x in 0..<width {
                values[y * width + x] = pointer[y * stride + x]
            }
        }
        return DepthGrid(width: width, height: height, values: values)
    }
}
