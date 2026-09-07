import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Darwin

let marker = NSPasteboard.PasteboardType("com.iknowit.generated")
let browserApps = Set(["com.google.Chrome", "com.google.Chrome.canary", "com.google.chrome.for.testing", "org.chromium.Chromium"])
let targetApps = Set(["com.openai.codex"])

func quoted(_ value: String) -> String {
    String(data: try! JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes]), encoding: .utf8)!
}
func iso(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }

struct ClipboardImage {
    let items: [[NSPasteboard.PasteboardType: Data]]
    let png: Data
    let width: Int
    let height: Int

    init?(_ board: NSPasteboard) {
        guard let entries = board.pasteboardItems, entries.count == 1,
              !entries[0].types.contains(marker),
              !entries[0].types.contains(where: { $0.rawValue == "org.nspasteboard.ConcealedType" || $0.rawValue == "org.nspasteboard.TransientType" }) else { return nil }
        let entry = entries[0]
        var sourceData: Data?
        if let path = entry.string(forType: .fileURL), let url = URL(string: path), url.isFileURL {
            guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]), values.isRegularFile == true,
                  let size = values.fileSize, size > 0, size <= 100_000_000 else { return nil }
            sourceData = try? Data(contentsOf: url)
        } else {
            sourceData = entry.data(forType: .png) ?? entry.data(forType: .tiff)
        }
        guard let data = sourceData, data.count <= 100_000_000,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let type = CGImageSourceGetType(source) as String?,
              [UTType.png.identifier, UTType.tiff.identifier].contains(type),
              CGImageSourceGetCount(source) == 1,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              type == UTType.png.identifier || properties[kCGImagePropertyOrientation] == nil || properties[kCGImagePropertyOrientation] as? Int == 1,
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 32_768, height <= 32_768, width * height <= 64_000_000,
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
        self.width = image.width; self.height = image.height
        // Preserve PNG bytes; only upright TIFF screenshots can be encoded without changing orientation.
        if type == UTType.png.identifier {
            png = data
        } else {
            let output = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil) else { return nil }
            CGImageDestinationAddImage(destination, image, nil)
            guard CGImageDestinationFinalize(destination) else { return nil }
            png = output as Data
        }
        var snapshot: [NSPasteboard.PasteboardType: Data] = [:]
        var total = 0
        for type in entry.types {
            if let value = entry.data(forType: type) {
                total += value.count
                guard total <= 200_000_000 else { return nil }
                snapshot[type] = value
            }
        }
        items = [snapshot]
    }
    func restore(_ board: NSPasteboard) {
        let restored = items.map { values -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in values { item.setData(data, forType: type) }
            return item
        }
        board.clearContents()
        board.writeObjects(restored)
    }
}

final class Bridge {
    let board: NSPasteboard
    let directory: URL
    let currentApp: () -> String?
    let request: (String) -> Void
    var enabled = false
    var seen: Int
    var owned: Int?
    var ownershipToken: String?
    var original: ClipboardImage?
    var observedAt = Date()
    var observedApp: String?
    var requestID: String?
    var browser: [String: Any]?
    var files: [URL]?

