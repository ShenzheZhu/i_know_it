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

func browserObservation(_ message: [String: Any], app: String?) -> [String: Any]? {
    guard message["available"] as? Bool == true, browserApps.contains(app ?? ""),
          let window = message["window"] as? [String: Any], window["focused"] as? Bool == true,
          let url = message["url"] as? String, url.count <= 16_384,
          let parsed = URL(string: url), ["http", "https", "chrome"].contains(parsed.scheme ?? ""),
          let host = parsed.host, !host.isEmpty else { return nil }
    var result = message
    if parsed.scheme == "chrome" {
        result["pageAvailable"] = false
        result["pageUnavailableReason"] = "browser-internal-page"
    }
    if result["pageAvailable"] as? Bool == false {
        for key in ["viewport", "scroll", "visualViewport", "devicePixelRatio"] { result[key] = nil }
    }
    return result
}

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

struct RegionDisplay: Equatable {
    let id: CGDirectDisplayID
    let bounds: CGRect
    let scale: CGFloat
}

struct RegionObservation {
    let startedAt: TimeInterval
    let completedAt: TimeInterval
    let display: RegionDisplay
    let globalRect: CGRect
    let displayPixelRect: CGRect
}

// Correlates an observed plain selection with a fresh clipboard image. This is
// not a receipt from macOS and cannot establish the image's source/provenance.
struct RegionGestureTracker {
    private struct Selection {
        let startedAt: TimeInterval
        let clipboardCount: Int
        let displays: [RegionDisplay]
        var lastAt: TimeInterval
        var remainingShortcutModifiers: CGEventFlags = [.maskShift, .maskCommand]
        var keyReleased = false
        var start: CGPoint?
        var observation: RegionObservation?
    }
    private var selection: Selection?
    private(set) var diagnostic = "No matching screenshot selection was observed."
    var isArmed: Bool { selection != nil }
    var isSelecting: Bool { selection != nil && selection?.observation == nil }
    var startedAt: TimeInterval? { selection?.startedAt }

    mutating func reset(_ reason: String = "Selection tracking was reset.") {
        selection = nil; diagnostic = reason
    }

    private static let modifiers: CGEventFlags = [
        .maskShift, .maskControl, .maskAlternate, .maskCommand,
        .maskSecondaryFn, .maskNumericPad, .maskHelp
    ]
    private static let shortcut: CGEventFlags = [.maskControl, .maskShift, .maskCommand]

    private static func integral(_ value: CGFloat) -> Bool {
        value.isFinite && value.rounded(.towardZero) == value
    }

    private static func valid(_ displays: [RegionDisplay]) -> Bool {
        !displays.isEmpty && Set(displays.map(\.id)).count == displays.count && displays.allSatisfy {
            $0.id != 0 && $0.scale.isFinite && $0.scale > 0 &&
            $0.bounds.width > 0 && $0.bounds.height > 0 &&
            [$0.bounds.minX, $0.bounds.minY, $0.bounds.width, $0.bounds.height,
             $0.bounds.maxX, $0.bounds.maxY].allSatisfy(integral)
        }
    }

    private func current(now: TimeInterval, displays: [RegionDisplay]) -> Bool {
        guard let selection, now.isFinite, now >= selection.lastAt,
              selection.displays == displays.sorted(by: { $0.id < $1.id }) else { return false }
        if let result = selection.observation {
            return now >= result.completedAt && now - result.completedAt <= 2
        }
        return now - selection.startedAt <= 60
    }

