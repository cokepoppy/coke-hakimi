import AVFoundation
import CoreGraphics
import ImageIO
import Foundation

let args = CommandLine.arguments
guard args.count == 3 else {
    fputs("usage: extract-video-frames <movie> <output-directory>\n", stderr)
    exit(2)
}

let asset = AVAsset(url: URL(fileURLWithPath: args[1]))
let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.requestedTimeToleranceBefore = .zero
generator.requestedTimeToleranceAfter = .zero

let duration = CMTimeGetSeconds(asset.duration)
let output = URL(fileURLWithPath: args[2], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

for index in 0..<12 {
    let seconds = min(duration - 0.05, Double(index) * duration / 11.0)
    let time = CMTime(seconds: max(0, seconds), preferredTimescale: 600)
    do {
        let image = try generator.copyCGImage(at: time, actualTime: nil)
        let destinationURL = output.appendingPathComponent(String(format: "frame-%02d.jpg", index))
        guard let destination = CGImageDestinationCreateWithURL(destinationURL as CFURL, "public.jpeg" as CFString, 1, nil) else { continue }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
        CGImageDestinationFinalize(destination)
    } catch {
        fputs("frame \(index) failed: \(error)\n", stderr)
    }
}
print("duration=\(duration)")
