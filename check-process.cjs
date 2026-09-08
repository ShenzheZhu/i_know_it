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
for (const [before, after] of [
  ['preflight: { CGPreflightListenEventAccess() }', 'preflight: { false }'],
  [/^let support = .*$/m, 'let support = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)'],
  ['Bridge(board: .general, directory: support', 'Bridge(board: NSPasteboard(name: NSPasteboard.Name(CommandLine.arguments[3])), directory: support'],
  ['NSWorkspace.shared.frontmostApplication?.bundleIdentifier', '(try? String(contentsOfFile: CommandLine.arguments[4], encoding: .utf8))'],
  ['setEnabled(value); return', 'setEnabled(value); try? send(["type": "test-enabled", "enabled": value]); return'],
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
if ["image", "declared-image"].contains(operation) {
 let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 8, pixelsHigh: 6, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
 bitmap.bitmapData!.initialize(repeating: 127, count: bitmap.bytesPerRow * bitmap.pixelsHigh)
 let png = bitmap.representation(using: .png, properties: [:])!
 if operation == "declared-image" { board.declareTypes([.png], owner: nil) }
 else { board.clearContents() }
 // Both empty and advertised-but-unavailable images may fill without a new generation.
 Thread.sleep(forTimeInterval: 0.20)
 board.setData(png, forType: .png)
}
if operation == "text" { board.clearContents(); board.setString("new user copy", forType: .string) }
let entries = board.pasteboardItems ?? []
let state: [String: Any] = ["count": entries.count, "change": board.changeCount,
 "png": board.data(forType: .png)?.base64EncodedString() ?? "", "text": board.string(forType: .string) ?? "",
 "files": entries.compactMap { $0.string(forType: .fileURL) }]
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
(async () => {
  for (const mode of ['EOF', 'SIGTERM', 'SIGINT', 'malformed-frame', 'OFF', 'newer-copy', 'broken-pipe', 'second-owner', 'browser-internal-page', 'declared-image']) {
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
    const state = operation => JSON.parse(cp.execFileSync(probe, [name, operation || 'state'], { encoding: 'utf8' }));
    try {
      await until(() => messages.some(m => m.type === 'test-ready'), `${mode}: startup`);
      // Split the real message over several writes to exercise pipe framing.
      const enabled = frame({ type: 'enabled', enabled: true });
      for (const bytes of [enabled.subarray(0, 1), enabled.subarray(1, 3), enabled.subarray(3, 7), enabled.subarray(7)]) { child.stdin.write(bytes); await delay(10); }
      await until(() => messages.some(m => m.type === 'test-enabled' && m.enabled), `${mode}: enabled`);
      const originalPNG = state(mode === 'declared-image' ? 'declared-image' : 'image').png;
      assert(originalPNG);
      await until(() => messages.some(m => m.type === 'request-context'), `${mode}: browser request`);
      const requestId = messages.find(m => m.type === 'request-context').requestId;
      if (mode === 'broken-pipe') {
        child.stdout.destroy();
        state('text'); await delay(80); state('image');
        await until(() => ended, 'broken stdout exits');
        assert.equal(state().png, originalPNG);
      } else {
        const internal = mode === 'browser-internal-page';
        const url = internal ? 'chrome://extensions/' : 'https://example.invalid/process-fixture';
        child.stdin.write(frame({ type: 'browser-context', requestId, available: true, pageAvailable: !internal,
          ...(internal && { pageUnavailableReason: 'browser-internal-page' }),
          window: { focused: true, left: -1200, top: 40, width: 1200, height: 800 },
          url, title: internal ? 'Extensions' : 'Process fixture', observedAt: new Date().toISOString() }));
        fs.writeFileSync(app, 'com.openai.codex');
        await until(() => state().files.length === 2, `${mode}: image and Markdown prepared`);
        const files = state().files.map(url => new URL(url));
        assert.equal(fs.readFileSync(files[0]).toString('base64'), originalPNG);
        const markdown = fs.readFileSync(files[1], 'utf8');
        assert(markdown.includes(url));
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
    } finally {
      if (!ended) { child.kill('SIGTERM'); await until(() => ended, `${mode}: cleanup`); }
      cp.execFileSync(probe, [name, 'release']);
    }
  }
  const report = { checkedAt: new Date().toISOString(), cases: results, scope: 'Instrumented native executable; private pasteboards and scripted app state; no desktop UI or general clipboard' };
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