    // Returns true only when a new shortcut arms. Freeze companion context then.
    @discardableResult
    mutating func observe(type: CGEventType, flags: CGEventFlags,
                          keycode: Int = 0, isRepeat: Bool = false,
                          location: CGPoint = .zero, clipboardCount: Int,
                          displays: [RegionDisplay], now: TimeInterval) -> Bool {
        let modifiers = flags.intersection(Self.modifiers)
        if isArmed && !current(now: now, displays: displays) {
            reset("Selection expired, event time was invalid, or display layout changed.")
        }
        let wasArmed = isArmed
        if type == .keyDown && keycode == 21 {
            defer { if wasArmed { reset() } }
            guard !wasArmed, !isRepeat, modifiers == Self.shortcut,
                  now.isFinite, now >= 0, clipboardCount >= 0, clipboardCount < Int.max,
                  Self.valid(displays) else { return false }
            selection = Selection(startedAt: now, clipboardCount: clipboardCount,
                                  displays: displays.sorted(by: { $0.id < $1.id }), lastAt: now)
            diagnostic = "Shortcut observed; waiting for mouse-down."
            return true
        }
        guard var state = selection else { return false }
        guard clipboardCount == state.clipboardCount ||
                (state.observation != nil && clipboardCount == state.clipboardCount + 1) else {
            reset("Clipboard changed before selection completed, or changed more than once."); return false
        }
        // Caps Lock and event-delivery flags do not affect the native selection.
        let other = modifiers.subtracting(.maskControl)
        if state.start == nil {
            guard other.subtracting(state.remainingShortcutModifiers).isEmpty else {
                reset("Unsupported selection modifiers were observed."); return false
            }
            state.remainingShortcutModifiers.formIntersection(other)
        } else if !other.isEmpty {
            reset("Unsupported selection modifiers were observed."); return false
        }
        switch type {
        case .flagsChanged, .mouseMoved:
            break
        case .keyUp where keycode == 21 && !state.keyReleased:
            state.keyReleased = true
        case .leftMouseDown:
            guard state.start == nil, other.isEmpty,
                  location.x.isFinite, location.y.isFinite else {
                reset("Mouse-down was repeated, modified, or nonfinite."); return false
            }
            state.start = location
            diagnostic = "Mouse-down observed; waiting for mouse-up."
        case .leftMouseDragged:
            guard state.start != nil, state.observation == nil,
                  location.x.isFinite, location.y.isFinite else {
                reset("Drag was out of sequence or nonfinite."); return false
            }
        case .leftMouseUp:
            guard let start = state.start, state.observation == nil,
                  location.x.isFinite, location.y.isFinite else {
                reset("Mouse-up was out of sequence or nonfinite."); return false
            }
            let rect = CGRect(x: min(start.x, location.x), y: min(start.y, location.y),
                              width: abs(location.x - start.x), height: abs(location.y - start.y))
            let candidates = state.displays.filter {
                rect.minX >= $0.bounds.minX && rect.minY >= $0.bounds.minY &&
                rect.maxX <= $0.bounds.maxX && rect.maxY <= $0.bounds.maxY
            }
            guard rect.width > 0, rect.height > 0, candidates.count == 1 else {
                reset("Selection had zero area or did not belong to one unambiguous display."); return false
            }
            let display = candidates[0]
            let pixels = CGRect(x: (rect.minX - display.bounds.minX) * display.scale,
                                y: (rect.minY - display.bounds.minY) * display.scale,
                                width: rect.width * display.scale, height: rect.height * display.scale)
            guard [pixels.minX, pixels.minY, pixels.width, pixels.height,
                   pixels.maxX, pixels.maxY].allSatisfy({ $0.isFinite }),
                  pixels.width < CGFloat(Int.max), pixels.height < CGFloat(Int.max) else {
                reset("Selection pixel extent was invalid."); return false
            }
            state.observation = RegionObservation(startedAt: state.startedAt, completedAt: now,
                                                  display: display, globalRect: rect, displayPixelRect: pixels)
            diagnostic = "Mouse-up observed; waiting for a matching clipboard image."
        default:
            reset("Unsupported or out-of-sequence input cancelled selection tracking."); return false
        }
        state.lastAt = now
        selection = state
        return false
    }

    // Call only when an image is available. A clipboard clear and its image fill
    // may share one changeCount; do not consume the selection for an empty read.
    mutating func consume(width: Int, height: Int, clipboardCount: Int,
                          displays: [RegionDisplay], now: TimeInterval) -> RegionObservation? {
        guard let state = selection else { return nil }
        guard current(now: now, displays: displays) else {
            reset("Selection expired, event time was invalid, or display layout changed."); return nil
        }
        if clipboardCount == state.clipboardCount { return nil }
        defer { selection = nil }
        guard clipboardCount == state.clipboardCount + 1 else {
            diagnostic = "Clipboard changed more than once or its counter reversed."; return nil
        }
        guard let result = state.observation else {
            diagnostic = "Clipboard image arrived before mouse-up was observed."; return nil
        }
        // ponytail: time/size correlation only; allow one logical point of rounding
        // at each edge, but retain raw pointer coordinates rather than guess macOS's crop.
        let tolerance = 2 * result.display.scale
        guard tolerance.isFinite, width > 0, height > 0,
              abs(CGFloat(width) - result.displayPixelRect.width) <= tolerance,
              abs(CGFloat(height) - result.displayPixelRect.height) <= tolerance else {
            diagnostic = "Clipboard image dimensions did not match the observed drag within the rounding tolerance."; return nil
        }
        return result
    }
}

func currentRegionDisplays() -> [RegionDisplay] {
    NSScreen.screens.compactMap { screen in
        guard let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
        return RegionDisplay(id: id.uint32Value, bounds: CGDisplayBounds(id.uint32Value), scale: screen.backingScaleFactor)
    }.sorted { $0.id < $1.id }
}

struct GestureContext {
    let id: String
    let app: String?
    let date: Date
    let time: TimeInterval
    var browser: [String: Any]?
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
    var enabledChanged: (Bool) -> Void = { _ in }
    var displays: () -> [RegionDisplay] = currentRegionDisplays
    var clock: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
    var gesture = RegionGestureTracker()
    var gestureContext: GestureContext?
    var region: RegionObservation?
    var regionContext: GestureContext?
    var regionDiagnostic: String?

