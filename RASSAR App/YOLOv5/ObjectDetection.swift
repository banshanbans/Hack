//
//  ObjectDetection.swift
//  RetroAccess App
//
//  Created by Xia Su on 1/28/23.
//

import AVFoundation
import Vision
import CoreImage
import OSLog

class ObjectDetection{
    private let logger = Logger(subsystem: "com.anjuguard.app", category: "vision")
    private let stateLock = NSLock()
    private var resourcesReleased = false
    private var detectionRequest: VNCoreMLRequest?
    private(set) var ready = false
    var names=[" ","Door Handle", "Electric Socket", "Grab Bar","Knife", "Medication","Rug", "Scissors", "Smoke Alarm","Switch"]
    init(){
        Task { self.initDetection() }
    }
    
    func initDetection(){
        do {
            let model = try VNCoreMLModel(for: yolov5_Medium(configuration: MLModelConfiguration()).model)
            let request = VNCoreMLRequest(model: model)
            stateLock.lock()
            defer { stateLock.unlock() }
            guard !resourcesReleased else { return }
            detectionRequest = request
            ready = true
            
        } catch let error {
            stateLock.lock()
            ready = false
            stateLock.unlock()
            logger.error("Local vision model unavailable; spatial scan will continue: \(error.localizedDescription, privacy: .public)")
        }
    }
    
    func detectAndProcess(image:CIImage)-> [ProcessedObservation]{
        
        let observations = self.detect(image: image)
        
        let processedObservations = self.processObservation(observations: observations, viewSize: image.extent.size)
        //print("Detect results contains\(processedObservations.count)")
        return processedObservations
    }

    func releaseResources() {
        stateLock.lock()
        resourcesReleased = true
        detectionRequest = nil
        ready = false
        stateLock.unlock()
    }
    
    
    func detect(image:CIImage) -> [VNObservation]{
        stateLock.lock()
        let request = detectionRequest
        stateLock.unlock()
        guard let request else { return [] }
        let handler = VNImageRequestHandler(ciImage: image)
        
        do{
            try handler.perform([request])
            return request.results ?? []
            
        } catch {
            //fatalError("failed to detect: \(error)")
            return []
        }
        
    }
    
    
    func processObservation(observations:[VNObservation], viewSize:CGSize) -> [ProcessedObservation]{
       
        var processedObservations:[ProcessedObservation] = []
        
        for observation in observations where observation is VNRecognizedObjectObservation {
            
            let objectObservation = observation as! VNRecognizedObjectObservation
            
            let conf=objectObservation.confidence
            
            if Float(conf)<Settings.instance.yoloConfidenceThreshold{
                continue
            }
            
            let objectBounds = VNImageRectForNormalizedRect(objectObservation.boundingBox, Int(viewSize.width), Int(viewSize.height))
            
            let flippedBox = CGRect(x: objectBounds.minX, y: viewSize.height - objectBounds.maxY, width: objectBounds.maxX - objectBounds.minX, height: objectBounds.maxY - objectBounds.minY)
            
            guard let label = objectObservation.labels.first?.identifier else { continue }
            
            let processedOD = ProcessedObservation(label: label, confidence: objectObservation.confidence, boundingBox: flippedBox)
            
            processedObservations.append(processedOD)
        }
        
        return processedObservations
        
    }
    
}

struct ProcessedObservation{
    var label: String
    var confidence: Float
    var boundingBox: CGRect
}

@objc class Prediction : NSObject {
    @objc let classIndex: Int
    @objc let score: Float
    @objc var rect: CGRect
    
    public init(classIndex: Int,
     score: Float,
     rect: CGRect) {
        self.classIndex = classIndex
        self.score = score
        self.rect = rect
    }
}
