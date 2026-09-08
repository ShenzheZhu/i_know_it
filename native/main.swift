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
        for key in ["viewport", "scroll", "visualViewport", "devicePixelRatio", "pointerAnchor", "pageWindow", "fullscreen"] { result[key] = nil }
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

struct RegionShortcut: Equatable {
    let keycode: Int
    let flags: CGEventFlags
    static let standard = RegionShortcut(keycode: 21, flags: [.maskControl, .maskShift, .maskCommand])
    static let modifierMask: CGEventFlags = [
        .maskShift, .maskControl, .maskAlternate, .maskCommand,
        .maskSecondaryFn, .maskNumericPad, .maskHelp
    ]

    func matches(keycode: Int, flags: CGEventFlags) -> Bool {
        keycode == self.keycode && flags.intersection(Self.modifierMask) == self.flags
    }

    static func fromPreferences(_ value: Any?) -> RegionShortcut? {
        // Entry 31 is macOS's "Copy picture of selected area to the clipboard".
        // A missing override retains the system default; invalid overrides never do.
        guard let value else { return .standard }
        guard let keys = value as? [String: Any] else { return nil }
        guard let entry = keys["31"] else { return .standard }
        guard let entry = entry as? [String: Any], let enabled = entry["enabled"] as? NSNumber,
              enabled.doubleValue == 1 else { return nil }
        guard let value = entry["value"] else { return .standard }
        guard let definition = value as? [String: Any], definition["type"] as? String == "standard",
              let parameters = definition["parameters"] as? [Any], parameters.count == 3 else { return nil }
        func integer(_ value: Any) -> UInt64? {
            guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue.isFinite, number.doubleValue >= 0,
                  number.doubleValue <= Double(UInt32.max),
                  number.doubleValue.rounded(.towardZero) == number.doubleValue else { return nil }
            return number.uint64Value
        }
        guard let character = integer(parameters[0]), character <= UInt16.max,
              let key = integer(parameters[1]), key < UInt16.max,
              ![54, 55, 56, 57, 58, 59, 60, 61, 62, 63].contains(key),
              let modifiers = integer(parameters[2]) else { return nil }
        let flags = CGEventFlags(rawValue: modifiers)
        guard flags.subtracting(modifierMask).isEmpty else { return nil }
        // Plain letters, digits and Shift-typing cannot start background tracking.
        let functionKeys: Set<UInt64> = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109,
                                       103, 111, 105, 107, 113, 106, 64, 79, 80, 90]
        guard !flags.intersection([.maskControl, .maskAlternate, .maskCommand]).isEmpty
                || functionKeys.contains(key) else { return nil }
        return RegionShortcut(keycode: Int(key), flags: flags)
    }

    static func current() -> RegionShortcut? {
        fromPreferences(CFPreferencesCopyAppValue("AppleSymbolicHotKeys" as CFString,
                                                 "com.apple.symbolichotkeys" as CFString))
    }
}

// Correlates an observed plain selection with a fresh clipboard image. This is
// not a receipt from macOS and cannot establish the image's source/provenance.
struct RegionGestureTracker {
    private struct Selection {
        let startedAt: TimeInterval
        let clipboardCount: Int
        let displays: [RegionDisplay]
        let shortcut: RegionShortcut
        var lastAt: TimeInterval
        var remainingShortcutModifiers: CGEventFlags
        var keyReleased = false
        var start: CGPoint?
        var observation: RegionObservation?
    }
    private var selection: Selection?
    private(set) var shortcut: RegionShortcut?
    private(set) var diagnostic = "No matching screenshot selection was observed."
    var isArmed: Bool { selection != nil }
    var isSelecting: Bool { selection != nil && selection?.observation == nil }
    var startedAt: TimeInterval? { selection?.startedAt }

    init(shortcut: RegionShortcut? = .standard) { self.shortcut = shortcut }

    @discardableResult
    mutating func setShortcut(_ value: RegionShortcut?) -> Bool {
        guard value != shortcut else { return false }
        shortcut = value
        reset("Screenshot shortcut settings changed; selection tracking was reset.")
        return true
    }

    mutating func reset(_ reason: String = "Selection tracking was reset.") {
        selection = nil; diagnostic = reason
    }

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
        let modifiers = flags.intersection(RegionShortcut.modifierMask)
        if isArmed && !current(now: now, displays: displays) {
            reset("Selection expired, event time was invalid, or display layout changed.")
        }
        let wasArmed = isArmed
        if type == .keyDown, let shortcut, keycode == shortcut.keycode {
            defer { if wasArmed { reset() } }
            guard !wasArmed, !isRepeat, shortcut.matches(keycode: keycode, flags: flags),
                  now.isFinite, now >= 0, clipboardCount >= 0, clipboardCount < Int.max,
                  Self.valid(displays) else { return false }
            selection = Selection(startedAt: now, clipboardCount: clipboardCount,
                                  displays: displays.sorted(by: { $0.id < $1.id }), shortcut: shortcut,
                                  lastAt: now, remainingShortcutModifiers: shortcut.flags.subtracting(.maskControl))
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
        case .keyUp where keycode == state.shortcut.keycode && !state.keyReleased:
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
    var geometryInvalidated = false
}

struct PageRegionEstimate {
    let origin: CGPoint
    let viewportRect: CGRect
    let documentRect: CGRect
    let anchorAgeMs: CGFloat
}

func estimatePageRegion(_ region: RegionObservation, context: GestureContext) -> PageRegionEstimate? {
    func number(_ values: [String: Any], _ key: String) -> CGFloat? {
        guard let value = values[key] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
              value.doubleValue.isFinite else { return nil }
        return CGFloat(value.doubleValue)
    }
    func boolean(_ value: Any?, equals expected: Bool) -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return false }
        return number.boolValue == expected
    }
    func valid(_ rect: CGRect) -> Bool {
        rect.width > 0 && rect.height > 0 &&
            [rect.minX, rect.minY, rect.maxX, rect.maxY, rect.width, rect.height].allSatisfy(\.isFinite)
    }
    guard !context.geometryInvalidated, browserApps.contains(context.app ?? ""),
          let browser = context.browser,
          boolean(browser["available"], equals: true), boolean(browser["pageAvailable"], equals: true),
          boolean(browser["fullscreen"], equals: false),
          let url = browser["url"] as? String, let parsed = URL(string: url),
          ["https", "http"].contains(parsed.scheme ?? ""), parsed.host?.isEmpty == false,
          let anchor = browser["pointerAnchor"] as? [String: Any],
          let screen = anchor["screen"] as? [String: Any], let client = anchor["client"] as? [String: Any],
          let screenX = number(screen, "x"), let screenY = number(screen, "y"),
          let clientX = number(client, "x"), let clientY = number(client, "y"),
          let age = number(anchor, "ageMs"), (0...1000).contains(age),
          let stamp = anchor["observedAt"] as? String, stamp.count <= 64,
          let viewport = browser["viewport"] as? [String: Any],
          let width = number(viewport, "width"), let height = number(viewport, "height"), width > 0, height > 0,
          (0...width).contains(clientX), (0...height).contains(clientY),
          let scroll = browser["scroll"] as? [String: Any],
          let scrollX = number(scroll, "x"), let scrollY = number(scroll, "y"),
          let visual = browser["visualViewport"] as? [String: Any],
          number(visual, "scale") == 1, number(visual, "offsetLeft") == 0, number(visual, "offsetTop") == 0,
          let zoom = number(browser, "zoom"), (0.25...5).contains(zoom),
          let dpr = number(browser, "devicePixelRatio"), dpr > 0,
          region.display.scale.isFinite, region.display.scale > 0,
          abs(dpr - region.display.scale * zoom) <= 0.01,
          let window = browser["window"] as? [String: Any], boolean(window["focused"], equals: true),
          let state = window["state"] as? String, ["normal", "maximized"].contains(state),
          let left = number(window, "left"), let top = number(window, "top"),
          let outerWidth = number(window, "width"), let outerHeight = number(window, "height"),
          let pageWindow = browser["pageWindow"] as? [String: Any],
          let pageX = number(pageWindow, "screenX"), let pageY = number(pageWindow, "screenY"),
          let pageWidth = number(pageWindow, "outerWidth"), let pageHeight = number(pageWindow, "outerHeight"),
          pageWidth > 0, pageHeight > 0,
          abs(pageX - left) <= 1, abs(pageY - top) <= 1,
          abs(pageWidth - outerWidth) <= 1, abs(pageHeight - outerHeight) <= 1 else { return nil }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = formatter.date(from: stamp) ?? ISO8601DateFormatter().date(from: stamp)
    // The reply is accepted within one second of the shortcut; the anchor is at most one second old.
    guard let date, abs(date.timeIntervalSince(context.date)) <= 2 else { return nil }
    let windowRect = CGRect(x: left, y: top, width: outerWidth, height: outerHeight)
    let origin = CGPoint(x: screenX - clientX * zoom, y: screenY - clientY * zoom)
    let contentRect = CGRect(x: origin.x, y: origin.y, width: width * zoom, height: height * zoom)
    // Real Chrome PointerEvent client coordinates have Float32 precision: fractional
    // zoom produced sub-0.001-point edge drift. Larger display/crop overflows stay unknown.
    let edgeEpsilon: CGFloat = 0.001
    guard valid(windowRect), valid(contentRect), valid(region.display.bounds), valid(region.globalRect),
          windowRect.insetBy(dx: -1, dy: -1).contains(contentRect),
          region.display.bounds.insetBy(dx: -edgeEpsilon, dy: -edgeEpsilon).contains(contentRect),
          contentRect.insetBy(dx: -edgeEpsilon, dy: -edgeEpsilon).contains(region.globalRect) else { return nil }
    let viewportRect = CGRect(x: (region.globalRect.minX - origin.x) / zoom,
                              y: (region.globalRect.minY - origin.y) / zoom,
                              width: region.globalRect.width / zoom, height: region.globalRect.height / zoom)
    let documentRect = viewportRect.offsetBy(dx: scrollX, dy: scrollY)
    guard valid(viewportRect), valid(documentRect) else { return nil }
    return PageRegionEstimate(origin: origin, viewportRect: viewportRect, documentRect: documentRect, anchorAgeMs: age)
}