    init(board: NSPasteboard, directory: URL, currentApp: @escaping () -> String?, request: @escaping (String) -> Void) {
        self.board = board; self.directory = directory; self.currentApp = currentApp; self.request = request
        seen = board.changeCount
    }
    func setEnabled(_ value: Bool) {
        enabled = value
        if !value { restore(); original = nil; files = nil; browser = nil; requestID = nil }
        seen = board.changeCount
    }
    func restore() {
        if ownsClipboard(), let original { original.restore(board) }
        owned = nil; ownershipToken = nil; seen = board.changeCount
    }
    func ownsClipboard() -> Bool {
        guard let count = owned, let token = ownershipToken, board.changeCount == count,
              let entries = board.pasteboardItems, entries.count == 2,
              entries.allSatisfy({ $0.string(forType: marker) == token }) else { return false }
        return board.changeCount == count
    }
    func receive(_ message: [String: Any]) {
        if message["type"] as? String == "enabled", let value = message["enabled"] as? Bool { setEnabled(value); return }
        guard enabled, message["type"] as? String == "browser-context",
              let id = message["requestId"] as? String, id == requestID else { return }
        guard board.changeCount == seen else { tick(); return }
        if message["available"] as? Bool == true, browserApps.contains(observedApp ?? ""),
           let window = message["window"] as? [String: Any], window["focused"] as? Bool == true,
           let url = message["url"] as? String, url.count <= 16_384,
           let parsed = URL(string: url), ["http", "https"].contains(parsed.scheme ?? "") {
            browser = message
            // Do not delay paste for the browser; update a prepared context file when its reply arrives.
            if let md = files?.last, let image = original { try? writeMarkdown(image, to: md) }
        }
        requestID = nil
        tick()
    }
    func markdown(_ image: ClipboardImage) -> String {
        var lines = [
            "# Screenshot context", "",
            "- Image: screenshot.png (original image; no crop, scaling, or annotation).",
            "- Image size (px): \(image.width) × \(image.height)",
            "- Clipboard image observed at: \(iso(observedAt))",
            "- Foreground app observed at that time: \(quoted(observedApp ?? "unknown"))",
            "- Screenshot source and crop origin: unknown. Foreground observations do not prove where an image was captured."
        ]
        if let browser {
            lines += ["", "## Browser context observed after the clipboard changed"]
            for (label, key) in [("Page URL", "url"), ("Page title", "title"), ("Observed at", "observedAt")] {
                if let value = browser[key] as? String { lines.append("- \(label): \(quoted(String(value.prefix(16_384))))") }
            }
            for (label, key) in [("Viewport (CSS px)", "viewport"), ("Scroll (CSS px)", "scroll"), ("Browser window", "window"), ("Visual viewport", "visualViewport")] {
                if let value = browser[key] as? [String: Any], JSONSerialization.isValidJSONObject(value),
                   let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) {
                    lines.append("- \(label): \(text)")
                }
            }
            for key in ["zoom", "devicePixelRatio"] {
                if let number = browser[key] as? NSNumber { lines.append("- \(key): \(number)") }
            }
            lines += ["", "This is observed browser context, not verified image provenance. Re-observe the page before clicking; these values are not desktop click coordinates."]
        } else { lines.append("- Browser context: unavailable; no page attribution is inferred.") }
        return lines.joined(separator: "\n") + "\n"
    }
    func writeMarkdown(_ image: ClipboardImage, to url: URL) throws {
        try Data(markdown(image).utf8).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    func tick() {
        guard enabled else { return }
        let count = board.changeCount
        if count != seen {
            // An external copy always replaces our pending work; never restore over a newer copy.
            owned = nil; ownershipToken = nil; original = nil; files = nil; browser = nil; requestID = nil; seen = count
            guard let image = ClipboardImage(board), board.changeCount == count else { return }
            original = image; observedAt = Date(); observedApp = currentApp()
            if browserApps.contains(observedApp ?? "") {
                let id = UUID().uuidString; requestID = id; request(id)
            }
        }
        guard let image = original else { return }
        if !targetApps.contains(currentApp() ?? "") { if owned != nil { restore() }; return }
        guard owned == nil, board.changeCount == seen else { return }
        do {
            if files == nil {
                let folder = directory.appendingPathComponent(UUID().uuidString, isDirectory: true)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                let png = folder.appendingPathComponent("screenshot.png"), md = folder.appendingPathComponent("context.md")
                try image.png.write(to: png, options: .atomic)
                try writeMarkdown(image, to: md)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: png.path)
                files = [png, md]
            }
            guard board.changeCount == seen, enabled, targetApps.contains(currentApp() ?? ""), let files else { return }
            let token = UUID().uuidString
            let entries = files.map { url -> NSPasteboardItem in
                let item = NSPasteboardItem()
                item.setString(url.absoluteString, forType: .fileURL)
                item.setString(token, forType: marker)
                return item
            }
            let cleared = board.clearContents()
            if board.writeObjects(entries) {
                owned = board.changeCount; ownershipToken = token
                if ownsClipboard() { seen = owned! }
                else { owned = nil; ownershipToken = nil }
            }
            else if board.changeCount == cleared { image.restore(board); seen = board.changeCount }
        } catch {
            // Fail silently and preserve the original clipboard; no retry loop for disk failures.
            original = nil; files = nil; requestID = nil
        }
    }
}

