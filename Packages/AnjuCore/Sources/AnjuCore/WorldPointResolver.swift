import Foundation

public struct CameraIntrinsics: Codable, Equatable, Sendable {
    public let fx: Float
    public let fy: Float
    public let cx: Float
    public let cy: Float

    public init(fx: Float, fy: Float, cx: Float, cy: Float) {
        self.fx = fx
        self.fy = fy
        self.cx = cx
        self.cy = cy
    }
}

public struct CapturedFrameContext: Codable, Equatable, Sendable {
    public let frameID: UUID
    public let timestamp: TimeInterval
    public let cameraTransform: Matrix4x4Codable
    public let intrinsics: CameraIntrinsics
    public let imageWidth: Int
    public let imageHeight: Int
    public let orientationRawValue: Int

    public init(
        frameID: UUID,
        timestamp: TimeInterval,
        cameraTransform: Matrix4x4Codable,
        intrinsics: CameraIntrinsics,
        imageWidth: Int,
        imageHeight: Int,
        orientationRawValue: Int
    ) {
        self.frameID = frameID
        self.timestamp = timestamp
        self.cameraTransform = cameraTransform
        self.intrinsics = intrinsics
        self.imageWidth = imageWidth
        self.imageHeight = imageHeight
        self.orientationRawValue = orientationRawValue
    }
}

public struct DepthGrid: Equatable, Sendable {
    public let width: Int
    public let height: Int
    public let values: [Float]

    public init?(width: Int, height: Int, values: [Float]) {
        guard width > 0, height > 0, values.count == width * height else { return nil }
        self.width = width
        self.height = height
        self.values = values
    }

    public subscript(x: Int, y: Int) -> Float? {
        guard x >= 0, y >= 0, x < width, y < height else { return nil }
        return values[y * width + x]
    }
}

public struct WorldPointResolverConfiguration: Equatable, Sendable {
    public var sampleRadius: Int
    public var minimumDepth: Float
    public var maximumDepth: Float
    public var maximumRelativeDeviation: Float

    public init(
        sampleRadius: Int = 2,
        minimumDepth: Float = 0.15,
        maximumDepth: Float = 8,
        maximumRelativeDeviation: Float = 0.35
    ) {
        self.sampleRadius = sampleRadius
        self.minimumDepth = minimumDepth
        self.maximumDepth = maximumDepth
        self.maximumRelativeDeviation = maximumRelativeDeviation
    }
}

public struct WorldPointResolver: Sendable {
    private let configuration: WorldPointResolverConfiguration

    public init(configuration: WorldPointResolverConfiguration = .init()) {
        self.configuration = configuration
    }

    /// Coordinates: bbox origin is top-left of the captured image; depth is meters.
    /// ARKit camera axes are x-right, y-up, z-backward. The transform is column-major.
    public func resolve(
        boundingBox: NormalizedBoundingBox,
        frame: CapturedFrameContext,
        depth: DepthGrid
    ) -> WorldPoint? {
        let imageU = Float((boundingBox.xMin + boundingBox.xMax) * 0.5) * Float(frame.imageWidth)
        let imageV = Float((boundingBox.yMin + boundingBox.yMax) * 0.5) * Float(frame.imageHeight)
        let depthX = Int((imageU / Float(frame.imageWidth) * Float(depth.width)).rounded())
        let depthY = Int((imageV / Float(frame.imageHeight) * Float(depth.height)).rounded())

        var samples: [Float] = []
        for y in (depthY - configuration.sampleRadius)...(depthY + configuration.sampleRadius) {
            for x in (depthX - configuration.sampleRadius)...(depthX + configuration.sampleRadius) {
                guard let value = depth[x, y], value.isFinite,
                      value >= configuration.minimumDepth,
                      value <= configuration.maximumDepth else { continue }
                samples.append(value)
            }
        }
        guard let depthMeters = robustMedian(samples) else { return nil }

        let cameraX = (imageU - frame.intrinsics.cx) * depthMeters / frame.intrinsics.fx
        let cameraY = -(imageV - frame.intrinsics.cy) * depthMeters / frame.intrinsics.fy
        let cameraZ = -depthMeters
        let m = frame.cameraTransform.values
        let worldX = m[0] * cameraX + m[4] * cameraY + m[8] * cameraZ + m[12]
        let worldY = m[1] * cameraX + m[5] * cameraY + m[9] * cameraZ + m[13]
        let worldZ = m[2] * cameraX + m[6] * cameraY + m[10] * cameraZ + m[14]
        guard worldX.isFinite, worldY.isFinite, worldZ.isFinite else { return nil }
        return WorldPoint(x: worldX, y: worldY, z: worldZ)
    }

    public func robustMedian(_ values: [Float]) -> Float? {
        let sorted = values.filter(\.isFinite).sorted()
        guard !sorted.isEmpty else { return nil }
        let median = sorted[sorted.count / 2]
        let tolerance = max(0.05, median * configuration.maximumRelativeDeviation)
        let filtered = sorted.filter { abs($0 - median) <= tolerance }
        guard !filtered.isEmpty else { return nil }
        return filtered[filtered.count / 2]
    }
}