    init(board: NSPasteboard, directory: URL, currentApp: @escaping () -> String?, request: @escaping (String) -> Void) {
        self.board = board; self.directory = directory; self.currentApp = currentApp; self.request = request
        seen = board.changeCount
    }
    func setEnabled(_ value: Bool) {
        guard value != enabled else { return }
        enabled = value
        if !value {
            restore(); original = nil; files = nil; browser = nil; requestID = nil
            cancelGesture(); region = nil; regionContext = nil; regionDiagnostic = nil
        }
        seen = board.changeCount
        enabledChanged(value)
    }
    func cancelGesture() { gesture.reset(); gestureContext = nil }
    func observeGesture(type: CGEventType, flags: CGEventFlags, keycode: Int64 = 0,
                        isRepeat: Bool = false, location: CGPoint = .zero) {
        guard enabled else { cancelGesture(); return }
        let now = clock()
        if gesture.observe(type: type, flags: flags, keycode: Int(keycode), isRepeat: isRepeat,
                           location: location, clipboardCount: board.changeCount, displays: displays(), now: now) {
            let context = GestureContext(id: UUID().uuidString, app: currentApp(), date: Date(), time: now)
            gestureContext = context
            if browserApps.contains(context.app ?? "") { request(context.id) }
        } else if !gesture.isArmed { gestureContext = nil }
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
              let id = message["requestId"] as? String else { return }
        if let context = gestureContext, id == context.id {
            // A slow reply belongs to a later scene, so never promote it to shortcut context.
            if gesture.isSelecting && clock() - context.time <= 1 {
                gestureContext?.browser = browserObservation(message, app: context.app)
            }
            return
        }
        guard id == requestID else { return }
        guard board.changeCount == seen else { tick(); return }
        if let context = browserObservation(message, app: observedApp) {
            browser = context
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
        if let region, let context = regionContext {
            func rect(_ r: CGRect) -> String { "x=\(r.minX), y=\(r.minY), width=\(r.width), height=\(r.height)" }
            lines += ["", "## Observed screenshot selection (correlated, not verified)",
                "- Shortcut: Control + Shift + Command + 4",
                "- Shortcut observed at: \(iso(context.date))",
                "- Foreground app at shortcut: \(quoted(context.app ?? "unknown"))",
                "- Observed raw drag extent in global display points: \(rect(region.globalRect))",
                "- Coordinate system: primary display top-left origin; x right, y down; other displays can have negative origins.",
                "- Display ID: \(region.display.id)",
                "- Display bounds in global points: \(rect(region.display.bounds))",
                "- Display backing scale: \(region.display.scale)",
                "- Observed raw drag extent in this display's backing pixels: \(rect(region.displayPixelRect))",
                "- Match: one clipboard change within 2 seconds of mouse-up; each image dimension differs from the raw drag extent by at most \(2 * region.display.scale) pixels (one logical point of rounding per edge). This is a heuristic tolerance, not a measured macOS rounding rule.",
                "- Coordinate precision: raw pointer coordinates are preserved and may be fractional; they are not the exact image crop rectangle.",
                "- Evidence limit: this is an observed drag matched by time and size, not a macOS capture receipt. It does not verify the source app, page, or crop origin.",
                "- Web-page CSS coordinates: unknown; browser chrome, side panels, and zoom prevent deriving them from window bounds.",
                "- Re-observe the live display before clicking; its layout may have changed."]
        } else if let regionDiagnostic {
            lines.append("- Last selection tracking status (may predate this image): \(regionDiagnostic)")
        }
        if let browser {
            lines += ["", region == nil ? "## Browser tab observed after the clipboard changed" : "## Browser context requested at the screenshot shortcut"]
            for (label, key) in [("Page URL", "url"), ("Page title", "title"), ("Observed at", "observedAt")] {
                if let value = browser[key] as? String { lines.append("- \(label): \(quoted(String(value.prefix(16_384))))") }
            }
            for (label, key) in [("Viewport (CSS px)", "viewport"), ("Scroll (CSS px)", "scroll"), ("Browser window", "window"), ("Visual viewport", "visualViewport")] {
                if let value = browser[key] as? [String: Any], JSONSerialization.isValidJSONObject(value),
                   let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) {
                    lines.append("- \(label): \(text)")
                }
            }
            for key in ["windowId", "tabId", "zoom", "devicePixelRatio"] {
                if let number = browser[key] as? NSNumber { lines.append("- \(key): \(number)") }
            }
            if browser["pageAvailable"] as? Bool == false {
                let reason = browser["pageUnavailableReason"] as? String == "browser-internal-page" ? "browser-internal page" : "page could not be read"
                lines.append("- Page measurements: unavailable (\(reason)); viewport and scroll were not read.")
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
            owned = nil; ownershipToken = nil; original = nil; files = nil; browser = nil; requestID = nil
            region = nil; regionContext = nil; regionDiagnostic = nil
            // Clearing and filling a pasteboard can share one change count. Wait for its contents.
            guard let entries = board.pasteboardItems, !entries.isEmpty else { return }
            seen = count
            guard let image = ClipboardImage(board), board.changeCount == count else { cancelGesture(); return }
            original = image; observedAt = Date(); observedApp = currentApp()
            region = gesture.consume(width: image.width, height: image.height, clipboardCount: count, displays: displays(), now: clock())
            if region == nil { regionDiagnostic = gesture.diagnostic }
            if region != nil { regionContext = gestureContext; browser = gestureContext?.browser }
            cancelGesture()
            if region == nil && browserApps.contains(observedApp ?? "") {
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

// A listen-only tap observes the existing system shortcut; it never posts or changes input.
final class RegionInputMonitor {
    let bridge: Bridge
    let preflight: () -> Bool
    let requestPermission: () -> Bool
    let statusChanged: (String) -> Void
    var tap: CFMachPort?
    var source: CFRunLoopSource?
    var status = ""
    var checkedAt: TimeInterval = 0

    init(bridge: Bridge, preflight: @escaping () -> Bool,
         requestPermission: @escaping () -> Bool = { CGRequestListenEventAccess() },
         statusChanged: @escaping (String) -> Void = { try? send(["type": "input-status", "status": $0]) }) {
        self.bridge = bridge; self.preflight = preflight
        self.requestPermission = requestPermission; self.statusChanged = statusChanged
    }
    func report(_ value: String) {
        guard status != value else { return }
        status = value
        statusChanged(value)
    }
    func stop() {
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        if let tap { CFMachPortInvalidate(tap) }
        source = nil; tap = nil
        bridge.cancelGesture()
    }
    func update() {
        guard bridge.enabled else { stop(); report("off"); return }
        // Creating an unauthorized tap can itself prompt. Never do so from startup or polling.
        guard preflight() else { stop(); report("permission-required"); return }
        guard tap == nil else { return }
        let types: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp,
                                    .leftMouseDragged, .mouseMoved, .rightMouseDown, .rightMouseUp,
                                    .otherMouseDown, .otherMouseUp, .scrollWheel]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        guard let created = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                    options: .listenOnly, eventsOfInterest: mask, callback: { _, type, event, data in
                        if let data {
                            Unmanaged<RegionInputMonitor>.fromOpaque(data).takeUnretainedValue().handle(type, event)
                        }
                        return Unmanaged.passUnretained(event)
                    }, userInfo: Unmanaged.passUnretained(self).toOpaque()),
              let runSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, created, 0) else {
            report("unavailable"); return
        }
        tap = created; source = runSource
        CFRunLoopAddSource(CFRunLoopGetMain(), runSource, .commonModes)
        CGEvent.tapEnable(tap: created, enable: true)
        report("ready")
    }
    func poll() {
        let now = ProcessInfo.processInfo.systemUptime
        guard now - checkedAt >= 1 else { return }
        checkedAt = now
        update()
    }
    func requestAccess() {
        guard bridge.enabled else { return }
        // Reached only after an explicit click in the extension's authenticated popup.
        _ = requestPermission()
        update()
    }
    func handle(_ type: CGEventType, _ event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            stop(); report("unavailable"); return
        }
        guard bridge.enabled else { return }
        // Ignore ordinary keyboard/pointer activity immediately; never retain its text or history.
        guard bridge.gesture.isArmed || (type == .keyDown && event.getIntegerValueField(.keyboardEventKeycode) == 21) else { return }
        bridge.observeGesture(type: type, flags: event.flags,
            keycode: event.getIntegerValueField(.keyboardEventKeycode),
            isRepeat: event.getIntegerValueField(.keyboardEventAutorepeat) != 0, location: event.location)
    }
}

func regionSelfTest() {
    let primary = RegionDisplay(id: 1, bounds: CGRect(x: 0, y: 0, width: 1440, height: 900), scale: 2)
    let secondary = RegionDisplay(id: 2, bounds: CGRect(x: -1920, y: -200, width: 1920, height: 1080), scale: 1)
    let displays = [primary, secondary]
    let chord: CGEventFlags = [.maskControl, .maskShift, .maskCommand]
    var checks = 0
    func check(_ value: @autoclosure () -> Bool, _ message: String) {
        checks += 1
        if !value() { fatalError("FAIL: \(message)") }
    }
    func armed(flags: CGEventFlags = chord, repeatKey: Bool = false,
               screens: [RegionDisplay] = displays, count: Int = 40) -> RegionGestureTracker {
        var tracker = RegionGestureTracker()
        tracker.observe(type: .keyDown, flags: flags, keycode: 21, isRepeat: repeatKey,
                        clipboardCount: count, displays: screens, now: 100)
        return tracker
    }
    func event(_ tracker: inout RegionGestureTracker, _ type: CGEventType,
               _ x: CGFloat = 0, _ y: CGFloat = 0, flags: CGEventFlags = [],
               key: Int = 0, time: TimeInterval = 101, count: Int = 40,
               screens: [RegionDisplay] = displays) {
        tracker.observe(type: type, flags: flags, keycode: key,
                        location: CGPoint(x: x, y: y), clipboardCount: count,
                        displays: screens, now: time)
    }
    func completed(start: CGPoint = CGPoint(x: 100, y: 200),
                   end: CGPoint = CGPoint(x: 400, y: 450),
                   flags: CGEventFlags = [], screens: [RegionDisplay] = displays,
                   endTime: TimeInterval = 101.5) -> RegionGestureTracker {
        var tracker = armed(screens: screens)
        event(&tracker, .flagsChanged, flags: [], screens: screens)
        event(&tracker, .leftMouseDown, start.x, start.y, flags: flags, screens: screens)
        event(&tracker, .leftMouseDragged, end.x, end.y, flags: flags, time: endTime, screens: screens)
        event(&tracker, .leftMouseUp, end.x, end.y, flags: flags, time: endTime, screens: screens)
        return tracker
    }
    func consume(_ tracker: inout RegionGestureTracker, width: Int = 600, height: Int = 500,
                 count: Int = 41, time: TimeInterval = 102,
                 screens: [RegionDisplay] = displays) -> RegionObservation? {
        tracker.consume(width: width, height: height, clipboardCount: count,
                        displays: screens, now: time)
    }

    var tracker = completed()
    let retina = consume(&tracker)
    check(retina?.globalRect == CGRect(x: 100, y: 200, width: 300, height: 250), "normal region global points")
    check(retina?.displayPixelRect == CGRect(x: 200, y: 400, width: 600, height: 500), "Retina display pixels")
    check(retina?.startedAt == 100 && retina?.completedAt == 101.5, "observation times")
    check(retina?.display == primary, "display identity")
    check(!tracker.isArmed && consume(&tracker) == nil, "consume once")

    tracker = armed()
    event(&tracker, .leftMouseDown, 100, 200)
    event(&tracker, .leftMouseDragged, 199.81640625, 269.23828125, time: 101.2)
    check(tracker.isArmed, "finite fractional intermediate drag does not cancel")
    event(&tracker, .leftMouseUp, 400, 450, time: 101.5)
    check(consume(&tracker)?.globalRect == retina?.globalRect, "fractional intermediate position does not change endpoints")

    // Reproduces fractional CGEvent locations observed on the user's Mac.
    let fractionalStart = CGPoint(x: 499.81640625, y: 769.23828125)
    let fractionalEnd = CGPoint(x: 696.2890625, y: 472.0546875)
    for reversed in [false, true] {
        for size in [(393, 594), (390, 591), (396, 598)] {
            tracker = completed(start: reversed ? fractionalEnd : fractionalStart,
                                end: reversed ? fractionalStart : fractionalEnd)
            let result = consume(&tracker, width: size.0, height: size.1)
            check(result?.globalRect == CGRect(x: 499.81640625, y: 472.0546875,
                                               width: 196.47265625, height: 297.18359375), "raw fractional endpoints preserved in either direction")
            check(result?.displayPixelRect == CGRect(x: 999.6328125, y: 944.109375,
                                                     width: 392.9453125, height: 594.3671875), "Retina scaling retains fractional pixel extent")
        }
    }
    for size in [(388, 594), (393, 599)] {
        tracker = completed(start: fractionalStart, end: fractionalEnd)
        check(consume(&tracker, width: size.0, height: size.1) == nil && !tracker.isArmed,
              "fractional image mismatch beyond rounding tolerance rejected")
        check(tracker.diagnostic.contains("rounding tolerance"), "dimension mismatch diagnostic retained after consume")
    }
    for size in [(596, 496), (604, 504)] {
        tracker = completed()
        check(consume(&tracker, width: size.0, height: size.1) != nil, "inclusive two-edge Retina rounding tolerance")
    }

    for reversed in [false, true] {
        let a = CGPoint(x: -1800, y: -100), b = CGPoint(x: -1500, y: 150)
        tracker = completed(start: reversed ? b : a, end: reversed ? a : b)
        let result = consume(&tracker, width: 300, height: 250)
        check(result?.globalRect == CGRect(x: -1800, y: -100, width: 300, height: 250), "negative origin and reverse drag")
        check(result?.displayPixelRect == CGRect(x: 120, y: 100, width: 300, height: 250), "secondary screen local pixels")
        let c = CGPoint(x: -1800.25, y: -100.5), d = CGPoint(x: -1500.75, y: 150.25)
        tracker = completed(start: reversed ? d : c, end: reversed ? c : d)
        let fractional = consume(&tracker, width: 300, height: 251)
        check(fractional?.globalRect == CGRect(x: -1800.25, y: -100.5, width: 299.5, height: 250.75), "negative fractional endpoints preserved")
        check(fractional?.displayPixelRect == CGRect(x: 119.75, y: 99.5, width: 299.5, height: 250.75), "secondary fractional local pixels")
    }
    tracker = completed(start: CGPoint(x: 1440, y: 900), end: CGPoint(x: 0, y: 0))
    check(consume(&tracker, width: 2880, height: 1800) != nil, "exact screen bounds")
    tracker = completed(flags: .maskControl)
    check(consume(&tracker) != nil, "Control held optional")
    tracker = completed()
    event(&tracker, .flagsChanged, time: 101.6)
    event(&tracker, .mouseMoved, 500, 500, time: 101.7)
    check(consume(&tracker) != nil, "post-selection modifier release and movement")

    check(armed(flags: chord.union(.maskAlphaShift)).isArmed, "Caps Lock harmless")
    for flag in [CGEventFlags.maskAlternate, .maskSecondaryFn, .maskNumericPad, .maskHelp] {
        check(!armed(flags: chord.union(flag)).isArmed, "extra modifier rejects shortcut")
    }
    for flag in [CGEventFlags.maskControl, .maskShift, .maskCommand] {
        check(!armed(flags: chord.subtracting(flag)).isArmed, "missing modifier rejects shortcut")
    }
    check(!armed(repeatKey: true).isArmed, "repeat key ignored")
    check(!armed(count: -1).isArmed && !armed(count: Int.max).isArmed, "invalid counter rejects shortcut")
    tracker = RegionGestureTracker()
    check(!tracker.observe(type: .keyDown, flags: chord, keycode: 22, clipboardCount: 40, displays: displays, now: 100), "exact physical key only")
    tracker = armed()
    check(tracker.startedAt == 100, "stable arm time")
    check(!tracker.observe(type: .keyDown, flags: chord, keycode: 21, clipboardCount: 40, displays: displays, now: 101), "duplicate shortcut does not rearm")
    check(!tracker.isArmed, "duplicate shortcut cancels uncertainty")
    tracker = armed()
    check(tracker.observe(type: .keyDown, flags: chord, keycode: 21, clipboardCount: 40, displays: displays, now: 161), "expired gesture allows next shortcut")
    check(tracker.startedAt == 161, "new shortcut replaces expired arm time")

    for type in [CGEventType.rightMouseDown, .otherMouseDown, .scrollWheel, .tapDisabledByTimeout, .tapDisabledByUserInput] {
        tracker = armed()
        event(&tracker, type)
        check(!tracker.isArmed, "unexpected input resets")
    }
    for key in [49, 53, 0, 123] { // Space, Escape, A, left arrow.
        tracker = armed()
        event(&tracker, .keyDown, key: key)
        check(!tracker.isArmed, "window mode and other keys reset")
    }
    tracker = armed()
    event(&tracker, .keyUp, key: 21)
    event(&tracker, .keyUp, key: 21)
    check(!tracker.isArmed, "duplicate key release resets")
    for flag in [CGEventFlags.maskShift, .maskCommand, .maskAlternate, .maskSecondaryFn] {
        tracker = armed()
        event(&tracker, .leftMouseDown, 100, 200, flags: flag)
        check(!tracker.isArmed, "nonplain mouse-down resets")
        tracker = armed()
        event(&tracker, .leftMouseDown, 100, 200)
        event(&tracker, .flagsChanged, flags: flag, time: 101.2)
        check(!tracker.isArmed, "modifier added during drag resets")
    }
    tracker = armed()
    event(&tracker, .flagsChanged, flags: [.maskShift, .maskControl])
    event(&tracker, .flagsChanged, flags: .maskControl, time: 101.1)
    event(&tracker, .leftMouseDown, 100, 200, flags: .maskControl, time: 101.2)
    event(&tracker, .flagsChanged, flags: [], time: 101.3)
    event(&tracker, .leftMouseUp, 400, 450, time: 101.5)
    check(consume(&tracker) != nil, "initial modifiers and Control may release naturally")
    tracker = armed()
    event(&tracker, .flagsChanged)
    event(&tracker, .flagsChanged, flags: .maskShift, time: 101.1)
    check(!tracker.isArmed, "released Shift cannot return")

    for type in [CGEventType.leftMouseUp, .leftMouseDragged] {
        tracker = armed()
        event(&tracker, type, 400, 450)
        check(!tracker.isArmed, "missing mouse-down")
    }
    tracker = armed()
    event(&tracker, .leftMouseDown, 100, 200)
    check(consume(&tracker) == nil && !tracker.isArmed, "clipboard image before mouse-up cancels")
    tracker = armed()
    event(&tracker, .leftMouseDown, 100, 200)
    event(&tracker, .leftMouseDown, 100, 200, time: 101.1)
    check(!tracker.isArmed, "duplicate mouse-down")
    tracker = completed()
    event(&tracker, .leftMouseUp, 400, 450, time: 101.6)
    check(!tracker.isArmed, "duplicate mouse-up")

    tracker = completed()
    check(consume(&tracker, count: 40) == nil && tracker.isArmed, "old clipboard image cannot consume selection")
    check(consume(&tracker, count: 41) != nil, "single clear/fill counter becomes eligible when image arrives")
    tracker = armed()
    event(&tracker, .leftMouseDown, 100, 200, count: 41)
    check(!tracker.isArmed, "clipboard change before selection cancels")
    tracker = armed()
    event(&tracker, .leftMouseDown, 100, 200)
    event(&tracker, .leftMouseUp, 400, 450, time: 101.5, count: 41)
    check(!tracker.isArmed, "clipboard change before completion cancels")
    tracker = completed()
    event(&tracker, .mouseMoved, 500, 500, time: 101.7, count: 41)
    check(consume(&tracker) != nil, "empty clear observed after completion can fill at same count")
    tracker = completed()
    event(&tracker, .mouseMoved, 500, 500, time: 101.7, count: 42)
    check(!tracker.isArmed, "multiple clipboard changes while waiting cancel")
    for count in [39, 42, 400] {
        tracker = completed()
        check(consume(&tracker, count: count) == nil && !tracker.isArmed, "counter reversal/jump rejects")
    }
    for size in [(595, 500), (605, 500), (600, 495), (600, 505), (0, 500), (600, 0), (-1, 500), (1200, 1000)] {
        tracker = completed()
        check(consume(&tracker, width: size.0, height: size.1) == nil && !tracker.isArmed, "image dimensions outside tolerance rejected")
    }
    tracker = completed()
    check(consume(&tracker, time: 103.5) != nil, "inclusive result timeout")
    tracker = completed()
    check(consume(&tracker, time: 103.5001) == nil && !tracker.isArmed, "expired result")
    tracker = completed(endTime: 160)
    check(consume(&tracker, time: 162) != nil, "full selection timeout plus two seconds for clipboard")
    tracker = completed(endTime: 160.001)
    check(!tracker.isArmed, "expired selection")
    tracker = armed()
    event(&tracker, .leftMouseDown, 100, 200, time: 101)
    event(&tracker, .leftMouseUp, 400, 450, time: 100.9)
    check(!tracker.isArmed, "out-of-order event time")
    tracker = completed()
    check(consume(&tracker, time: .nan) == nil, "nonfinite time")

    let changed = [RegionDisplay(id: 1, bounds: primary.bounds, scale: 1), secondary]
    tracker = completed()
    check(consume(&tracker, screens: changed) == nil, "scale/topology changes at clipboard read")
    tracker = armed()
    event(&tracker, .leftMouseDown, 100, 200, screens: changed)
    check(!tracker.isArmed, "topology changes during gesture")
    tracker = completed()
    check(consume(&tracker, screens: Array(displays.reversed())) != nil, "display enumeration order irrelevant")
    tracker = completed(start: CGPoint(x: -100, y: 100), end: CGPoint(x: 100, y: 200))
    check(!tracker.isArmed, "cross-screen region rejected")
    tracker = completed(start: CGPoint(x: 100, y: 100), end: CGPoint(x: 100, y: 200))
    check(!tracker.isArmed, "zero area rejected")
    tracker = completed(screens: [primary, RegionDisplay(id: 2, bounds: primary.bounds, scale: 2)])
    check(!tracker.isArmed, "overlapping mirrored displays ambiguous")
    for invalid in [CGFloat.nan, .infinity, -.infinity] {
        for point in [CGPoint(x: invalid, y: 200), CGPoint(x: 100, y: invalid)] {
            for type in [CGEventType.leftMouseDown, .leftMouseDragged, .leftMouseUp] {
                tracker = armed()
                if type != .leftMouseDown { event(&tracker, .leftMouseDown, 100, 200) }
                event(&tracker, type, point.x, point.y)
                check(!tracker.isArmed, "nonfinite pointer coordinates rejected at every drag stage")
                check(tracker.diagnostic.contains("nonfinite"), "nonfinite cancellation diagnostic retained")
            }
        }
    }
    for screens in [[], [primary, primary], [RegionDisplay(id: 1, bounds: primary.bounds, scale: .nan)],
                    [RegionDisplay(id: 0, bounds: primary.bounds, scale: 1)],
                    [RegionDisplay(id: 1, bounds: CGRect(x: 0.5, y: 0, width: 100, height: 100), scale: 1)]] {
        check(!armed(screens: screens).isArmed, "invalid display set")
    }
    print("PASS: \(checks) passive region state checks; no event tap, UI, screenshot, or clipboard access")
}

func selfTest() throws {
    regionSelfTest()
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

    // A screenshot writer can clear first, then supply PNG data without another change count.
    app = "com.google.Chrome"; putImage(); bridge.tick()
    board.clearContents(); bridge.tick()
    assert(bridge.original == nil && bridge.requestID == nil)
    board.setData(png, forType: .png); bridge.tick()
    assert(bridge.original?.png == png && bridge.requestID != nil, "Delayed clipboard data was skipped")
    board.clearContents(); bridge.tick(); board.setString("delayed text", forType: .string)
    app = "com.openai.codex"; bridge.tick()
    assert(board.string(forType: .string) == "delayed text" && bridge.original == nil)

    // Basic tab/window metadata remains useful when Chrome forbids page script injection.
    for (url, reason) in [("chrome://extensions/", "browser-internal-page"), ("https://example.com/restricted", "page-read-failed")] {
        app = "com.google.Chrome"; putImage(); bridge.tick()
        bridge.receive(["type": "browser-context", "requestId": requested, "available": true,
                        "pageAvailable": false, "pageUnavailableReason": reason, "url": url, "title": "Observed tab",
                        "viewport": ["width": 999], "scroll": ["y": 999], "devicePixelRatio": 2,
                        "window": ["focused": true, "left": -1200, "top": 40, "width": 1200, "height": 800]])
        let partial = bridge.markdown(bridge.original!)
        assert(partial.contains(quoted(url)) && partial.contains("Observed tab") && partial.contains("-1200"))
        assert(partial.contains("Page measurements: unavailable") && !partial.contains("Viewport (CSS px)"))
        assert(partial.contains("Screenshot source and crop origin: unknown"))
    }
    for url in ["file:///private/screenshot.png", "javascript:alert(1)", "data:text/html,private", "chrome:extensions"] {
        app = "com.google.Chrome"; putImage(); bridge.tick()
        bridge.receive(["type": "browser-context", "requestId": requested, "available": true,
                        "url": url, "window": ["focused": true]])
        assert(bridge.browser == nil, "Unsupported or malformed browser URL was accepted")
    }

    // Exercise the real bridge with decoded input and a private pasteboard, never a global tap.
    var now: TimeInterval = 1000
    bridge.clock = { now }
    bridge.displays = { [RegionDisplay(id: 7, bounds: CGRect(x: -100, y: -50, width: 500, height: 400), scale: 1)] }
    func startSelection(replyBeforeEnd: Bool = false,
                        start: CGPoint = CGPoint(x: -80, y: -20),
                        end: CGPoint = CGPoint(x: -76, y: -17)) -> String {
        bridge.setEnabled(false); app = "com.google.Chrome"; bridge.setEnabled(true)
        now += 10
        bridge.observeGesture(type: .keyDown, flags: [.maskControl, .maskShift, .maskCommand], keycode: 21)
        assert(bridge.gesture.isArmed && bridge.gestureContext?.app == app)
        let id = requested
        if replyBeforeEnd { bridge.receive(selectionReply(id)) }
        bridge.observeGesture(type: .flagsChanged, flags: [])
        bridge.observeGesture(type: .leftMouseDown, flags: [], location: start)
        bridge.observeGesture(type: .leftMouseDragged, flags: [], location: CGPoint(x: -78.25, y: -18.75))
        now += 0.2
        bridge.observeGesture(type: .leftMouseUp, flags: [], location: end)
        return id
    }
    func selectionReply(_ id: String, url: String = "https://example.com/source-a") -> [String: Any] {
        ["type": "browser-context", "requestId": id, "available": true, "url": url,
         "observedAt": iso(Date()), "window": ["focused": true]]
    }
    _ = startSelection(replyBeforeEnd: true)
    // Clear and delayed fill have one change count. The later foreground app is not the source.
    board.clearContents(); bridge.tick(); app = "com.apple.TextEdit"
    board.setData(png, forType: .png); bridge.tick()
    assert(bridge.region?.globalRect == CGRect(x: -80, y: -20, width: 4, height: 3))
    assert(bridge.region?.displayPixelRect == CGRect(x: 20, y: 30, width: 4, height: 3))
    assert(bridge.regionContext?.app == "com.google.Chrome" && bridge.observedApp == app && bridge.requestID == nil)
    app = "com.openai.codex"; bridge.tick()
    let selectionMD = try String(contentsOf: bridge.files![1], encoding: .utf8)
    assert(selectionMD.contains("source-a") && selectionMD.contains("correlated, not verified") && selectionMD.contains("x=-80.0"))
    assert(selectionMD.contains("requested at the screenshot shortcut") && !selectionMD.contains("## Browser tab observed after"))
    assert(selectionMD.contains("raw drag extent") && selectionMD.contains("at most 2.0 pixels") && !selectionMD.contains("identical image dimensions"))
    assert(!selectionMD.contains("- Last selection tracking status"))
    let regionPNG = try Data(contentsOf: bridge.files![0]); assert(regionPNG == png)
    // A post-copy reply cannot overwrite the request made at the shortcut.
    bridge.receive(selectionReply("unrelated", url: "https://example.com/later-b"))
    assert(bridge.browser?["url"] as? String == "https://example.com/source-a")
    bridge.setEnabled(false)
    assert(board.data(forType: .png) == png && bridge.region == nil && !bridge.gesture.isArmed)

    let lateID = startSelection()
    putImage(); app = "com.openai.codex"; bridge.tick()
    assert(bridge.region != nil && bridge.browser == nil)
    bridge.receive(selectionReply(lateID))
    assert(bridge.browser == nil, "Post-selection replies must not become screenshot context")
    let lateRegionMD = try String(contentsOf: bridge.files![1], encoding: .utf8)
    assert(!lateRegionMD.contains("source-a"))
    board.clearContents(); board.setString("new copy", forType: .string)
    bridge.receive(selectionReply(lateID, url: "https://example.com/too-late"))
    bridge.tick()
    assert(board.string(forType: .string) == "new copy" && bridge.region == nil)

    let slowID = startSelection()
    now += 1.1
    bridge.receive(selectionReply(slowID, url: "https://example.com/too-late"))
    putImage(); bridge.tick()
    assert(bridge.region != nil && bridge.browser == nil, "Delayed page B must not become shortcut context")
    _ = startSelection()
    bridge.observeGesture(type: .keyDown, flags: [], keycode: 49)
    putImage(); bridge.tick()
    assert(bridge.region == nil && bridge.requestID != nil, "Window/move mode cannot produce guessed geometry")
    assert(bridge.markdown(bridge.original!).contains("Unsupported or out-of-sequence input cancelled selection tracking."))

    _ = startSelection(start: CGPoint(x: -80.25, y: -20.25), end: CGPoint(x: -75.75, y: -16.5))
    putImage(); app = "com.openai.codex"; bridge.tick()
    assert(bridge.region?.globalRect == CGRect(x: -80.25, y: -20.25, width: 4.5, height: 3.75))
    let fractionalMD = try String(contentsOf: bridge.files![1], encoding: .utf8)
    assert(fractionalMD.contains("x=-80.25") && fractionalMD.contains("width=4.5, height=3.75"))
    assert(fractionalMD.contains("not the exact image crop rectangle"))
    _ = startSelection(end: CGPoint(x: -73, y: -17))
    putImage(); app = "com.openai.codex"; bridge.tick()
    assert(bridge.region == nil && bridge.regionDiagnostic?.contains("rounding tolerance") == true)
    let mismatchMD = try String(contentsOf: bridge.files![1], encoding: .utf8)
    assert(mismatchMD.contains("- Last selection tracking status (may predate this image):") && mismatchMD.contains("rounding tolerance"))
    assert(!mismatchMD.contains("Observed raw drag extent"))
    bridge.setEnabled(false)

    var permissionRequests = 0, inputStates: [String] = []
    let monitor = RegionInputMonitor(bridge: bridge, preflight: { false },
        requestPermission: { permissionRequests += 1; return false }, statusChanged: { inputStates.append($0) })
    monitor.update(); monitor.requestAccess()
    assert(permissionRequests == 0 && monitor.status == "off")
    bridge.setEnabled(true); monitor.update(); monitor.poll()
    assert(permissionRequests == 0 && monitor.tap == nil && monitor.status == "permission-required")
    monitor.requestAccess()
    assert(permissionRequests == 1 && monitor.tap == nil)
    bridge.setEnabled(false); monitor.update()
    assert(inputStates == ["off", "permission-required", "off"])
    print("PASS: shortcut-time context, delayed clipboard fill, coordinate attachment, late/stale replies, OFF, and explicit-only permission requests.")

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
let inputMonitor = RegionInputMonitor(bridge: bridge, preflight: { CGPreflightListenEventAccess() })
bridge.enabledChanged = { _ in inputMonitor.update() }
func shutdown() { inputMonitor.stop(); bridge.restore(); exit(0) }
// ponytail: restore on normal shutdown; SIGKILL and crashes cannot run cleanup without a persistent recovery journal.
let signalSources = [SIGTERM, SIGINT].map { number -> DispatchSourceSignal in
    signal(number, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
    source.setEventHandler { shutdown() }; source.resume(); return source
}
let timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in bridge.tick(); inputMonitor.poll() }
let observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { _ in bridge.tick() }
Thread.detachNewThread {
    while let value = readMessage() {
        DispatchQueue.main.async {
            if value["type"] as? String == "request-input-access" { inputMonitor.requestAccess() }
            else { bridge.receive(value) }
        }
    }
    DispatchQueue.main.async { shutdown() }
}
RunLoop.main.run()