func send(_ message: [String: Any]) throws {
    guard let data = try? JSONSerialization.data(withJSONObject: message), data.count <= 1_048_576 else { return }
    var count = UInt32(data.count).littleEndian
    var framed = Data(bytes: &count, count: 4); framed.append(data)
    try FileHandle.standardOutput.write(contentsOf: framed)
}
func readExactly(_ count: Int) -> Data? {
    var data = Data()
    while data.count < count {
        guard let part = try? FileHandle.standardInput.read(upToCount: count - data.count), !part.isEmpty else { return nil }
        data.append(part)
    }
    return data
}

func selfTest() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let board = NSPasteboard(name: NSPasteboard.Name("com.iknowit.test.\(UUID().uuidString)"))
    defer { board.releaseGlobally(); try? FileManager.default.removeItem(at: directory) }
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 4, pixelsHigh: 3, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    for x in 0..<4 { for y in 0..<3 { bitmap.setColor(NSColor(deviceRed: CGFloat(x) / 4, green: CGFloat(y) / 3, blue: 0.9, alpha: 1), atX: x, y: y) } }
    let png = bitmap.representation(using: .png, properties: [:])!
    func putImage() { board.clearContents(); board.setData(png, forType: .png) }
    var app = "com.google.Chrome", requested = ""
    let bridge = Bridge(board: board, directory: directory, currentApp: { app }, request: { requested = $0 })
    bridge.setEnabled(true); putImage(); bridge.tick()
    assert(!requested.isEmpty && bridge.owned == nil && board.data(forType: .png) == png)
    let reply: [String: Any] = ["type": "browser-context", "requestId": requested, "available": true, "url": "https://example.com/settings", "title": "Title\n# content", "observedAt": iso(Date()), "window": ["focused": true], "viewport": ["width": 1200, "height": 800]]
    app = "com.openai.codex"; bridge.tick()
    assert(board.pasteboardItems?.count == 2 && bridge.ownsClipboard() && bridge.requestID != nil)
    let urls = board.pasteboardItems!.compactMap { $0.string(forType: .fileURL) }.compactMap(URL.init(string:))
    let savedPNG = try Data(contentsOf: urls[0]); assert(savedPNG == png)
    let initialMD = try String(contentsOf: urls[1], encoding: .utf8)
    assert(initialMD.contains("Browser context: unavailable"))
    let own = board.changeCount
    bridge.receive(reply)
    assert(board.changeCount == own && bridge.requestID == nil)
    let md = try String(contentsOf: urls[1], encoding: .utf8)
    assert(md.contains("https://example.com/settings") && md.contains("4 × 3") && md.contains("Title\\n# content"))
    bridge.tick(); assert(board.changeCount == own)
    app = "com.apple.TextEdit"; bridge.tick(); assert(board.data(forType: .png) == png)
    app = "com.openai.codex"; bridge.tick(); assert(board.pasteboardItems?.count == 2)
    bridge.setEnabled(false); assert(board.data(forType: .png) == png)
    let disabled = board.changeCount; bridge.tick(); assert(board.changeCount == disabled)
    bridge.setEnabled(true); putImage(); bridge.tick()
    board.clearContents(); board.setString("new user copy", forType: .string)
    bridge.setEnabled(false); assert(board.string(forType: .string) == "new user copy")
    bridge.setEnabled(true); bridge.tick()
    assert(board.string(forType: .string) == "new user copy" && bridge.original == nil)
    let multiple = (0..<2).map { _ -> NSPasteboardItem in
        let item = NSPasteboardItem(); item.setData(png, forType: .png); return item
    }
    board.clearContents(); board.writeObjects(multiple)
    let multipleCount = board.changeCount; bridge.tick()
    assert(board.changeCount == multipleCount && board.pasteboardItems?.count == 2 && bridge.original == nil)
    putImage(); bridge.tick(); assert(bridge.ownsClipboard())
    let replacement = (0..<2).map { _ -> NSPasteboardItem in
        let item = NSPasteboardItem(); item.setString("another owner", forType: marker); return item
    }
    board.clearContents(); board.writeObjects(replacement)
    // Reproduce a newer copy racing the post-write count read: a matching count alone is insufficient.
    bridge.owned = board.changeCount
    let replacedCount = board.changeCount; bridge.restore()
    assert(board.changeCount == replacedCount && board.pasteboardItems?.first?.string(forType: marker) == "another owner")
    bridge.setEnabled(false)
    let file = directory.appendingPathComponent("not-a-directory")
    try Data("file".utf8).write(to: file)
    let failing = Bridge(board: board, directory: file, currentApp: { app }, request: { _ in })
    failing.setEnabled(true); putImage(); let diskCount = board.changeCount; failing.tick()
    assert(board.changeCount == diskCount && board.data(forType: .png) == png && failing.original == nil)
    let tiff = bitmap.representation(using: .tiff, properties: [:])!
    bridge.setEnabled(true); board.clearContents(); board.setData(tiff, forType: .tiff); bridge.tick()
    let converted = bridge.original!, pixels = NSBitmapImageRep(data: converted.png)!, tiffPixels = NSBitmapImageRep(data: tiff)!
    assert(converted.width == 4 && converted.height == 3 && bridge.ownsClipboard())
    for x in 0..<4 { for y in 0..<3 {
        let before = tiffPixels.colorAt(x: x, y: y)!.usingColorSpace(.deviceRGB)!
        let after = pixels.colorAt(x: x, y: y)!.usingColorSpace(.deviceRGB)!
        assert(abs(before.redComponent - after.redComponent) < 1.0 / 255 && abs(before.greenComponent - after.greenComponent) < 1.0 / 255 && abs(before.blueComponent - after.blueComponent) < 1.0 / 255 && before.alphaComponent == after.alphaComponent)
    } }
    bridge.setEnabled(false); assert(board.data(forType: .tiff) == tiff)
    for (type, orientation) in [(UTType.tiff, 6), (UTType.jpeg, 1)] {
        let data = NSMutableData(), url = directory.appendingPathComponent("unchanged.\(type.preferredFilenameExtension!)")
        let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, bitmap.cgImage!, [kCGImagePropertyOrientation: orientation] as CFDictionary)
        let finalized = CGImageDestinationFinalize(destination); assert(finalized)
        try (data as Data).write(to: url)
        let entry = NSPasteboardItem(); entry.setString(url.absoluteString, forType: .fileURL)
        bridge.setEnabled(true); board.clearContents(); board.writeObjects([entry])
        let count = board.changeCount; bridge.tick()
        assert(board.changeCount == count && bridge.original == nil && board.pasteboardItems?.first?.string(forType: .fileURL) == url.absoluteString)
    }
    print("PASS: PNG preservation, upright TIFF pixels, oriented TIFF/JPEG passthrough, immediate attachment and late context, restore/toggle/ownership, text/multiple items, and disk failure.")
}

