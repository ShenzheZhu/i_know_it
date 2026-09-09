// Tests the generated artifacts with Codex CLI, not the desktop composer or system clipboard.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { chromium } = require('playwright');
const root = __dirname;
const output = process.env.IKI_RUN_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'i-know-it-agent-'));
fs.mkdirSync(output, { recursive: true });
const code = crypto.randomBytes(4).toString('hex').toUpperCase();
const source = fs.readFileSync(path.join(root, 'native/main.swift'), 'utf8');
const boundary = source.indexOf('\nfunc selfTest() throws {');
assert(boundary > 0, 'Native fixture boundary must exist');
// Compile the actual clipboard engine with a named-pasteboard test entrypoint.
const harness = `
let directory = URL(fileURLWithPath: CommandLine.arguments[1])
let board = NSPasteboard(name: NSPasteboard.Name("com.iknowit.agent-test." + UUID().uuidString))
defer { board.releaseGlobally() }
var app = "com.google.Chrome", requestID = ""
let bridge = Bridge(board: board, directory: directory, currentApp: { app }, request: { requestID = $0 })
var now: TimeInterval = 100
bridge.clock = { now }
bridge.displays = { [RegionDisplay(id: 1, bounds: CGRect(x: -1440, y: 0, width: 1440, height: 1000), scale: 2)] }
bridge.setEnabled(true)
let png = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
// Test-only direct method calls; no OS input or native screenshot is generated.
bridge.observeGesture(type: .keyDown, flags: [.maskControl, .maskShift, .maskCommand], keycode: 21)
assert(!requestID.isEmpty)
bridge.receive(["type":"browser-context", "requestId":requestID, "available":true,
    "url":"https://example.invalid/design-review", "title":"Design review fixture", "observedAt":iso(Date()),
    "window":["focused":true, "left":-1440, "top":30, "width":1200, "height":900],
    "viewport":["width":600,"height":400], "scroll":["x":0,"y":320], "zoom":1.25, "devicePixelRatio":2])
bridge.observeGesture(type: .flagsChanged, flags: [])
bridge.observeGesture(type: .leftMouseDown, flags: [], location: CGPoint(x: -1400, y: 100))
now += 0.2
bridge.observeGesture(type: .leftMouseUp, flags: [], location: CGPoint(x: -800, y: 500))
board.clearContents(); board.setData(png, forType: .png); bridge.tick()
app = "com.openai.codex"; bridge.tick()
assert(bridge.ownsClipboard())
let files = board.pasteboardItems!.compactMap { $0.string(forType: .fileURL) }.compactMap(URL.init(string:))
assert(files.count == 2)
let outputPNG = try Data(contentsOf: files[0]); assert(outputPNG == png)
let metadata = try String(contentsOf: files[1], encoding: .utf8)
assert(metadata.contains("1200 × 800") && metadata.contains("Screenshot source and crop origin: unknown") && metadata.contains("Observed screenshot selection"))
print(String(data: try JSONSerialization.data(withJSONObject: files.map { $0.path }), encoding: .utf8)!)
bridge.setEnabled(false); assert(board.data(forType: .png) == png)
`;
const swift = path.join(output, 'main.swift');
fs.writeFileSync(swift, source.slice(0, boundary) + '\n' + harness);
const executable = path.join(output, 'native-artifact-check');
cp.execFileSync('/usr/bin/xcrun', ['swiftc', swift, '-o', executable], { stdio: 'inherit' });
(async () => {
  const browser = await chromium.launch({ headless: true });
  const original = path.join(output, 'input.png');
  try {
    const page = await browser.newPage({ viewport: { width: 600, height: 400 }, deviceScaleFactor: 2 });
    await page.setContent(`<html><style>body{margin:0;background:#eef2ff;color:#172554;font:24px sans-serif;padding:48px;box-sizing:border-box}h1{font-size:26px}strong{font:54px monospace}</style><h1>Visual verification</h1><p>Read the code below:</p><strong>${code}</strong></html>`);
    await page.screenshot({ path: original });
  } finally { await browser.close(); }
  const files = JSON.parse(cp.execFileSync(executable, [path.join(output, 'artifacts'), original], { encoding: 'utf8' }));
  const schema = path.join(output, 'schema.json');
  fs.writeFileSync(schema, JSON.stringify({ type: 'object', properties: { visual_code: { type: 'string' }, observed_page_url: { type: 'string' }, image_width: { type: 'integer' }, image_height: { type: 'integer' }, crop_origin_known: { type: 'boolean' } }, required: ['visual_code', 'observed_page_url', 'image_width', 'image_height', 'crop_origin_known'], additionalProperties: false }));
  const prompt = `This is a read-only fixture acceptance check. Inspect the attached image to read its visible verification code. Read the local context file at ${JSON.stringify(files[1])}. Report the visual code, observed page URL, image pixel dimensions, and whether the original screenshot crop origin is known. Do not change files or browse the web.\n`;
  fs.writeFileSync(path.join(output, 'prompt.txt'), prompt);
  const answer = path.join(output, 'answer.json');
  const stdout = fs.openSync(path.join(output, 'codex.jsonl'), 'w');
  const stderr = fs.openSync(path.join(output, 'codex.stderr'), 'w');
  const cli = process.env.CODEX_BINARY || 'codex';
  const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '-C', output, '--output-schema', schema, '-o', answer, '-i', files[0], '-'];
  const result = cp.spawnSync(cli, args, { input: prompt, stdio: ['pipe', stdout, stderr], timeout: 120000 });
  fs.closeSync(stdout); fs.closeSync(stderr);
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Codex CLI failed; inspect ${path.join(output, 'codex.stderr')}`);
  const actual = JSON.parse(fs.readFileSync(answer, 'utf8'));
  assert.deepEqual(actual, { visual_code: code, observed_page_url: 'https://example.invalid/design-review', image_width: 1200, image_height: 800, crop_origin_known: false });
  const report = { checkedAt: new Date().toISOString(), checks: ['Actual native engine generates byte-identical PNG and Markdown on a private pasteboard', 'Retina dimensions remain 1200 x 800', 'OFF restores the PNG', 'Codex CLI reads visual code and generated context correctly'], nativeDesktopPaste: 'NOT TESTED: no Codex desktop UI was operated', output };
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