struct PasteboardEpoch: Equatable {
    let pid: pid_t
    let seconds: UInt64
    let microseconds: UInt64
}

func currentPasteboardEpoch() -> PasteboardEpoch? {
    let bytes = proc_listpids(UInt32(PROC_UID_ONLY), getuid(), nil, 0)
    guard bytes > 0, bytes < 800_000 else { return nil }
    var pids = [pid_t](repeating: 0, count: Int(bytes) / MemoryLayout<pid_t>.stride + 64)
    let capacity = pids.count * MemoryLayout<pid_t>.stride
    let actual = proc_listpids(UInt32(PROC_UID_ONLY), getuid(), &pids, Int32(capacity))
    guard actual > 0, actual < capacity, Int(actual) % MemoryLayout<pid_t>.stride == 0 else { return nil }
    var epochs: [PasteboardEpoch] = []
    for pid in pids.prefix(Int(actual) / MemoryLayout<pid_t>.stride) where pid > 0 {
        var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        if proc_pidpath(pid, &path, UInt32(path.count)) <= 0 {
            if errno == ESRCH { continue } // The process exited after the UID-scoped inventory.
            return nil
        }
        guard String(cString: path) == "/usr/libexec/pboard" else { continue }
        var info = proc_bsdinfo()
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.stride)) == MemoryLayout<proc_bsdinfo>.stride,
              info.pbi_uid == getuid(), info.pbi_start_tvsec > 0 else { return nil }
        epochs.append(PasteboardEpoch(pid: pid, seconds: info.pbi_start_tvsec, microseconds: info.pbi_start_tvusec))
    }
    return epochs.count == 1 ? epochs[0] : nil
}

// Unlike an image decode, recovery requires every advertised representation.
func completePasteboardItems(_ board: NSPasteboard, expected: [[NSPasteboard.PasteboardType: Data]]? = nil, onMissingData: (() -> Void)? = nil) -> [[NSPasteboard.PasteboardType: Data]]? {
    guard let entries = board.pasteboardItems, !entries.isEmpty, entries.count <= 2 else { return nil }
    guard !entries.contains(where: { entry in entry.types.contains(where: {
        $0.rawValue == "org.nspasteboard.ConcealedType" || $0.rawValue == "org.nspasteboard.TransientType"
    }) }) else { return nil }
    if let expected {
        guard expected.count == entries.count, zip(entries, expected).allSatisfy({ Set($0.0.types) == Set($0.1.keys) }) else { return nil }
    }
    var total = 0, result: [[NSPasteboard.PasteboardType: Data]] = []
    for (index, entry) in entries.enumerated() {
        var values: [NSPasteboard.PasteboardType: Data] = [:]
        let types = expected.map { expected in entry.types.sorted { expected[index][$0]!.count < expected[index][$1]!.count } } ?? entry.types
        for type in types {
            guard let data = entry.data(forType: type) else { onMissingData?(); return nil }
            total += data.count
            guard total <= 200_000_000 else { return nil }
            values[type] = data
        }
        guard !values.isEmpty else { return nil }
        result.append(values)
    }
    return result
}

struct SuspendedCapture {
    let generation: Int
    let items: [[NSPasteboard.PasteboardType: Data]]
    let epoch: PasteboardEpoch
    let suspendedAt: TimeInterval
    let image: ClipboardImage
    let region: RegionObservation
    let context: GestureContext
    let observedAt: Date
    let observedApp: String?
    let browser: [String: Any]?
    let files: [URL]?
    let owned: Int?
    let ownershipToken: String?
}

