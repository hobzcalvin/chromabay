// Generate the iOS App Store icon from a source logo: scale it down with margin onto
// an opaque dark-navy background, output a 1024x1024 PNG with NO alpha channel (App
// Store rejects icons that have transparency).
//
// Usage: swift scripts/make-app-icon.swift <source.png> <out.png> [scale]
import AppKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count >= 3 else { FileHandle.standardError.write("usage: make-app-icon.swift <src> <out> [scale]\n".data(using: .utf8)!); exit(2) }
let srcPath = args[1], outPath = args[2]
let scale = args.count >= 4 ? (Double(args[3]) ?? 0.82) : 0.82
let S = 1024

guard let nsimg = NSImage(contentsOfFile: srcPath) else { fputs("cannot read \(srcPath)\n", stderr); exit(1) }
var rect = NSRect(x: 0, y: 0, width: S, height: S)
guard let cg = nsimg.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { fputs("no cgImage\n", stderr); exit(1) }

// Opaque RGB context (noneSkipLast => no alpha channel in the output).
let cs = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(data: nil, width: S, height: S, bitsPerComponent: 8, bytesPerRow: 0,
                          space: cs, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { exit(1) }
// Dark navy that matches the logo's background corners, so the margin blends in.
ctx.setFillColor(CGColor(red: 9.0/255, green: 12.0/255, blue: 20.0/255, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: S, height: S))

let inner = Double(S) * scale
let off = (Double(S) - inner) / 2.0
ctx.interpolationQuality = .high
ctx.draw(cg, in: CGRect(x: off, y: off, width: inner, height: inner))

guard let out = ctx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: outPath) as CFURL, UTType.png.identifier as CFString, 1, nil)
else { exit(1) }
CGImageDestinationAddImage(dest, out, nil)
if !CGImageDestinationFinalize(dest) { fputs("write failed\n", stderr); exit(1) }
print("wrote \(outPath) (\(S)x\(S), opaque, scale \(scale))")
