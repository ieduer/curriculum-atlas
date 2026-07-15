import AppKit
import Foundation
import Vision

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: vision-ocr-page.swift <image>\n".utf8))
    exit(64)
}

let imageURL = URL(fileURLWithPath: CommandLine.arguments[1])
guard
    let image = NSImage(contentsOf: imageURL),
    let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
else {
    FileHandle.standardError.write(Data("cannot read image: \(imageURL.path)\n".utf8))
    exit(66)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = true
request.minimumTextHeight = 0.008

do {
    try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
} catch {
    FileHandle.standardError.write(Data("Vision OCR failed: \(error)\n".utf8))
    exit(0)
}

let observations = (request.results ?? []).sorted { left, right in
    let rowDelta = left.boundingBox.midY - right.boundingBox.midY
    if abs(rowDelta) > 0.012 { return rowDelta > 0 }
    return left.boundingBox.minX < right.boundingBox.minX
}

for observation in observations {
    guard let candidate = observation.topCandidates(1).first else { continue }
    print("\(String(format: "%.4f", candidate.confidence))\t\(candidate.string)")
}