final class Bridge {
    let board: NSPasteboard
    let directory: URL
    let currentApp: () -> String?
    let request: (String) -> Void
    var clipboardCount: () -> Int
    var pasteboardEpoch: () -> PasteboardEpoch? = currentPasteboardEpoch
    var captureEpoch: PasteboardEpoch?
    var captureItems: [[NSPasteboard.PasteboardType: Data]]?
    var suspended: SuspendedCapture?
    var deferredImage: (generation: Int, deadline: TimeInterval)?
    var recoveryPending = false
    var enabled = false
    var seen: Int
    var observedGeneration: Int
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
        clipboardCount = { board.changeCount }
        seen = board.changeCount; observedGeneration = seen
    }
    func setEnabled(_ value: Bool) {
        guard value != enabled else { return }
        enabled = value
        if !value {
            restore(); original = nil; files = nil; browser = nil; requestID = nil
            cancelGesture(); region = nil; regionContext = nil; regionDiagnostic = nil
            suspended = nil; captureEpoch = nil; captureItems = nil; deferredImage = nil; recoveryPending = false
        }
        seen = clipboardCount(); observedGeneration = seen
        enabledChanged(value)
    }
    func cancelGesture() { gesture.reset(); gestureContext = nil }
    func setRegionShortcut(_ value: RegionShortcut?) {
        if gesture.setShortcut(value) { gestureContext = nil }
    }
    func observeGesture(type: CGEventType, flags: CGEventFlags, keycode: Int64 = 0,
                        isRepeat: Bool = false, location: CGPoint = .zero) {
        guard enabled else { cancelGesture(); return }
        let now = clock()
        if gesture.observe(type: type, flags: flags, keycode: Int(keycode), isRepeat: isRepeat,
                           location: location, clipboardCount: clipboardCount(), displays: displays(), now: now) {
            let context = GestureContext(id: UUID().uuidString, app: currentApp(), date: Date(), time: now)
            gestureContext = context
            if browserApps.contains(context.app ?? "") { request(context.id) }
        } else if !gesture.isArmed { gestureContext = nil }
    }
    func restore() {
        if ownsClipboard(), let original { original.restore(board) }
        else {
            // Ownership loss also cancels pending work; never reapply an old image over a newer copy.
            original = nil; files = nil; browser = nil; requestID = nil; captureItems = nil; captureEpoch = nil
        }
        owned = nil; ownershipToken = nil; seen = clipboardCount(); observedGeneration = seen
        rememberRepresentations()
    }
    func rememberRepresentations() {
        guard original != nil, region != nil, captureEpoch != nil else { captureItems = nil; return }
        let items = completePasteboardItems(board)
        captureItems = clipboardCount() == seen ? items : nil
    }
    func suspendCapture() {
        guard let image = original, !image.items.contains(where: { $0[.fileURL] != nil }),
              let region, let context = regionContext, let epoch = captureEpoch, let items = captureItems else { return }
        suspended = SuspendedCapture(generation: seen, items: items, epoch: epoch, suspendedAt: clock(),
            image: image, region: region, context: context, observedAt: observedAt, observedApp: observedApp,
            browser: browser, files: files, owned: owned, ownershipToken: ownershipToken)
    }
    func recoverSuspended(_ generation: Int) -> Bool {
        guard let saved = suspended, generation == saved.generation else { return false }
        guard pasteboardEpoch() == saved.epoch else { suspended = nil; recoveryPending = false; return false }
        var missing = false
        let items = completePasteboardItems(board, expected: saved.items, onMissingData: { missing = true })
        guard clipboardCount() == generation, pasteboardEpoch() == saved.epoch, clipboardCount() == generation else {
            suspended = nil; recoveryPending = false; return false
        }
        if missing {
            if !recoveryPending { deferredImage = (generation, clock() + 2) }
            recoveryPending = true
            if clock() < deferredImage!.deadline { return false }
            suspended = nil; recoveryPending = false; deferredImage = nil; seen = generation
            cancelGesture(); return false
        }
        guard items == saved.items else { suspended = nil; recoveryPending = false; return false }
        suspended = nil; cancelGesture(); requestID = nil; deferredImage = nil; recoveryPending = false
        original = saved.image; region = saved.region; regionContext = saved.context; regionDiagnostic = nil
        observedAt = saved.observedAt; observedApp = saved.observedApp; browser = saved.browser; files = saved.files
        seen = generation; owned = saved.owned; ownershipToken = saved.ownershipToken
        captureEpoch = saved.epoch; captureItems = saved.items
        return true
    }
    func ownsClipboard() -> Bool {
        guard let count = owned, let token = ownershipToken, clipboardCount() == count,
              let entries = board.pasteboardItems, entries.count == 2,
              entries.allSatisfy({ $0.string(forType: marker) == token }) else { return false }
        return clipboardCount() == count
    }
    func receive(_ message: [String: Any]) {
        if message["type"] as? String == "enabled", let value = message["enabled"] as? Bool { setEnabled(value); return }
        if enabled, message["type"] as? String == "browser-geometry-invalidated" {
            // The snapshot freezes when a matching clipboard image is accepted, not at mouse-up.
            // Later page changes cannot alter an already completed or suspended screenshot.
            gestureContext?.geometryInvalidated = true
            return
        }
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
        guard clipboardCount() == seen else { tick(); return }
        if let context = browserObservation(message, app: observedApp) {
            browser = context
            // Do not delay paste for the browser; update a prepared context file when its reply arrives.
            updatePreparedMarkdown()
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
                "- Shortcut: Configured macOS region-to-clipboard shortcut",
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
                "- Evidence limit: this is an observed drag matched by time and size, not a macOS capture receipt. It does not verify the source app, page, or crop origin."]
            if let estimate = estimatePageRegion(region, context: context) {
                lines += [
                    "- Estimated content viewport origin in global display points: x=\(estimate.origin.x), y=\(estimate.origin.y)",
                    "- Estimated selection in viewport CSS pixels: \(rect(estimate.viewportRect))",
                    "- Estimated selection in top-document CSS pixels: \(rect(estimate.documentRect))",
                    "- Pointer anchor age at browser observation: \(estimate.anchorAgeMs) ms.",
                    "- Estimation: recent pointer screen/client observation with browser zoom. Coordinates may be fractional; window agreement allows up to 1 display point of rounding. This estimates the raw drag, not the exact image crop, verified page provenance, or iframe-local coordinates."
                ]
            } else {
                lines.append(context.geometryInvalidated
                    ? "- Web-page CSS coordinates: unknown; browser geometry changed after the screenshot shortcut."
                    : "- Web-page CSS coordinates: unknown; a fresh, stable pointer observation and unambiguous viewport/display mapping are required.")
            }
            lines.append("- Re-observe the live display before clicking; its layout may have changed.")
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
    func updatePreparedMarkdown() {
        guard let md = files?.last, let image = original else { return }
        do { try writeMarkdown(image, to: md) }
        catch {
            // Withdraw our prepared pair if its metadata can no longer be corrected.
            if ownsClipboard() { restore() }
            files = nil
        }
    }
    func tick() {
        guard enabled else { return }
        let count = clipboardCount()
        // ponytail: keep one displaced correlated capture for ten minutes, never an image history.
        if let saved = suspended, !(0...600).contains(clock() - saved.suspendedAt) {
            suspended = nil; recoveryPending = false; deferredImage = nil
        }
        let rolledBack = count < observedGeneration
        observedGeneration = count
        if recoveryPending && deferredImage?.generation != count { recoveryPending = false; deferredImage = nil }
        let recovered = (rolledBack || recoveryPending) && recoverSuspended(count)
        if recoveryPending { return }
        if count != seen && !recovered {
            suspendCapture()
            if deferredImage?.generation != count { deferredImage = nil }
            // An external copy always replaces our pending work; never restore over a newer copy.
            owned = nil; ownershipToken = nil; original = nil; files = nil; browser = nil; requestID = nil
            region = nil; regionContext = nil; regionDiagnostic = nil; captureEpoch = nil; captureItems = nil
            // Clearing and filling a pasteboard can share one change count. Wait for its contents.
            guard let entries = board.pasteboardItems, !entries.isEmpty else { return }
            // A system writer can advertise PNG/TIFF before supplying its bytes at the same generation.
            // Retry only missing declared image bytes, for at most two seconds, before any decode.
            if entries.count == 1, !entries[0].types.contains(.fileURL), !entries[0].types.contains(marker),
               !entries[0].types.contains(where: { $0.rawValue == "org.nspasteboard.ConcealedType" || $0.rawValue == "org.nspasteboard.TransientType" }),
               entries[0].types.contains(.png) || entries[0].types.contains(.tiff),
               entries[0].data(forType: .png) == nil, entries[0].data(forType: .tiff) == nil {
                if deferredImage?.generation != count { deferredImage = (count, clock() + 2) }
                if clock() < deferredImage!.deadline { return }
            }
            deferredImage = nil; seen = count
            guard let image = ClipboardImage(board), clipboardCount() == count else { cancelGesture(); return }
            original = image; observedAt = Date(); observedApp = currentApp()
            region = gesture.consume(width: image.width, height: image.height, clipboardCount: count, displays: displays(), now: clock())
            if region == nil { regionDiagnostic = gesture.diagnostic }
            if region != nil {
                suspended = nil; regionContext = gestureContext; browser = gestureContext?.browser
                captureEpoch = pasteboardEpoch(); rememberRepresentations()
            }
            cancelGesture()
            if region == nil && browserApps.contains(observedApp ?? "") {
                let id = UUID().uuidString; requestID = id; request(id)
            }
        }
        guard let image = original else { return }
        if !targetApps.contains(currentApp() ?? "") { if owned != nil { restore() }; return }
        guard owned == nil, clipboardCount() == seen else { return }
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
            guard clipboardCount() == seen, enabled, targetApps.contains(currentApp() ?? ""), let files else { return }
            let token = UUID().uuidString
            let entries = files.map { url -> NSPasteboardItem in
                let item = NSPasteboardItem()
                item.setString(url.absoluteString, forType: .fileURL)
                item.setString(token, forType: marker)
                return item
            }
            let cleared = board.clearContents()
            if board.writeObjects(entries) {
                owned = clipboardCount(); ownershipToken = token
                if ownsClipboard() { seen = owned!; observedGeneration = seen; rememberRepresentations() }
                else { owned = nil; ownershipToken = nil }
            }
            else if clipboardCount() == cleared { image.restore(board); seen = clipboardCount() }
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
    let readShortcut: () -> RegionShortcut?
    var tap: CFMachPort?
    var source: CFRunLoopSource?
    var status = ""
    var checkedAt: TimeInterval = 0

    init(bridge: Bridge, preflight: @escaping () -> Bool,
         requestPermission: @escaping () -> Bool = { CGRequestListenEventAccess() },
         readShortcut: @escaping () -> RegionShortcut? = RegionShortcut.current,
         statusChanged: @escaping (String) -> Void = { try? send(["type": "input-status", "status": $0]) }) {
        self.bridge = bridge; self.preflight = preflight
        self.requestPermission = requestPermission; self.statusChanged = statusChanged
        self.readShortcut = readShortcut
        bridge.setRegionShortcut(readShortcut())
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
        bridge.setRegionShortcut(readShortcut())
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
        guard bridge.gesture.isArmed || (type == .keyDown
            && event.getIntegerValueField(.keyboardEventAutorepeat) == 0
            && bridge.gesture.shortcut?.matches(keycode: Int(event.getIntegerValueField(.keyboardEventKeycode)),
                                                flags: event.flags) == true) else { return }
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

    func preferences(key: Any = 21, flags: Any = UInt64(CGEventFlags.maskControl.rawValue),
                     character: Any = 52, enabled: Any = true) -> [String: Any] {
        ["31": ["enabled": enabled, "value": ["type": "standard", "parameters": [character, key, flags]]]]
    }
    let control4 = RegionShortcut(keycode: 21, flags: .maskControl)
    let customKey = RegionShortcut(keycode: 1, flags: [.maskAlternate, .maskCommand])
    check(RegionShortcut.fromPreferences(nil) == .standard, "absent preferences use default shortcut")
    check(RegionShortcut.fromPreferences([:]) == .standard, "absent entry uses default shortcut")
    check(RegionShortcut.fromPreferences(["31": ["enabled": true]]) == .standard, "enabled default without value")
    check(RegionShortcut.fromPreferences(preferences()) == control4, "live custom Control-4 override")
    check(RegionShortcut.fromPreferences(preferences(key: 1, flags: customKey.flags.rawValue)) == customKey,
          "custom physical key and modifier override")
    check(RegionShortcut.fromPreferences(preferences(key: 122, flags: 0, character: 65535))?.keycode == 122,
          "unmodified function key is not plain typing")
    check(RegionShortcut.fromPreferences(preferences(enabled: false)) == nil, "explicitly disabled shortcut")
    for value: Any in ["invalid", ["31": "invalid"], ["31": [:]], ["31": ["enabled": "true"]],
                      ["31": ["enabled": true, "value": [:]]],
                      ["31": ["enabled": true, "value": ["type": "other", "parameters": [52, 21, 262144]]]],
                      ["31": ["enabled": true, "value": ["type": "standard", "parameters": [21, 262144]]]]] {
        check(RegionShortcut.fromPreferences(value) == nil, "malformed setting never falls back")
    }
    for key: Any in [-1, 65535, 65536, true, "21", 21.5, Double.infinity, Double.nan] {
        check(RegionShortcut.fromPreferences(preferences(key: key)) == nil, "invalid keycode rejected")
    }
    for key in 54...63 {
        check(RegionShortcut.fromPreferences(preferences(key: key)) == nil, "modifier-only key rejected")
    }
    for flags: Any in [-1, true, "262144", 262144.5, UInt64.max, CGEventFlags.maskAlphaShift.rawValue] {
        check(RegionShortcut.fromPreferences(preferences(flags: flags)) == nil, "invalid modifier mask rejected")
    }
    for flags in [CGEventFlags(), .maskShift, .maskSecondaryFn, .maskNumericPad] {
        check(RegionShortcut.fromPreferences(preferences(flags: flags.rawValue)) == nil, "plain or Shift-typing cannot arm")
    }
    check(!customKey.matches(keycode: 21, flags: customKey.flags)
          && !customKey.matches(keycode: 1, flags: customKey.flags.union(.maskControl)), "exact configured key and modifiers only")
    check(customKey.matches(keycode: 1, flags: customKey.flags.union(.maskAlphaShift)), "custom chord ignores Caps Lock")
    for shortcut in [control4, customKey] {
        var custom = RegionGestureTracker(shortcut: shortcut)
        check(custom.observe(type: .keyDown, flags: shortcut.flags, keycode: shortcut.keycode,
                             clipboardCount: 40, displays: displays, now: 100), "custom shortcut arms")
        event(&custom, .keyUp, flags: shortcut.flags, key: shortcut.keycode)
        event(&custom, .flagsChanged, flags: shortcut.flags.intersection(.maskCommand), time: 101.1)
        event(&custom, .flagsChanged, time: 101.2)
        event(&custom, .leftMouseDown, 100, 200, flags: .maskControl, time: 101.3)
        event(&custom, .leftMouseDragged, 299.25, 399.5, flags: .maskControl, time: 101.4)
        event(&custom, .leftMouseUp, 400, 450, flags: .maskControl, time: 101.5)
        check(consume(&custom) != nil, "custom key release, initial modifiers release, Control-drag retained")
    }
    var changedShortcut = armed()
    check(!changedShortcut.setShortcut(.standard) && changedShortcut.isArmed, "unchanged setting retains pending selection")
    check(changedShortcut.setShortcut(control4) && !changedShortcut.isArmed, "changed setting cancels pending selection")
    check(!changedShortcut.observe(type: .keyDown, flags: chord, keycode: 21,
                                  clipboardCount: 40, displays: displays, now: 101), "old default chord no longer arms")
    check(changedShortcut.observe(type: .keyDown, flags: .maskControl, keycode: 21,
                                 clipboardCount: 40, displays: displays, now: 102), "new configured chord arms")
    check(changedShortcut.setShortcut(nil) && !changedShortcut.isArmed, "disabling shortcut cancels pending selection")
    check(!changedShortcut.observe(type: .keyDown, flags: .maskControl, keycode: 21,
                                  clipboardCount: 40, displays: displays, now: 103), "disabled shortcut never arms")

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
    let pageDate = Date(timeIntervalSince1970: 2_000_000_000.125)
    func pageContext(zoom: CGFloat = 1.25) -> GestureContext {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return GestureContext(id: "page-test", app: "com.google.Chrome", date: pageDate, time: 100, browser: [
            "available": true, "pageAvailable": true, "url": "https://example.com/page", "fullscreen": false,
            "zoom": zoom, "devicePixelRatio": 2 * zoom,
            "viewport": ["width": 800 / zoom, "height": 400 / zoom],
            "scroll": ["x": 17.25, "y": 500.5],
            "visualViewport": ["scale": 1, "offsetLeft": 0, "offsetTop": 0],
            "window": ["focused": true, "state": "normal", "left": 100, "top": 100, "width": 900, "height": 600],
            "pageWindow": ["screenX": 100, "screenY": 100, "outerWidth": 900, "outerHeight": 600],
            "pointerAnchor": ["screen": ["x": 140 + 100 * zoom, "y": 220 + 50 * zoom],
                              "client": ["x": 100, "y": 50], "ageMs": 100,
                              "observedAt": formatter.string(from: pageDate.addingTimeInterval(-0.1))]
        ])
    }
    func pageRegion(_ rect: CGRect = CGRect(x: 340, y: 320, width: 200, height: 100),
                    display: RegionDisplay = primary) -> RegionObservation {
        RegionObservation(startedAt: 100, completedAt: 101, display: display, globalRect: rect,
                          displayPixelRect: .zero)
    }
    func replacing(_ values: [String: Any], _ path: [String], _ value: Any?) -> [String: Any] {
        var copy = values
        if path.count == 1 { copy[path[0]] = value }
        else { copy[path[0]] = replacing(copy[path[0]] as? [String: Any] ?? [:], Array(path.dropFirst()), value) }
        return copy
    }
    func alteredPage(_ path: [String], _ value: Any?) -> GestureContext {
        var context = pageContext()
        context.browser = replacing(context.browser!, path, value)
        return context
    }
    for zoom: CGFloat in [0.25, 0.5, 1, 1.1, 1.25, 2, 5] {
        let estimate = estimatePageRegion(pageRegion(), context: pageContext(zoom: zoom))
        check(estimate?.origin == CGPoint(x: 140, y: 220), "pointer anchor measures viewport origin across zoom")
        check(estimate?.viewportRect == CGRect(x: 200 / zoom, y: 100 / zoom, width: 200 / zoom, height: 100 / zoom),
              "raw drag maps to viewport CSS at normal and fractional zoom")
        check(estimate?.documentRect == CGRect(x: 200 / zoom + 17.25, y: 100 / zoom + 500.5,
                                               width: 200 / zoom, height: 100 / zoom), "scroll maps into top-document CSS")
    }
    let numericPaths = [["zoom"], ["devicePixelRatio"], ["pointerAnchor", "ageMs"],
        ["pointerAnchor", "screen", "x"], ["pointerAnchor", "screen", "y"],
        ["pointerAnchor", "client", "x"], ["pointerAnchor", "client", "y"],
        ["viewport", "width"], ["viewport", "height"], ["scroll", "x"], ["scroll", "y"],
        ["visualViewport", "scale"], ["visualViewport", "offsetLeft"], ["visualViewport", "offsetTop"],
        ["window", "left"], ["window", "top"], ["window", "width"], ["window", "height"],
        ["pageWindow", "screenX"], ["pageWindow", "screenY"], ["pageWindow", "outerWidth"], ["pageWindow", "outerHeight"]]
    for path in numericPaths {
        for invalid: Any? in [nil, true, "1", Double.nan, Double.infinity] {
            check(estimatePageRegion(pageRegion(), context: alteredPage(path, invalid)) == nil,
                  "missing, Boolean, string and nonfinite geometry values fail closed: \(path)")
        }
    }
    for path in [["available"], ["pageAvailable"], ["fullscreen"], ["window", "focused"]] {
        for invalid: Any? in [nil, 0, 1, "false"] {
            check(estimatePageRegion(pageRegion(), context: alteredPage(path, invalid)) == nil, "explicit Boolean fields required")
        }
    }
    for path in [["viewport", "width"], ["viewport", "height"], ["window", "width"], ["window", "height"],
                 ["pageWindow", "outerWidth"], ["pageWindow", "outerHeight"]] {
        check(estimatePageRegion(pageRegion(), context: alteredPage(path, 0)) == nil, "positive dimensions required")
    }
    for value: CGFloat in [0.249, 5.001] {
        check(estimatePageRegion(pageRegion(), context: alteredPage(["zoom"], value)) == nil, "unsupported zoom rejected")
    }
    for value in [0, 1000] {
        check(estimatePageRegion(pageRegion(), context: alteredPage(["pointerAnchor", "ageMs"], value)) != nil, "inclusive anchor age limits")
    }
    for value in [-1, 1001] {
        check(estimatePageRegion(pageRegion(), context: alteredPage(["pointerAnchor", "ageMs"], value)) == nil, "stale or negative anchor age")
    }
    for value in ["invalid", iso(pageDate.addingTimeInterval(-3)), iso(pageDate.addingTimeInterval(3))] {
        check(estimatePageRegion(pageRegion(), context: alteredPage(["pointerAnchor", "observedAt"], value)) == nil,
              "malformed, stale and future anchor timestamps rejected")
    }
    for (path, value): ([String], Any) in [(["fullscreen"], true), (["window", "state"], "fullscreen"),
        (["visualViewport", "scale"], 1.01), (["visualViewport", "offsetLeft"], 0.1), (["visualViewport", "offsetTop"], -0.1),
        (["devicePixelRatio"], 2.52), (["pointerAnchor", "client", "x"], -0.1),
        (["pointerAnchor", "client", "y"], 321), (["pageWindow", "screenX"], 101.01),
        (["pageWindow", "outerWidth"], 901.01), (["url"], "chrome://settings/")] {
        check(estimatePageRegion(pageRegion(), context: alteredPage(path, value)) == nil, "unsupported or inconsistent mapping rejected")
    }
    check(estimatePageRegion(pageRegion(), context: alteredPage(["devicePixelRatio"], 2.509)) != nil, "small DPR float tolerance")
    check(estimatePageRegion(pageRegion(), context: alteredPage(["pageWindow", "screenX"], 101)) != nil, "one-point window rounding accepted")
    check(estimatePageRegion(pageRegion(), context: alteredPage(["pointerAnchor", "screen", "x"], 224.5)) != nil,
          "fractional viewport edge may round within one point of browser bounds")
    check(estimatePageRegion(pageRegion(), context: alteredPage(["pointerAnchor", "screen", "x"], 223.9)) == nil,
          "viewport beyond browser rounding tolerance rejected")
    var outsideDisplay = alteredPage(["window", "left"], -200)
    outsideDisplay.browser = replacing(outsideDisplay.browser!, ["pageWindow", "screenX"], -200)
    outsideDisplay.browser = replacing(outsideDisplay.browser!, ["pointerAnchor", "screen", "x"], 124.5)
    check(estimatePageRegion(pageRegion(), context: outsideDisplay) == nil, "whole viewport must be inside observed display")
    for crop in [CGRect(x: 139.9, y: 320, width: 200, height: 100), CGRect(x: 900, y: 320, width: 200, height: 100),
                 CGRect(x: 340, y: 200, width: 200, height: 100), CGRect(x: 340, y: 320, width: 0, height: 100)] {
        check(estimatePageRegion(pageRegion(crop), context: pageContext()) == nil, "browser chrome, partial viewport and zero-area crops rejected")
    }
    var invalidated = pageContext()
    invalidated.geometryInvalidated = true
    check(estimatePageRegion(pageRegion(), context: invalidated) == nil, "geometry invalidation overrides otherwise valid browser data")
    var negativePage = pageContext()
    for (path, value): ([String], Double) in [(["window", "left"], -1820), (["window", "top"], -100),
        (["pageWindow", "screenX"], -1820), (["pageWindow", "screenY"], -100),
        (["pointerAnchor", "screen", "x"], -1655), (["pointerAnchor", "screen", "y"], 82.5), (["devicePixelRatio"], 1.25)] {
        negativePage.browser = replacing(negativePage.browser!, path, value)
    }
    let negativeDisplay = RegionDisplay(id: 9, bounds: CGRect(x: -1920, y: -200, width: 1440, height: 900), scale: 1)
    let negativeEstimate = estimatePageRegion(pageRegion(CGRect(x: -1580, y: 120, width: 200, height: 100), display: negativeDisplay),
                                              context: negativePage)
    check(negativeEstimate?.viewportRect == CGRect(x: 160, y: 80, width: 160, height: 80), "negative-origin secondary display mapping")
    // Independently paired Chrome pointer/DOM and AX target measurements from this Mac.
    let realDisplay = RegionDisplay(id: 1, bounds: CGRect(x: 0, y: 0, width: 1470, height: 956), scale: 2)
    for (zoom, dpr, client, size, target, cssTarget): (CGFloat, CGFloat, CGPoint, CGSize, CGRect, CGRect) in [
        (0.9, 1.7999999523162842, CGPoint(x: 445.97222900390625, y: 249.8611297607422), CGSize(width: 1633, height: 748),
         CGRect(x: 36, y: 294, width: 360, height: 180), CGRect(x: 40, y: 131.0069580078125, width: 400.0000305175781, height: 200.00001525878906)),
        (1.25, 2.5, CGPoint(x: 321.1000061035156, y: 179.90000915527344), CGSize(width: 1176, height: 538),
         CGRect(x: 50, y: 339, width: 500, height: 251), CGRect(x: 40, y: 130.6374969482422, width: 400, height: 200))
    ] {
        var observed = pageContext(zoom: zoom)
        observed.browser?["devicePixelRatio"] = dpr
        observed.browser?["viewport"] = ["width": size.width, "height": size.height]
        observed.browser?["scroll"] = ["x": 0, "y": 0]
        observed.browser?["window"] = ["focused": true, "state": "normal", "left": 0, "top": 33, "width": 1470, "height": 816]
        observed.browser?["pageWindow"] = ["screenX": 0, "screenY": 33, "outerWidth": 1470, "outerHeight": 816]
        observed.browser?["pointerAnchor"] = ["screen": ["x": 401.375, "y": 400.875],
                                              "client": ["x": client.x, "y": client.y], "ageMs": 50, "observedAt": iso(pageDate)]
        let estimate = estimatePageRegion(pageRegion(target, display: realDisplay), context: observed)
        check(estimate != nil, "real 90/125 percent samples accept Float32 display-edge drift")
        check(abs(estimate!.origin.x) < 0.001 && abs(estimate!.origin.y - 176) < 0.001, "real measured content origin retained without rounding")
        check(abs(estimate!.viewportRect.minX - cssTarget.minX) <= 1 && abs(estimate!.viewportRect.minY - cssTarget.minY) <= 1
              && abs(estimate!.viewportRect.width - cssTarget.width) <= 1 && abs(estimate!.viewportRect.height - cssTarget.height) <= 1,
              "real AX target maps within one CSS pixel including AX integer rounding")
    }
    for edge in 0..<4 {
        for overflow: CGFloat in [0.0009, 0.0011] {
            var boundary = CGRect(x: 140, y: 220, width: 800, height: 400)
            switch edge {
            case 0: boundary.origin.x += overflow; boundary.size.width -= overflow
            case 1: boundary.size.width -= overflow
            case 2: boundary.origin.y += overflow; boundary.size.height -= overflow
            default: boundary.size.height -= overflow
            }
            let tightDisplay = RegionDisplay(id: 1, bounds: boundary, scale: 2)
            check((estimatePageRegion(pageRegion(display: tightDisplay), context: pageContext()) != nil) == (overflow < 0.001),
                  "display edge accepts only sub-0.001-point overflow on every side")
            var crop = CGRect(x: 140, y: 220, width: 800, height: 400)
            switch edge {
            case 0: crop.origin.x -= overflow; crop.size.width += overflow
            case 1: crop.size.width += overflow
            case 2: crop.origin.y -= overflow; crop.size.height += overflow
            default: crop.size.height += overflow
            }
            check((estimatePageRegion(pageRegion(crop), context: pageContext()) != nil) == (overflow < 0.001),
                  "crop edge accepts only sub-0.001-point overflow on every side")
        }
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
                        "pointerAnchor": ["screen": ["x": 10, "y": 10]],
                        "pageWindow": ["outerWidth": 1200], "fullscreen": false,
                        "window": ["focused": true, "left": -1200, "top": 40, "width": 1200, "height": 800]])
        let partial = bridge.markdown(bridge.original!)
        assert(partial.contains(quoted(url)) && partial.contains("Observed tab") && partial.contains("-1200"))
        assert(partial.contains("Page measurements: unavailable") && !partial.contains("Viewport (CSS px)"))
        assert(partial.contains("Screenshot source and crop origin: unknown"))
        assert(bridge.browser?["pointerAnchor"] == nil && bridge.browser?["pageWindow"] == nil && bridge.browser?["fullscreen"] == nil)
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
                        end: CGPoint = CGPoint(x: -76, y: -17),
                        beforeMouseDown: ((String) -> Void)? = nil,
                        beforeMouseUp: (() -> Void)? = nil) -> String {
        bridge.setEnabled(false); app = "com.google.Chrome"; bridge.setEnabled(true)
        now += 10
        bridge.observeGesture(type: .keyDown, flags: [.maskControl, .maskShift, .maskCommand], keycode: 21)
        assert(bridge.gesture.isArmed && bridge.gestureContext?.app == app)
        let id = requested
        if replyBeforeEnd { bridge.receive(selectionReply(id)) }
        beforeMouseDown?(id)
        bridge.observeGesture(type: .flagsChanged, flags: [])
        bridge.observeGesture(type: .leftMouseDown, flags: [], location: start)
        bridge.observeGesture(type: .leftMouseDragged, flags: [], location: CGPoint(x: -78.25, y: -18.75))
        beforeMouseUp?()
        now += 0.2
        bridge.observeGesture(type: .leftMouseUp, flags: [], location: end)
        return id
    }
    func selectionReply(_ id: String, url: String = "https://example.com/source-a") -> [String: Any] {
        ["type": "browser-context", "requestId": id, "available": true, "url": url,
         "observedAt": iso(Date()), "window": ["focused": true]]
    }
    func pageReply(_ id: String) -> [String: Any] {
        var reply = selectionReply(id)
        reply["pageAvailable"] = true; reply["fullscreen"] = false
        reply["zoom"] = 1; reply["devicePixelRatio"] = 1
        reply["viewport"] = ["width": 400, "height": 300]
        reply["scroll"] = ["x": 11, "y": 100]
        reply["visualViewport"] = ["scale": 1, "offsetLeft": 0, "offsetTop": 0]
        reply["window"] = ["focused": true, "state": "normal", "left": -90, "top": -40, "width": 450, "height": 350]
        reply["pageWindow"] = ["screenX": -90, "screenY": -40, "outerWidth": 450, "outerHeight": 350]
        reply["pointerAnchor"] = ["screen": ["x": -70, "y": -15], "client": ["x": 20, "y": 10],
                                  "ageMs": 50, "observedAt": iso(bridge.gestureContext!.date.addingTimeInterval(-0.05))]
        return reply
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
    assert(selectionMD.contains("Configured macOS region-to-clipboard shortcut") && !selectionMD.contains("Control + Shift + Command + 4"))
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

    let invalidate: [String: Any] = ["type": "browser-geometry-invalidated"]
    for stage in ["before-reply", "after-reply", "during-drag", "after-mouse-up", "after-match-before-file", "after-file-write"] {
        let invalidBeforeCapture = ["before-reply", "after-reply", "during-drag", "after-mouse-up"].contains(stage)
        _ = startSelection(beforeMouseDown: { id in
            if stage == "before-reply" { bridge.receive(invalidate) }
            var reply = pageReply(id)
            reply["geometryInvalidated"] = false // Reply data cannot erase an independent invalidation.
            bridge.receive(reply)
            if stage == "after-reply" { bridge.receive(invalidate) }
        }, beforeMouseUp: {
            if stage == "during-drag" { bridge.receive(invalidate) }
        })
        if stage == "after-mouse-up" { bridge.receive(invalidate) }
        putImage(); bridge.tick()
        if stage == "after-match-before-file" {
            let snapshot = bridge.markdown(bridge.original!)
            assert(bridge.files == nil && bridge.regionContext?.geometryInvalidated == false)
            bridge.receive(invalidate)
            assert(bridge.markdown(bridge.original!) == snapshot, "A completed pending capture is already frozen")
        }
        app = "com.openai.codex"; bridge.tick()
        let paths = bridge.files!, before = board.changeCount, beforeMD = try Data(contentsOf: bridge.files![1])
        if stage == "after-file-write" { bridge.receive(invalidate) }
        let afterMD = try Data(contentsOf: paths[1]), md = String(decoding: afterMD, as: UTF8.self)
        assert(afterMD == beforeMD && board.changeCount == before, "Post-capture geometry must not rewrite files or clipboard")
        assert(bridge.region != nil && bridge.regionContext?.geometryInvalidated == invalidBeforeCapture)
        if invalidBeforeCapture { assert(!md.contains("Estimated selection") && md.contains("browser geometry changed"), stage) }
        else {
            assert(md.contains("Estimated selection in viewport CSS pixels: x=10.0, y=5.0, width=4.0, height=3.0"), stage)
            assert(md.contains("Estimated selection in top-document CSS pixels: x=21.0, y=105.0, width=4.0, height=3.0"), stage)
        }
        assert(bridge.regionContext?.browser?["pointerAnchor"] != nil && md.contains("Observed raw drag extent") && md.contains("source-a"))
        let preservedImage = try Data(contentsOf: paths[0]); assert(preservedImage == png)
        bridge.receive(invalidate)
        let repeatedMD = try Data(contentsOf: paths[1])
        assert(repeatedMD == beforeMD, "Repeated later changes cannot mutate the captured snapshot")
    }
    // A new gesture has its own invalidation flag, even without toggling the product.
    let completedPath = bridge.files![1], completedMD = try Data(contentsOf: bridge.files![1])
    app = "com.google.Chrome"; bridge.tick(); now += 10
    bridge.observeGesture(type: .keyDown, flags: [.maskControl, .maskShift, .maskCommand], keycode: 21)
    assert(bridge.gesture.isArmed && bridge.gestureContext?.geometryInvalidated == false)
    bridge.receive(pageReply(requested))
    assert(bridge.gestureContext?.browser?["pointerAnchor"] != nil && bridge.gestureContext?.geometryInvalidated == false)
    bridge.receive(invalidate)
    assert(bridge.gestureContext?.geometryInvalidated == true && bridge.regionContext?.geometryInvalidated == false)
    let previousCaptureMD = try Data(contentsOf: completedPath)
    assert(previousCaptureMD == completedMD, "A new pending gesture cannot invalidate the previous completed capture")
    bridge.cancelGesture()
    _ = startSelection(beforeMouseDown: { bridge.receive(pageReply($0)) })
    putImage(); app = "com.openai.codex"; bridge.tick()
    let offMDPath = bridge.files![1], offMD = try Data(contentsOf: bridge.files![1])
    bridge.setEnabled(false)
    let offClipboardCount = board.changeCount
    bridge.receive(invalidate)
    let afterOffMD = try Data(contentsOf: offMDPath)
    assert(afterOffMD == offMD && board.changeCount == offClipboardCount, "OFF ignores geometry notifications")
    var afterImageReply: [String: Any] = [:]
    _ = startSelection(beforeMouseDown: { afterImageReply = pageReply($0) })
    putImage(); app = "com.openai.codex"; bridge.tick()
    bridge.receive(afterImageReply)
    assert(bridge.region != nil && bridge.regionContext?.browser == nil)
    assert(!bridge.markdown(bridge.original!).contains("Estimated selection"), "Post-image browser context cannot supply CSS coordinates")
    bridge.setEnabled(false)
    func blockPreparedRewrite() throws -> [URL] {
        let paths = bridge.files!
        try FileManager.default.moveItem(at: paths[1], to: paths[1].appendingPathExtension("saved"))
        try FileManager.default.createDirectory(at: paths[1], withIntermediateDirectories: false)
        return paths
    }
    bridge.setEnabled(false); app = "com.google.Chrome"; bridge.setEnabled(true); putImage(); bridge.tick()
    let lateRewriteID = requested
    app = "com.openai.codex"; bridge.tick()
    let staleLatePaths = try blockPreparedRewrite()
    bridge.receive(selectionReply(lateRewriteID, url: "https://example.com/late-corrected"))
    assert(bridge.ownsClipboard() && bridge.files != staleLatePaths, "Late browser updates share the same failure recovery")
    let correctedLateMD = try String(contentsOf: bridge.files![1], encoding: .utf8)
    assert(correctedLateMD.contains("late-corrected"))
    bridge.setEnabled(false)
    print("PASS: page CSS estimates, reply/invalidation races, failed-rewrite withdrawal, raw observation preservation, and OFF/new-gesture isolation.")

    // Public pasteboard generations can temporarily advance for a remote overlay, then return.
    // Real private boards hold the representations; only their otherwise non-rewindable counter is injected.
    var displayedCount: Int?
    let stableEpoch = PasteboardEpoch(pid: 42, seconds: 100, microseconds: 1)
    var epoch: PasteboardEpoch? = stableEpoch
    bridge.clipboardCount = { displayedCount ?? board.changeCount }
    bridge.pasteboardEpoch = { epoch }
    func replaceItems(_ values: [[NSPasteboard.PasteboardType: Data]]) {
        board.clearContents()
        let entries = values.map { data -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, value) in data { item.setData(value, forType: type) }
            return item
        }
        assert(board.writeObjects(entries))
    }
    let rollbackCases = ["raw", "owned", "owned-away", "empty-overlay", "deferred-overlay", "newer-equal",
        "changed-bytes", "changed-types", "epoch", "epoch-race", "count-race", "epoch-unavailable", "off", "expired",
        "invalidate", "invalidate-owned", "mutable-file", "returned-delayed", "returned-delayed-empty", "returned-delayed-timeout"]
    for test in rollbackCases {
        displayedCount = nil; epoch = stableEpoch; bridge.pasteboardEpoch = { epoch }
        _ = startSelection(beforeMouseDown: { bridge.receive(pageReply($0)) })
        if test == "mutable-file" {
            let imageFile = directory.appendingPathComponent("mutable-source.png")
            try png.write(to: imageFile)
            let item = NSPasteboardItem(); item.setString(imageFile.absoluteString, forType: .fileURL)
            board.clearContents(); assert(board.writeObjects([item]))
        } else { putImage() }
        bridge.tick(); app = "com.openai.codex"; bridge.tick()
        assert(bridge.region != nil && bridge.captureItems != nil)
        let originalFiles = bridge.files!, originalDate = bridge.observedAt, captureID = bridge.regionContext!.id
        let originalMD = try Data(contentsOf: originalFiles[1])
        let keepOwned = ["owned", "owned-away", "invalidate-owned"].contains(test)
        if !keepOwned { app = "com.google.Chrome"; bridge.tick() }
        let generation = bridge.seen, oldItems = completePasteboardItems(board)!
        if test == "empty-overlay" || test == "returned-delayed-empty" { board.clearContents() }
        else if test == "deferred-overlay" { board.declareTypes([.png], owner: nil) }
        else { board.clearContents(); board.setString("remote overlay", forType: .string) }
        bridge.tick()
        if test == "mutable-file" { assert(bridge.suspended == nil); continue }
        assert(bridge.suspended?.generation == generation && bridge.original == nil, test)
        if test.hasPrefix("invalidate") {
            bridge.receive(invalidate)
            assert(bridge.suspended?.context.geometryInvalidated == false)
            let suspendedMD = try Data(contentsOf: originalFiles[1])
            assert(suspendedMD == originalMD, "Suspended raw/pair snapshots stay byte-for-byte stable")
        }
        if test == "off" { bridge.setEnabled(false); assert(bridge.suspended == nil) }
        if test == "expired" { now += 601 }
        if test == "epoch" { epoch = PasteboardEpoch(pid: 42, seconds: 101, microseconds: 1) }
        if test == "epoch-unavailable" { epoch = nil }
        var returned = oldItems
        if test == "changed-bytes" { returned[0][.png] = Data("different image data".utf8) }
        if test == "changed-types" { returned[0][.string] = Data("additional user data".utf8) }
        if test.hasPrefix("returned-delayed") {
            board.declareTypes([.png], owner: nil); displayedCount = generation
            bridge.tick()
            assert(bridge.recoveryPending && bridge.suspended?.context.id == captureID)
            now += test == "returned-delayed-timeout" ? 2.1 : 0.2
            if test != "returned-delayed-timeout" { assert(board.setData(png, forType: .png)) }
        } else { replaceItems(returned) }
        displayedCount = test == "newer-equal" ? bridge.observedGeneration + 1 : generation
        var epochReads = 0
        if test == "epoch-race" || test == "count-race" {
            bridge.pasteboardEpoch = {
                epochReads += 1
                if epochReads == 2 {
                    if test == "count-race" { displayedCount = generation + 1 }
                    else { return PasteboardEpoch(pid: 43, seconds: 100, microseconds: 1) }
                }
                return stableEpoch
            }
        }
        app = test == "owned-away" ? "com.google.Chrome" : "com.openai.codex"
        bridge.tick()
        let rejected = ["newer-equal", "changed-bytes", "changed-types", "epoch", "epoch-race", "count-race", "epoch-unavailable", "off", "expired", "returned-delayed-timeout"].contains(test)
        if rejected { assert(bridge.region == nil && bridge.regionContext == nil, test) }
        else {
            assert(bridge.regionContext?.id == captureID && bridge.observedAt == originalDate, test)
            assert(bridge.region?.globalRect == CGRect(x: -80, y: -20, width: 4, height: 3), test)
            let recoveredMD = try String(contentsOf: bridge.files![1], encoding: .utf8)
            assert(recoveredMD.contains("Estimated selection in viewport CSS pixels"), test)
            assert(bridge.files == originalFiles && Data(recoveredMD.utf8) == originalMD, test)
            if test == "owned-away" { assert(bridge.owned == nil && board.data(forType: .png) == png) }
        }
    }
    displayedCount = nil; bridge.clipboardCount = { board.changeCount }; bridge.pasteboardEpoch = { stableEpoch }
    _ = startSelection(beforeMouseDown: { bridge.receive(pageReply($0)) })
    putImage(); app = "com.openai.codex"; bridge.tick()
    board.clearContents(); board.setString("new confidential owner", forType: .string)
    bridge.restore()
    assert(bridge.captureItems == nil && bridge.captureEpoch == nil && board.string(forType: .string) == "new confidential owner")

    for correlated in [false, true] {
        if correlated { _ = startSelection(beforeMouseDown: { bridge.receive(pageReply($0)) }) }
        else { bridge.setEnabled(false); app = "com.google.Chrome"; bridge.setEnabled(true) }
        board.declareTypes([.png], owner: nil)
        let emptyCount = board.changeCount
        bridge.tick()
        assert(bridge.seen != emptyCount && bridge.original == nil && bridge.deferredImage != nil)
        now += 0.2
        assert(board.setData(png, forType: .png) && board.changeCount == emptyCount)
        bridge.tick()
        assert(bridge.original?.png == png && (bridge.region != nil) == correlated)
    }
    bridge.setEnabled(false); app = "com.google.Chrome"; bridge.setEnabled(true)
    board.declareTypes([.png], owner: nil); bridge.tick(); let pendingCount = board.changeCount
    now += 2.1; bridge.tick()
    assert(bridge.seen == pendingCount && bridge.deferredImage == nil && bridge.original == nil)
    board.setData(png, forType: .png); bridge.tick()
    assert(bridge.original == nil, "Expired missing-data retries must not poll forever")
    bridge.setEnabled(false); app = "com.google.Chrome"; bridge.setEnabled(true)
    board.declareTypes([.png], owner: nil); bridge.tick()
    let deniedDeadline = bridge.deferredImage!.deadline, deniedCount = board.changeCount
    let deniedMonitor = RegionInputMonitor(bridge: bridge, preflight: { false }, readShortcut: { .standard }, statusChanged: { _ in })
    now += 1; deniedMonitor.update(); bridge.tick()
    assert(bridge.deferredImage?.deadline == deniedDeadline, "Permission polling must not renew a missing-image deadline")
    now += 1.1; deniedMonitor.update(); bridge.tick()
    assert(bridge.seen == deniedCount && bridge.deferredImage == nil && bridge.original == nil)
    bridge.setEnabled(false)
    final class UnreadImageProvider: NSObject, NSPasteboardItemDataProvider {
        var reads = 0
        func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType) {
            reads += 1
        }
    }
    for type in [marker, NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"), NSPasteboard.PasteboardType("org.nspasteboard.TransientType")] {
        app = "com.google.Chrome"; bridge.setEnabled(true)
        let provider = UnreadImageProvider(), item = NSPasteboardItem()
        item.setDataProvider(provider, forTypes: [.png]); item.setString("private", forType: type)
        board.clearContents(); assert(board.writeObjects([item])); bridge.tick()
        assert(provider.reads == 0 && bridge.deferredImage == nil)
        assert(completePasteboardItems(board, expected: [[.png: png]]) == nil && provider.reads == 0)
        if type != marker { assert(completePasteboardItems(board) == nil && provider.reads == 0) }
        bridge.setEnabled(false)
    }
    _ = startSelection(beforeMouseDown: { bridge.receive(pageReply($0)) })
    putImage(); bridge.tick(); let earlierCaptureID = bridge.regionContext!.id
    board.clearContents(); board.setString("remote overlay", forType: .string); bridge.tick()
    assert(bridge.suspended != nil)
    now += 10
    bridge.observeGesture(type: .keyDown, flags: [.maskControl, .maskShift, .maskCommand], keycode: 21)
    bridge.receive(pageReply(requested))
    bridge.observeGesture(type: .flagsChanged, flags: [])
    bridge.observeGesture(type: .leftMouseDown, flags: [], location: CGPoint(x: -80, y: -20))
    now += 0.2
    bridge.observeGesture(type: .leftMouseUp, flags: [], location: CGPoint(x: -76, y: -17))
    putImage(); bridge.tick()
    assert(bridge.suspended == nil && bridge.regionContext?.id != earlierCaptureID && bridge.region != nil)
    bridge.setEnabled(false)
    bridge.pasteboardEpoch = currentPasteboardEpoch
    print("PASS: 20 private-board rollback cases, exact generation/representations/epoch, frozen capture snapshots, ownership, and bounded deferred image data.")

    var permissionRequests = 0, inputStates: [String] = []
    let monitor = RegionInputMonitor(bridge: bridge, preflight: { false },
        requestPermission: { permissionRequests += 1; return false }, readShortcut: { .standard },
        statusChanged: { inputStates.append($0) })
    monitor.update(); monitor.requestAccess()
    assert(permissionRequests == 0 && monitor.status == "off")
    bridge.setEnabled(true); monitor.update(); monitor.poll()
    assert(permissionRequests == 0 && monitor.tap == nil && monitor.status == "permission-required")
    monitor.requestAccess()
    assert(permissionRequests == 1 && monitor.tap == nil)
    bridge.setEnabled(false); monitor.update()
    assert(inputStates == ["off", "permission-required", "off"])
    var configuredShortcut: RegionShortcut? = RegionShortcut(keycode: 21, flags: .maskControl)
    let configuredMonitor = RegionInputMonitor(bridge: bridge, preflight: { false },
        readShortcut: { configuredShortcut }, statusChanged: { _ in })
    assert(bridge.gesture.shortcut == configuredShortcut, "Initial configuration must load before enabling")
    var geometryReads = 0
    let savedDisplays = bridge.displays
    bridge.displays = { geometryReads += 1; return savedDisplays() }
    bridge.setEnabled(true); app = "com.google.Chrome"
    // Construct local events for the callback only; never post input or open a tap.
    let keyEvent = CGEvent(keyboardEventSource: nil, virtualKey: 21, keyDown: true)!
    keyEvent.flags = [.maskControl, .maskShift, .maskCommand]
    configuredMonitor.handle(.keyDown, keyEvent)
    assert(geometryReads == 0 && !bridge.gesture.isArmed, "Old chord must be filtered before geometry/context reads")
    keyEvent.flags = .maskControl
    configuredMonitor.handle(.keyDown, keyEvent)
    assert(geometryReads == 1 && bridge.gesture.isArmed && bridge.gestureContext != nil)
    let previousContext = bridge.gestureContext!.id
    bridge.setRegionShortcut(configuredShortcut)
    assert(bridge.gestureContext?.id == previousContext, "Unchanged preference must retain context")
    configuredShortcut = RegionShortcut(keycode: 1, flags: [.maskAlternate, .maskCommand])
    bridge.setRegionShortcut(configuredShortcut)
    assert(!bridge.gesture.isArmed && bridge.gestureContext == nil, "A changed shortcut must drop its pending context")
    bridge.receive(selectionReply(previousContext))
    assert(bridge.browser == nil, "An old shortcut reply must not become browser context")
    keyEvent.setIntegerValueField(.keyboardEventKeycode, value: 1)
    keyEvent.flags = [.maskAlternate, .maskCommand]
    configuredMonitor.handle(.keyDown, keyEvent)
    assert(bridge.gesture.isArmed && bridge.gestureContext?.id != previousContext, "Custom key passes the shared monitor filter")
    configuredShortcut = nil
    configuredMonitor.poll()
    assert(bridge.gesture.shortcut == nil && !bridge.gesture.isArmed && bridge.gestureContext == nil,
           "Preference refresh must drop disabled selection/context without a callback read")
    let readsBeforeDisabledKey = geometryReads
    configuredMonitor.handle(.keyDown, keyEvent)
    assert(geometryReads == readsBeforeDisabledKey, "Disabled shortcut cannot retain keyboard context")
    bridge.setEnabled(false); configuredMonitor.update(); bridge.displays = savedDisplays
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
func shutdown() { inputMonitor.stop(); bridge.suspended = nil; bridge.restore(); exit(0) }
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