if CommandLine.arguments.contains("--self-test") {
    do { try selfTest() } catch { fputs("Self-test failed: \(error)\n", stderr); exit(1) }
    exit(0)
}
guard CommandLine.arguments.dropFirst().contains(where: { $0.hasPrefix("chrome-extension://") }) else { exit(0) }
signal(SIGPIPE, SIG_IGN)
let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("I Know It", isDirectory: true)
try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
// ponytail: one active Chrome profile owns the clipboard bridge; multi-profile routing would need a broker.
let lock = open(support.appendingPathComponent("bridge.lock").path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
guard lock >= 0, flock(lock, LOCK_EX | LOCK_NB) == 0 else { exit(0) }
let bridge = Bridge(board: .general, directory: support.appendingPathComponent("captures"), currentApp: {
    NSWorkspace.shared.frontmostApplication?.bundleIdentifier
}, request: {
    do { try send(["type": "request-context", "requestId": $0]) } catch { shutdown() }
})
func shutdown() { bridge.restore(); exit(0) }
// ponytail: restore on normal shutdown; SIGKILL and crashes cannot run cleanup without a persistent recovery journal.
let signalSources = [SIGTERM, SIGINT].map { number -> DispatchSourceSignal in
    signal(number, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
    source.setEventHandler { shutdown() }; source.resume(); return source
}
let timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in bridge.tick() }
let observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { _ in bridge.tick() }
Thread.detachNewThread {
    while let header = readExactly(4) {
        let length = header.enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << ($1.offset * 8) }
        guard length > 0, length <= 1_048_576, let payload = readExactly(Int(length)),
              let value = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else { break }
        DispatchQueue.main.async { bridge.receive(value) }
    }
    DispatchQueue.main.async { shutdown() }
}
RunLoop.main.run()
