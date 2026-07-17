import AppKit
import Foundation
import Vision

struct OCRLine: Codable {
    let confidence: Float
    let text: String
}

struct OCRPage: Codable {
    let file: String
    let lines: [OCRLine]
    let error: String?
    let errorDomain: String?
    let errorCode: Int?
    let errorDescription: String?
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
var arguments = Array(CommandLine.arguments.dropFirst())
var outputDirectory: URL?
var recognitionLanguages = ["zh-Hans", "en-US"]

while arguments.count >= 2 {
    if arguments[0] == "--output-dir" {
        outputDirectory = URL(fileURLWithPath: arguments[1], isDirectory: true)
        arguments.removeFirst(2)
        try? FileManager.default.createDirectory(
            at: outputDirectory!,
            withIntermediateDirectories: true
        )
        continue
    }
    if arguments[0] == "--languages" {
        recognitionLanguages = arguments[1]
            .split(separator: ",")
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        arguments.removeFirst(2)
        continue
    }
    break
}

guard !recognitionLanguages.isEmpty else {
    FileHandle.standardError.write(Data("at least one recognition language is required\n".utf8))
    exit(64)
}

do {
    let supportedLanguages = try VNRecognizeTextRequest().supportedRecognitionLanguages()
    let unsupportedLanguages = recognitionLanguages.filter { !supportedLanguages.contains($0) }
    guard unsupportedLanguages.isEmpty else {
        FileHandle.standardError.write(
            Data("unsupported recognition languages: \(unsupportedLanguages.joined(separator: ","))\n".utf8)
        )
        exit(64)
    }
} catch {
    FileHandle.standardError.write(Data("cannot query supported recognition languages: \(error)\n".utf8))
    exit(70)
}

for argument in arguments {
    let imageURL = URL(fileURLWithPath: argument)
    var result: OCRPage
    if
        let image = NSImage(contentsOf: imageURL),
        let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
    {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = recognitionLanguages
        request.usesLanguageCorrection = true
        request.minimumTextHeight = 0.008
        do {
            try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
            let observations = (request.results ?? []).sorted { left, right in
                let rowDelta = left.boundingBox.midY - right.boundingBox.midY
                if abs(rowDelta) > 0.012 { return rowDelta > 0 }
                return left.boundingBox.minX < right.boundingBox.minX
            }
            let lines = observations.compactMap { observation -> OCRLine? in
                guard let candidate = observation.topCandidates(1).first else { return nil }
                return OCRLine(confidence: candidate.confidence, text: candidate.string)
            }
            result = OCRPage(
                file: imageURL.lastPathComponent,
                lines: lines,
                error: nil,
                errorDomain: nil,
                errorCode: nil,
                errorDescription: nil
            )
        } catch {
            let nsError = error as NSError
            result = OCRPage(
                file: imageURL.lastPathComponent,
                lines: [],
                error: String(describing: error),
                errorDomain: nsError.domain,
                errorCode: nsError.code,
                errorDescription: nsError.localizedDescription
            )
        }
    } else {
        result = OCRPage(
            file: imageURL.lastPathComponent,
            lines: [],
            error: "unreadable_image",
            errorDomain: "curriculum.ocr.image",
            errorCode: 1,
            errorDescription: "NSImage or CGImage could not be created"
        )
    }

    if let data = try? encoder.encode(result), let line = String(data: data, encoding: .utf8) {
        if let outputDirectory {
            let stem = imageURL.deletingPathExtension().lastPathComponent
            try? data.write(to: outputDirectory.appendingPathComponent("\(stem).json"))
            let text = result.lines.map(\.text).joined(separator: "\n") + "\n"
            try? text.write(
                to: outputDirectory.appendingPathComponent("\(stem).txt"),
                atomically: true,
                encoding: .utf8
            )
        }
        print(line)
    }
}
