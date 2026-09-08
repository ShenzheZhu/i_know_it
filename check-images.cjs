// Real image decoding and clipboard conversion across screenshot sizes; private pasteboard only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const zlib = require('node:zlib');
const output = process.env.IKI_RUN_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'i-know-it-images-'));
fs.mkdirSync(output, { recursive: true });
const source = fs.readFileSync(path.join(__dirname, 'native/main.swift'), 'utf8');
const boundary = source.indexOf('\nfunc selfTest() throws {');
assert(boundary > 0);
const harness = `
let root = URL(fileURLWithPath: CommandLine.arguments[1])
let board = NSPasteboard(name: NSPasteboard.Name("com.iknowit.image-test." + UUID().uuidString))
defer { board.releaseGlobally() }
let sizes = [(1,1), (1,8192), (640,360), (1179,2556), (1920,1080), (2560,1440), (3840,2160), (5120,2880), (7680,4320)]
var results: [[String: Any]] = []
for (width, height) in sizes {
 try autoreleasepool {
  let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  bitmap.bitmapData!.initialize(repeating: 127, count: bitmap.bytesPerRow * height)
  let png = bitmap.representation(using: .png, properties: [:])!
  let bridge = Bridge(board: board, directory: root.appendingPathComponent("size-\\(width)-\\(height)"), currentApp: { "com.openai.codex" }, request: { _ in })
  bridge.setEnabled(true)
  board.clearContents(); board.setData(png, forType: .png)
  bridge.tick(); assert(bridge.ownsClipboard(), "Missing image at \\(width)x\\(height)")
  let saved = try Data(contentsOf: bridge.files![0])
  let md = try String(contentsOf: bridge.files![1], encoding: .utf8)
  assert(saved == png && md.contains("\\(width) × \\(height)"))
  bridge.setEnabled(false); assert(board.data(forType: .png) == png)
  results.append(["width":width,"height":height,"pngBytes":png.count,"result":"PASS"])
 }
}
// A valid 1-bit grayscale PNG exceeds 64M pixels without a large test allocation.
let oversized = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
let header = CGImageSourceCreateWithData(oversized as CFData, nil)!
let props = CGImageSourceCopyPropertiesAtIndex(header, 0, nil) as! [CFString: Any]
assert(props[kCGImagePropertyPixelWidth] as? Int == 8192 && props[kCGImagePropertyPixelHeight] as? Int == 8192)
board.clearContents(); board.setData(oversized, forType: .png)
let count = board.changeCount
assert(ClipboardImage(board) == nil && board.changeCount == count && board.data(forType: .png) == oversized)
results.append(["width":8192,"height":8192,"result":"PASS: oversized dimensions rejected unchanged before decoding pixels"])
print(String(data: try JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys]), encoding: .utf8)!)
`;
function chunk(type, data) {
  const content = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of content) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, content, checksum]);
}
const header = Buffer.alloc(13); header.writeUInt32BE(8192); header.writeUInt32BE(8192, 4); header[8] = 1;
const oversizedFile = path.join(output, 'oversized.png');
fs.writeFileSync(oversizedFile, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.alloc(1025 * 8192), { level: 1 })), chunk('IEND', Buffer.alloc(0))]));
const swift = path.join(output, 'main.swift');
fs.writeFileSync(swift, source.slice(0, boundary) + '\n' + harness);
const executable = path.join(output, 'check-images');
cp.execFileSync('/usr/bin/xcrun', ['swiftc', swift, '-o', executable]);
const report = JSON.parse(cp.execFileSync(executable, [path.join(output, 'artifacts'), oversizedFile], { encoding: 'utf8', timeout: 60000 }));
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
