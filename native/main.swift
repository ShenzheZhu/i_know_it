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
        guard value != enabled else { return }
        enabled = value
        if !value { restore(); original = nil; files = nil; browser = nil; requestID = nil }
        seen = board.changeCount
    }
    func restore() {
        if ownsClipboard(), let original { original.restore(board) }
        else {
            // Ownership loss also cancels pending work; never reapply an old image over a newer copy.
            original = nil; files = nil; browser = nil; requestID = nil
        }
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
func readExactly(_ count: Int, from input: FileHandle = .standardInput) -> Data? {
    var data = Data()
    while data.count < count {
        guard let part = try? input.read(upToCount: count - data.count), !part.isEmpty else { return nil }
        data.append(part)
    }
    return data
}
func readMessage(from input: FileHandle = .standardInput) -> [String: Any]? {
    guard let header = readExactly(4, from: input) else { return nil }
    let length = header.enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << ($1.offset * 8) }
    guard length > 0, length <= 1_048_576, let payload = readExactly(Int(length), from: input),
          let value = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else { return nil }
    return value
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
    bridge.tick()
    assert(board.changeCount == replacedCount && board.pasteboardItems?.first?.string(forType: marker) == "another owner" && bridge.original == nil)
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
    func reject(_ entry: NSPasteboardItem) {
        board.clearContents(); board.writeObjects([entry])
        let count = board.changeCount; bridge.tick()
        assert(board.changeCount == count && bridge.original == nil && bridge.owned == nil)
    }
    let malformed = NSPasteboardItem(); malformed.setData(Data("not an image".utf8), forType: .png); reject(malformed)
    for type in [marker, NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"), NSPasteboard.PasteboardType("org.nspasteboard.TransientType")] {
        let entry = NSPasteboardItem(); entry.setData(png, forType: .png); entry.setString("private", forType: type)
        reject(entry); assert(board.data(forType: .png) == png)
    }
    let oversized = directory.appendingPathComponent("oversized.png"), empty = directory.appendingPathComponent("empty.png")
    try Data().write(to: oversized); try Data().write(to: empty)
    let sparse = try FileHandle(forWritingTo: oversized); try sparse.truncate(atOffset: 100_000_001); try sparse.close()
    for url in [oversized, empty, directory, directory.appendingPathComponent("missing.png")] {
        let entry = NSPasteboardItem(); entry.setString(url.absoluteString, forType: .fileURL); reject(entry)
    }
    let wide = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 32_769, pixelsHigh: 1, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    wide.bitmapData!.initialize(repeating: 0, count: wide.bytesPerRow)
    let wideItem = NSPasteboardItem(); wideItem.setData(wide.representation(using: .png, properties: [:])!, forType: .png); reject(wideItem)

    // A reply for an older copy must not update a prepared file or attribute the replacement image.
    app = "com.google.Chrome"; putImage(); bridge.tick()
    let pendingReply = reply.merging(["requestId": requested]) { _, new in new }
    app = "com.openai.codex"; bridge.tick()
    let pendingFile = bridge.files!.last!, pendingData = try Data(contentsOf: pendingFile)
    board.clearContents(); board.setString("replacement text", forType: .string)
    let newCount = board.changeCount; bridge.receive(pendingReply)
    let unchanged = try Data(contentsOf: pendingFile)
    assert(board.changeCount == newCount && board.string(forType: .string) == "replacement text" && bridge.browser == nil && bridge.requestID == nil && unchanged == pendingData)
    app = "com.google.Chrome"; putImage(); bridge.tick()
    let disabledReply = reply.merging(["requestId": requested]) { _, new in new }
    app = "com.openai.codex"; bridge.tick(); bridge.setEnabled(false)
    let offCount = board.changeCount; bridge.receive(disabledReply); bridge.tick()
    assert(board.changeCount == offCount && board.data(forType: .png) == png && bridge.browser == nil)
    bridge.setEnabled(true); bridge.tick(); assert(board.changeCount == offCount)
    app = "com.google.Chrome"; putImage(); bridge.tick()
    let oldReply = reply.merging(["requestId": requested]) { _, new in new }
    putImage(); bridge.tick(); let latestID = bridge.requestID
    bridge.receive(oldReply)
    assert(bridge.requestID == latestID && bridge.browser == nil && board.data(forType: .png) == png)
    bridge.receive(["type": "browser-context", "requestId": latestID!, "available": false])
    assert(bridge.requestID == nil && bridge.browser == nil)
    app = "com.openai.codex"; bridge.tick(); assert(bridge.ownsClipboard())
    board.clearContents(); board.setString("copy before switching apps", forType: .string)
    app = "com.apple.TextEdit"; bridge.tick(); app = "com.openai.codex"; bridge.tick()
    assert(board.string(forType: .string) == "copy before switching apps" && bridge.original == nil)

    func frame(_ payload: Data, length: UInt32? = nil) -> Data {
        var size = (length ?? UInt32(payload.count)).littleEndian
        var data = Data(bytes: &size, count: 4); data.append(payload); return data
    }
    let frameFile = directory.appendingPathComponent("native-input")
    var maximum = Data("{}".utf8); maximum.append(Data(repeating: 32, count: 1_048_574))
    for (data, valid) in [
        (frame(Data("{}".utf8)), true), (frame(maximum), true),
        (Data([1, 2, 3]), false), (frame(Data()), false),
        (frame(Data(), length: 1_048_577), false), (frame(Data("{".utf8), length: 2), false),
        (frame(Data("{".utf8)), false), (frame(Data("[]".utf8)), false), (frame(Data([0xff])), false),
    ] {
        try data.write(to: frameFile)
        let input = try FileHandle(forReadingFrom: frameFile)
        let message = readMessage(from: input); try input.close()
        assert((message != nil) == valid)
    }
    try (frame(Data("{}".utf8)) + frame(Data("{\"type\":\"enabled\",\"enabled\":false}".utf8))).write(to: frameFile)
    let input = try FileHandle(forReadingFrom: frameFile)
    let first = readMessage(from: input), second = readMessage(from: input), end = readMessage(from: input); try input.close()
    assert(first != nil && second?["enabled"] as? Bool == false && end == nil)
    bridge.setEnabled(false); app = "com.google.Chrome"; bridge.setEnabled(true); putImage(); bridge.tick()
    board.clearContents(); board.setString("copy before duplicate enable", forType: .string)
    bridge.receive(["type": "enabled", "enabled": true]); app = "com.openai.codex"; bridge.tick()
    assert(board.string(forType: .string) == "copy before duplicate enable", "Duplicate enable resurrected an older screenshot")

    bitmap.setColor(NSColor(deviceRed: 1, green: 0, blue: 0, alpha: 1), atX: 0, y: 0)
    let variants = [png, bitmap.representation(using: .png, properties: [:])!]
    var random: UInt64 = 0x494B49
    func next(_ limit: Int) -> Int {
        random ^= random << 13; random ^= random >> 7; random ^= random << 17
        return Int(random % UInt64(limit))
    }
    for sequence in 0..<64 {
        var generation = 0, imageIndex: Int?, expectedText = "sequence-\(sequence)-initial", foreground = "com.google.Chrome"
        var replies: [[String: Any]] = []
        board.clearContents(); board.setString(expectedText, forType: .string)
        let state = Bridge(board: board, directory: directory.appendingPathComponent("sequence-\(sequence)"), currentApp: { foreground }, request: { id in
            replies.append(["type": "browser-context", "requestId": id, "available": true,
                            "url": "https://example.com/image/\(generation)", "window": ["focused": true]])
        })
        for step in 0..<64 {
            let action = next(12), wasDisabled = !state.enabled, before = board.changeCount
            switch action {
            case 0: state.receive(["type": "enabled", "enabled": true])
            case 1: state.receive(["type": "enabled", "enabled": false])
            case 2, 3:
                generation += 1; imageIndex = action - 2
                board.clearContents(); board.setData(variants[imageIndex!], forType: .png)
            case 4:
                generation += 1; imageIndex = nil; expectedText = "sequence-\(sequence)-copy-\(generation)"
                board.clearContents(); board.setString(expectedText, forType: .string)
            case 5: foreground = "com.google.Chrome"; state.tick()
            case 6: foreground = "com.openai.codex"; state.tick()
            case 7: foreground = "com.apple.TextEdit"; state.tick()
            case 8: if !replies.isEmpty { state.receive(replies[next(replies.count)]) }
            case 9: state.tick(); state.tick()
            case 10: state.restore()
            default:
                state.receive(["type": "enabled", "enabled": true]); state.receive(["type": "enabled", "enabled": true])
            }
            let label = "seed=0x494B49 sequence=\(sequence) step=\(step) action=\(action)"
            if wasDisabled && !state.enabled && ![2, 3, 4].contains(action) {
                assert(board.changeCount == before, "Disabled bridge wrote: \(label)")
            }
            if state.ownsClipboard() {
                assert(state.enabled && foreground == "com.openai.codex" && imageIndex != nil, "Unexpected attachment: \(label)")
                let bytes = try Data(contentsOf: state.files![0]), text = try String(contentsOf: state.files![1], encoding: .utf8)
                assert(bytes == variants[imageIndex!], "Older image resurrected: \(label)")
                if text.contains("- Page URL:") {
                    assert(text.contains(quoted("https://example.com/image/\(generation)")), "Context belongs to an older copy: \(label)")
                }
            } else if let imageIndex {
                assert(board.data(forType: .png) == variants[imageIndex], "Image bytes changed: \(label)")
            } else {
                assert(board.string(forType: .string) == expectedText, "Newer text lost: \(label)")
            }
        }
        state.setEnabled(false)
    }
    print("PASS: 64 deterministic state sequences × 64 actions (4096 transitions), seed=0x494B49.")
    print("PASS: image preservation, malformed/oversized/concealed input, native framing limits, stale replies, immediate attachment, late context, restore/toggle/newer-copy ownership, and disk failure.")
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
    while let value = readMessage() {
        DispatchQueue.main.async { bridge.receive(value) }
    }
    DispatchQueue.main.async { shutdown() }
}
RunLoop.main.run()
