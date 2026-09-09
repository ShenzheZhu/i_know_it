// Exercise the native process lifecycle with a private pasteboard and scripted app state.
// This does not control Codex, Chrome, or the system clipboard.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const output = process.env.IKI_RUN_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'i-know-it-process-'));
fs.mkdirSync(output, { recursive: true });
const original = fs.readFileSync(path.join(__dirname, 'native/main.swift'), 'utf8');
let source = original;
// This protocol exists only in the temporary test executable, never in the native host.
const gestureHarness = `
if value["type"] as? String == "test-gesture" {
    let phase = value["phase"] as! String
    if phase == "start" { bridge.observeGesture(type: .keyDown, flags: [.maskControl, .maskShift, .maskCommand], keycode: 21) }
    if phase == "end" {
        bridge.observeGesture(type: .flagsChanged, flags: [])
        bridge.observeGesture(type: .leftMouseDown, flags: [], location: CGPoint(x: -1100, y: 100))
        testClock += 0.2
        bridge.observeGesture(type: .leftMouseUp, flags: [], location: CGPoint(x: -1100 + (value["width"] as? Double ?? 8), y: 106))
    }
    if phase == "cancel" { bridge.observeGesture(type: .keyDown, flags: [], keycode: 53) }
    bridge.tick()
    try? send(["type": "test-gesture-done", "phase": phase, "serial": value["serial"] as! Int])
} else { bridge.receive(value) }
`;
for (const [before, after] of [
  ['preflight: { CGPreflightListenEventAccess() }', 'preflight: { false }, readShortcut: { .standard }'],
  [/^let support = .*$/m, 'let support = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)'],
  ['Bridge(board: .general, directory: support', 'Bridge(board: NSPasteboard(name: NSPasteboard.Name(CommandLine.arguments[3])), directory: support'],
  ['NSWorkspace.shared.frontmostApplication?.bundleIdentifier', '(try? String(contentsOfFile: CommandLine.arguments[4], encoding: .utf8))'],
  ['setEnabled(value); return', 'setEnabled(value); try? send(["type": "test-enabled", "enabled": value]); return'],
  ['let inputMonitor = RegionInputMonitor', 'var testClock: TimeInterval = 100\nbridge.clock = { testClock }\nbridge.displays = { [RegionDisplay(id: 1, bounds: CGRect(x: -1200, y: 0, width: 2400, height: 1000), scale: 1)] }\nlet inputMonitor = RegionInputMonitor'],
  ['else { bridge.receive(value) }', gestureHarness],
  ['bridge.tick(); inputMonitor.poll()', 'bridge.tick()'],
  [/^let observer = .*$/m, '// Test app state is supplied by a private fixture file.'],
  ['RunLoop.main.run()', 'try? send(["type": "test-ready"]); RunLoop.main.run()'],
]) {
  const changed = source.replace(before, after);
  assert.notEqual(changed, source, `Missing native fixture boundary: ${before}`);
  source = changed;
}
assert(!source.includes('board: .general'));
const host = path.join(output, 'host');
fs.writeFileSync(path.join(output, 'main.swift'), source);
cp.execFileSync('/usr/bin/xcrun', ['swiftc', path.join(output, 'main.swift'), '-o', host]);
const probeSource = `import AppKit
import Foundation
let board = NSPasteboard(name: NSPasteboard.Name(CommandLine.arguments[1]))
let operation = CommandLine.arguments[2]
if operation == "release" { board.releaseGlobally(); exit(0) }
if ["image", "declared-image", "file-image"].contains(operation) {
 let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 8, pixelsHigh: 6, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
 bitmap.bitmapData!.initialize(repeating: 127, count: bitmap.bytesPerRow * bitmap.pixelsHigh)
 let png = bitmap.representation(using: .png, properties: [:])!
 if operation == "declared-image" { board.declareTypes([.png], owner: nil) }
 else { board.clearContents() }
 // Both empty and advertised-but-unavailable images may fill without a new generation.
 Thread.sleep(forTimeInterval: 0.20)
 if operation == "file-image" {
  let file = URL(fileURLWithPath: CommandLine.arguments[3]); try png.write(to: file)
  let item = NSPasteboardItem(); item.setData(png, forType: .png); item.setString(file.absoluteString, forType: .fileURL)
  assert(board.writeObjects([item]))
 } else { board.setData(png, forType: .png) }
}
if operation == "text" { board.clearContents(); board.setString("new user copy", forType: .string) }
let entries = board.pasteboardItems ?? []
let state: [String: Any] = ["count": entries.count, "change": board.changeCount,
 "png": board.data(forType: .png)?.base64EncodedString() ?? "", "text": board.string(forType: .string) ?? "",
 "files": entries.compactMap { $0.string(forType: .fileURL) },
 "representations": entries.map { entry in Dictionary(uniqueKeysWithValues: entry.types.map { ($0.rawValue, entry.data(forType: $0)?.base64EncodedString() ?? "<unavailable>") }) }]
print(String(data: try JSONSerialization.data(withJSONObject: state), encoding: .utf8)!)
`;
const probe = path.join(output, 'probe');
fs.writeFileSync(path.join(output, 'probe.swift'), probeSource);
cp.execFileSync('/usr/bin/xcrun', ['swiftc', path.join(output, 'probe.swift'), '-o', probe]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  const end = Date.now() + 4000;
  while (Date.now() < end) { if (predicate()) return; await delay(30); }
  throw new Error(`Timed out: ${label}`);
}
function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}
const results = [];
const rejected = ['ordinary-Chrome-image', 'non-Chrome-image', 'non-Chrome-start', 'cancelled-gesture', 'mismatched-size', 'file-reference', 'missing-browser-reply', 'late-browser-reply', 'outside-Chrome-window'];
(async () => {
  for (const mode of ['EOF', 'SIGTERM', 'SIGINT', 'malformed-frame', 'OFF', 'newer-copy', 'broken-pipe', 'second-owner', 'browser-internal-page', 'declared-image', ...rejected]) {
    const name = `com.iknowit.process-test.${crypto.randomUUID()}`;
    const folder = path.join(output, mode); fs.mkdirSync(folder, { recursive: true });
    const app = path.join(folder, 'app'); fs.writeFileSync(app, 'com.google.Chrome');
    const args = ['chrome-extension://nfpnjhfbdogjiafeiioapfdnfaboehkh/', path.join(folder, 'support'), name, app];
    const child = cp.spawn(host, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = Buffer.alloc(0), ended = false, status, stderr = '';
    const messages = [];
    child.stdin.on('error', () => {});
    child.stderr.on('data', data => { stderr += data; });
    child.on('exit', (code, signal) => { ended = true; status = { code, signal }; });
    child.stdout.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const length = buffer.readUInt32LE(0);
        messages.push(JSON.parse(buffer.subarray(4, 4 + length).toString()));
        buffer = buffer.subarray(4 + length);
      }
    });
    const state = operation => JSON.parse(cp.execFileSync(probe, [name, operation || 'state', path.join(folder, 'source.png')], { encoding: 'utf8' }));
    let serial = 0;
    const gesture = async (phase, extra = {}) => {
      const id = ++serial;
      child.stdin.write(frame({ type: 'test-gesture', phase, serial: id, ...extra }));
      await until(() => messages.some(m => m.type === 'test-gesture-done' && m.serial === id), `${mode}: ${phase}`);
    };
    try {
      await until(() => messages.some(m => m.type === 'test-ready'), `${mode}: startup`);
      // Split the real message over several writes to exercise pipe framing.
      const enabled = frame({ type: 'enabled', enabled: true });
      for (const bytes of [enabled.subarray(0, 1), enabled.subarray(1, 3), enabled.subarray(3, 7), enabled.subarray(7)]) { child.stdin.write(bytes); await delay(10); }
      await until(() => messages.some(m => m.type === 'test-enabled' && m.enabled), `${mode}: enabled`);
      const nonChrome = mode === 'non-Chrome-image' || mode === 'non-Chrome-start';
      if (nonChrome) fs.writeFileSync(app, 'com.apple.TextEdit');
      const plainCopy = mode === 'ordinary-Chrome-image' || mode === 'non-Chrome-image';
      if (!plainCopy) await gesture('start');
      const requestId = messages.find(m => m.type === 'request-context')?.requestId;
      if (!plainCopy && !nonChrome) assert(requestId, `${mode}: shortcut-time browser request`);
      const internal = mode === 'browser-internal-page';
      const url = internal ? 'chrome://extensions/' : 'https://example.invalid/process-fixture';
      const reply = { type: 'browser-context', requestId, available: true, pageAvailable: !internal,
        ...(internal && { pageUnavailableReason: 'browser-internal-page' }),
        window: { focused: true, left: mode === 'outside-Chrome-window' ? 0 : -1200, top: 40, width: 1200, height: 800 },
        url, title: internal ? 'Extensions' : 'Process fixture', observedAt: new Date().toISOString() };
      if (requestId && !['missing-browser-reply', 'late-browser-reply'].includes(mode)) child.stdin.write(frame(reply));
      if (!plainCopy) await gesture(mode === 'cancelled-gesture' ? 'cancel' : 'end', { width: mode === 'mismatched-size' ? 20 : 8 });
      if (mode === 'non-Chrome-start') fs.writeFileSync(app, 'com.google.Chrome');
      const originalState = state(mode === 'declared-image' ? 'declared-image' : mode === 'file-reference' ? 'file-image' : 'image');
      const originalPNG = originalState.png;
      assert(originalPNG);
      if (rejected.includes(mode)) {
        if (mode === 'late-browser-reply') child.stdin.write(frame(reply));
        fs.writeFileSync(app, 'com.openai.codex'); await gesture('flush');
        assert.deepEqual(state(), originalState, `${mode}: count and all representations remain unchanged`);
        assert(!fs.existsSync(path.join(folder, 'support', 'captures')), `${mode}: no capture files`);
        child.stdin.end(); await until(() => ended, `${mode}: exit`);
        assert.deepEqual(state(), originalState, `${mode}: shutdown leaves the original copy unchanged`);
      } else if (mode === 'broken-pipe') {
        await gesture('flush');
        await new Promise(resolve => { child.stdout.once('close', resolve); child.stdout.destroy(); });
        child.stdin.write(frame({ type: 'test-gesture', phase: 'start', serial: ++serial }));
        await until(() => ended, 'broken stdout exits');
        assert.equal(state().png, originalPNG);
      } else {
        fs.writeFileSync(app, 'com.openai.codex');
        await until(() => state().files.length === 2, `${mode}: image and Markdown prepared`);
        const files = state().files.map(url => new URL(url));
        assert.equal(fs.readFileSync(files[0]).toString('base64'), originalPNG);
        const markdown = fs.readFileSync(files[1], 'utf8');
        assert(markdown.includes(url));
        assert(markdown.includes('Observed raw drag extent in global display points: x=-1100.0, y=100.0, width=8.0, height=6.0'));
        if (internal) {
          assert(markdown.includes('Extensions') && markdown.includes('-1200'));
          assert(markdown.includes('Page measurements: unavailable (browser-internal page)'));
          assert(!markdown.includes('Viewport (CSS px)') && markdown.includes('Screenshot source and crop origin: unknown'));
        }
        for (const file of files) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        if (mode === 'second-owner') {
          const second = cp.spawnSync(host, args, { timeout: 3000, input: '', encoding: 'utf8' });
          assert.ifError(second.error); assert.equal(second.status, 0); assert.equal(second.stdout, '');
          assert.equal(state().files.length, 2);
          child.stdin.end();
        } else if (mode === 'OFF') {
          child.stdin.write(frame({ type: 'enabled', enabled: false }));
          await until(() => messages.some(m => m.type === 'test-enabled' && !m.enabled), 'disabled acknowledgement');
          assert.equal(state().png, originalPNG); child.stdin.end();
        } else if (mode === 'newer-copy') { state('text'); child.kill('SIGTERM'); }
        else if (mode === 'EOF' || internal || mode === 'declared-image') child.stdin.end();
        else if (mode === 'malformed-frame') child.stdin.write(Buffer.from([0, 0, 0, 0]));
        else child.kill(mode);
        await until(() => ended, `${mode}: process exits`);
        if (mode === 'newer-copy') assert.equal(state().text, 'new user copy');
        else assert.equal(state().png, originalPNG, `${mode}: original PNG restored`);
      }
      assert.equal(status.code, 0, `${mode}: ${stderr}`);
      results.push({ case: mode, result: 'PASS' });
    } catch (error) {
      results.push({ case: mode, result: 'FAIL', error: String(error) });
      throw error;
    } finally {
      if (!ended) { child.kill('SIGTERM'); await until(() => ended, `${mode}: cleanup`); }
      cp.execFileSync(probe, [name, 'release']);
    }
  }
  const report = { checkedAt: new Date().toISOString(), cases: results, scope: 'Instrumented native executable; synthetic method calls, private pasteboards and scripted app state; no OS input, desktop UI or general clipboard' };
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
})().catch(error => {
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checkedAt: new Date().toISOString(), cases: results, error: String(error) }, null, 2) + '\n');
  console.error(error); process.exitCode = 1;
});
