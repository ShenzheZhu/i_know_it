// Read-only signing checks: use an existing signed host and its build receipt.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

assert.equal(process.platform, 'darwin', 'Package checks require macOS and Command Line Tools.');
assert.equal(process.argv.length, 4, 'Usage: node check-package.cjs SIGNED_HOST BUILD_RECEIPT');
const [host, receiptFile] = process.argv.slice(2).map(file => path.resolve(file));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const original = [hash(host), hash(receiptFile)];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'i-know-it-package-check-'));
const source = path.join(temp, 'source');
const passes = [];
function run(command, args, cwd = source) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
try {
  fs.mkdirSync(source);
  const files = new Set(run('/usr/bin/git', ['ls-files', '-z'], __dirname).split('\0').filter(Boolean));
  for (const name of ['Install.command', 'package.cjs', 'check-package.cjs']) files.add(name);
  for (const file of files) {
    const from = path.join(__dirname, file), to = path.join(source, file);
    assert(fs.lstatSync(from).isFile(), 'The test source must contain regular files.');
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    fs.chmodSync(to, fs.statSync(from).mode & 0o777);
  }
  run('/usr/bin/git', ['init', '-q']);
  run('/usr/bin/git', ['add', '.']);
  run('/usr/bin/git', ['-c', 'user.name=Package Check', '-c', 'user.email=package-check@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Disposable current-source fixture']);
  const output = path.join(temp, 'checked.zip');
  const invoke = (binary = host, receipt = receiptFile, zip = output) => spawnSync(process.execPath,
    [path.join(source, 'package.cjs'), binary, receipt, zip], { cwd: source, encoding: 'utf8' });
  const good = invoke();
  assert.equal(good.status, 0, good.stderr || good.stdout);
  const result = JSON.parse(good.stdout);
  assert.equal(result.sha256, hash(output));
  const unpacked = path.join(temp, 'unpacked');
  fs.mkdirSync(unpacked);
  run('/usr/bin/unzip', ['-q', output, '-d', unpacked]);
  const bundle = path.join(unpacked, 'i_know_it');
  const expected = [...files, 'native/prebuilt/i-know-it-host', 'native/prebuilt/build.json'].sort();
  const list = run('/usr/bin/unzip', ['-Z1', output]).trim().split('\n')
    .filter(name => !name.endsWith('/')).map(name => name.replace(/^i_know_it\//, '')).sort();
  assert.deepEqual(list, expected, 'The ZIP must contain only committed source and the two declared payload files.');
  for (const file of files) assert.equal(hash(path.join(bundle, file)), hash(path.join(source, file)), file);
  assert.equal(hash(path.join(bundle, 'native/prebuilt/i-know-it-host')), original[0]);
  for (const file of ['Install.command', 'install.sh', 'uninstall.sh', 'native/prebuilt/i-know-it-host']) {
    assert.equal(fs.statSync(path.join(bundle, file)).mode & 0o777, 0o755, `${file} executable mode`);
  }
  const build = JSON.parse(fs.readFileSync(path.join(bundle, 'native/prebuilt/build.json'), 'utf8'));
  assert.deepEqual(Object.keys(build).sort(), ['format', 'name', 'version', 'source_sha256', 'executable_sha256',
    'signing_identity', 'designated_requirement', 'compiler', 'architecture', 'minimum_macos'].sort());
  assert(!JSON.stringify(build).includes(os.homedir()), 'Public build metadata must omit local home paths.');
  assert.equal(build.architecture, result.architecture);
  assert.equal(build.minimum_macos, result.minimum_macos);
  passes.push('Exact committed source, unchanged real signature, platform metadata, public receipt, executable ZIP modes');
  function rejected(label, binary, receipt, pattern) {
    const zip = path.join(temp, `${passes.length}.zip`);
    const failed = invoke(binary, receipt, zip);
    assert.notEqual(failed.status, 0, label);
    assert.match(failed.stderr, pattern, label);
    assert(!fs.existsSync(zip), 'A failed check must not publish an archive.');
    passes.push(label);
  }
  const oldHash = hash(output);
  assert.notEqual(invoke().status, 0, 'Existing output must be rejected.');
  assert.equal(hash(output), oldHash);
  passes.push('No output overwrite');
  const changedReceipt = path.join(temp, 'receipt.json');
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  for (const [field, value, pattern] of [
    ['source_sha256', '0'.repeat(64), /different native source/],
    ['executable_sha256', '0'.repeat(64), /executable hash/],
    ['signing_identity', '0'.repeat(40), /actual signing certificate/],
    ['designated_requirement', 'identifier "another.host"', /default signing requirement/],
    ['architecture', receipt.architecture === 'arm64' ? 'x86_64' : 'arm64', /actual Mach-O architecture/],
  ]) {
    fs.writeFileSync(changedReceipt, JSON.stringify({ ...receipt, [field]: value }));
    rejected(`Reject wrong ${field}`, host, changedReceipt, pattern);
  }
  const changedHost = path.join(temp, 'changed-host');
  fs.copyFileSync(host, changedHost);
  const bytes = fs.readFileSync(changedHost);
  bytes[Math.floor(bytes.length / 2)] ^= 1;
  fs.writeFileSync(changedHost, bytes);
  fs.writeFileSync(changedReceipt, JSON.stringify({ ...receipt, executable_sha256: hash(changedHost) }));
  rejected('Reject invalid real signature even with matching declared hash', changedHost, changedReceipt, /codesign failed/);
  fs.writeFileSync(path.join(source, 'untracked-secret'), 'must never enter the archive');
  rejected('Reject untracked source files', host, receiptFile, /Commit the reviewed source tree/);
  fs.rmSync(path.join(source, 'untracked-secret'));
  fs.appendFileSync(path.join(source, 'manifest.json'), '\n');
  rejected('Reject modified tracked source', host, receiptFile, /Commit the reviewed source tree/);
  console.log(JSON.stringify({ status: 'PASS', checks: passes.length, passes,
    scope: 'Real signature and isolated ZIP checks only; no installation, Gatekeeper, notarization, or TCC acceptance.' }, null, 2));
} finally {
  assert.deepEqual([hash(host), hash(receiptFile)], original, 'The supplied helper and receipt must remain unchanged.');
  fs.rmSync(temp, { recursive: true, force: true });
}
