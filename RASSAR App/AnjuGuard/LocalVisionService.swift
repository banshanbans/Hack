import AnjuCore
import CoreGraphics
import CoreVideo
import Foundation
import ImageIO

struct LocalPrediction: Sendable {
    let type: SafetyIssueType
    let boundingBox: NormalizedBoundingBox
    let confidence: Float
}

protocol LocalVisionServing: Sendable {
    func predictions(pixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation) async -> [LocalPrediction]
    func cancel() async
}

final class EmptyLocalVisionService: LocalVisionServing, @unchecked Sendable {
    func predictions(pixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation) async -> [LocalPrediction] { [] }
    func cancel() async {}
}
