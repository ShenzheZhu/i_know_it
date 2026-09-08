const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

assert.equal(process.platform, 'darwin', 'Installer checks require macOS and Command Line Tools');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i-know-it-install-'));
const hostName = 'com.iknowit.bridge';
const originalSwift = fs.readFileSync(path.join(__dirname, 'native/main.swift'));
const key = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'))).key;
const expectedID = [...crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)]
  .map(char => String.fromCharCode(97 + parseInt(char, 16))).join('');
const passes = [];
function fixture(name) {
  const folder = path.join(root, name);
  const support = path.join(folder, 'Application Support');
  const source = path.join(folder, 'source');
  fs.mkdirSync(path.join(source, 'native'), { recursive: true });
  fs.writeFileSync(path.join(source, 'native/main.swift'), originalSwift);
  for (const script of ['install.sh', 'uninstall.sh']) {
    const content = fs.readFileSync(path.join(__dirname, script), 'utf8');
    const prefix = '$HOME/Library/Application Support';
    assert(content.includes(prefix), `${script} must retain the known installation prefix`);
    fs.writeFileSync(path.join(source, script), content.replaceAll(prefix, support.replace(/[\\$"`]/g, '\\$&')));
  }
  const app = path.join(support, 'I Know It');
  const host = path.join(app, 'i-know-it-host');
  const dirs = ['Chrome', 'ChromeForTesting'].map(browser => path.join(support, 'Google', browser, 'NativeMessagingHosts'));
  return { folder, support, source, app, host, receipt: path.join(app, 'install-receipt.json'), dirs, manifests: dirs.map(dir => path.join(dir, `${hostName}.json`)) };
}
function run(test, script, args = [], succeeds = true) {
  const result = spawnSync('/bin/bash', [path.join(test.source, script), ...args], {
    cwd: test.source, encoding: 'utf8', timeout: 120_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `${script} terminated: ${result.signal}`);
  if (succeeds) assert.equal(result.status, 0, result.stderr || result.stdout);
  else assert.notEqual(result.status, 0, `${script} unexpectedly succeeded`);
  return result;
}
function snapshot(files) {
  return files.map(file => ({ bytes: fs.readFileSync(file), mtime: fs.statSync(file).mtimeMs }));
}
function unchanged(files, before) {
  files.forEach((file, index) => {
    assert.deepEqual(fs.readFileSync(file), before[index].bytes, `${file} changed bytes`);
    assert.equal(fs.statSync(file).mtimeMs, before[index].mtime, `${file} changed modification time`);
  });
}
function verifyInstalled(test, id) {
  assert.equal(fs.statSync(test.app).mode & 0o777, 0o700);
  assert.equal(fs.statSync(test.host).mode & 0o777, 0o755);
  assert(fs.statSync(test.host).size > 0);
  assert.equal(fs.statSync(test.receipt).mode & 0o777, 0o600);
  const receipt = JSON.parse(fs.readFileSync(test.receipt));
  assert.equal(receipt.format, 1);
  assert.equal(receipt.name, hostName);
  assert.equal(receipt.path, test.host);
  assert.match(receipt.source_sha256, /^[0-9a-f]{64}$/);
  assert.equal(receipt.executable_sha256, crypto.createHash('sha256').update(fs.readFileSync(test.host)).digest('hex'));
  assert.match(receipt.compiler, /Swift version/);
  assert.match(receipt.compiler, /\n[0-9a-f]{64}$/);
  assert.equal(receipt.architecture, spawnSync('/usr/bin/uname', ['-m'], { encoding: 'utf8' }).stdout.trim());
  test.manifests.forEach((file, index) => {
    assert.equal(fs.statSync(test.dirs[index]).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), {
      name: hostName, description: 'I Know It! screenshot context bridge', path: test.host,
      type: 'stdio', allowed_origins: [`chrome-extension://${id}/`],
    });
    assert(!fs.readdirSync(test.dirs[index]).some(name => name.startsWith('.i-know-it.')));
  });
  assert(!fs.readdirSync(test.app).some(name => name.startsWith('.build.')));
}
function pass(message) { passes.push(message); console.log(`PASS: ${message}`); }
try {
  const basic = fixture('install twice with spaces');
  for (const id of ['', 'invalid', 'a'.repeat(31), 'q'.repeat(32), 'a'.repeat(33)]) {
    run(basic, 'install.sh', [id], false);
    assert(!fs.existsSync(basic.support), 'Invalid IDs must not create installation files');
  }
  run(basic, 'install.sh', ['a'.repeat(32), 'extra'], false);
  assert(!fs.existsSync(basic.support));
  pass('invalid IDs and extra arguments fail before installation');
  run(basic, 'install.sh');
  verifyInstalled(basic, expectedID);
  fs.utimesSync(basic.host, 1, 1);
  const initial = snapshot([basic.host, basic.receipt]);
  fs.chmodSync(basic.host, 0o777);
  fs.chmodSync(basic.receipt, 0o644);
  const repeated = run(basic, 'install.sh');
  verifyInstalled(basic, expectedID);
  unchanged([basic.host, basic.receipt], initial);
  assert.match(repeated.stdout, /Reused the unchanged native executable/);
  pass('real Swift installation writes a private receipt; unchanged reinstall preserves executable and receipt bytes and mtime');

  const installedFiles = [basic.host, basic.receipt, ...basic.manifests];
  const beforeFailure = snapshot(installedFiles);
  fs.writeFileSync(path.join(basic.source, 'native/main.swift'), 'This intentionally does not compile.\n');
  run(basic, 'install.sh', [], false);
  unchanged(installedFiles, beforeFailure);
  verifyInstalled(basic, expectedID);
  fs.writeFileSync(path.join(basic.source, 'native/main.swift'), originalSwift);
  pass('compiler failure preserves the host, receipt, and registration bytes and mtime and cleans temporary files');

  run(basic, 'install.sh', ['a'.repeat(32)]);
  verifyInstalled(basic, 'a'.repeat(32));
  unchanged([basic.host, basic.receipt], initial);
  pass('extension ID updates both browser registrations while retaining the unchanged native executable');

  for (const change of ['source', 'compiler', 'architecture', 'corrupt executable', 'missing executable', 'missing receipt']) {
    const oldReceipt = JSON.parse(fs.readFileSync(basic.receipt));
    fs.utimesSync(basic.host, 1, 1);
    if (change === 'source') fs.appendFileSync(path.join(basic.source, 'native/main.swift'), '\n// Installer source-change fixture.\n');
    if (change === 'compiler' || change === 'architecture') {
      oldReceipt[change] = 'Different build environment';
      fs.writeFileSync(basic.receipt, JSON.stringify(oldReceipt));
    }
    if (change === 'corrupt executable') fs.appendFileSync(basic.host, 'Modified executable bytes');
    if (change === 'missing executable') fs.unlinkSync(basic.host);
    if (change === 'missing receipt') fs.unlinkSync(basic.receipt);
    const rebuilt = run(basic, 'install.sh', ['a'.repeat(32)]);
    verifyInstalled(basic, 'a'.repeat(32));
    assert(fs.statSync(basic.host).mtimeMs > 1000, `${change} must rebuild instead of reusing`);
    assert.match(rebuilt.stdout, /Built the native executable/);
    const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(basic.source, 'native/main.swift'))).digest('hex');
    assert.equal(JSON.parse(fs.readFileSync(basic.receipt)).source_sha256, sourceHash);
  }
  pass('source, compiler, architecture, corruption, missing executable, and legacy unreceipted installs rebuild');

  const beforePublishFailure = snapshot(installedFiles);
  const installer = path.join(basic.source, 'install.sh');
  const installerText = fs.readFileSync(installer, 'utf8');
  const publishReceipt = 'mv -f -- "$build_dir/install-receipt.json" "$receipt_path"';
  assert(installerText.includes(publishReceipt));
  fs.writeFileSync(installer, installerText.replace(publishReceipt, 'false # Injected receipt publication failure.'));
  fs.appendFileSync(path.join(basic.source, 'native/main.swift'), '\n// Force a rebuild for publication failure.\n');
  run(basic, 'install.sh', ['a'.repeat(32)], false);
  unchanged([basic.host, basic.receipt], beforePublishFailure.slice(0, 2));
  verifyInstalled(basic, 'a'.repeat(32));
  fs.writeFileSync(installer, installerText);
  pass('receipt publication failure rolls back the previous host and receipt');
  const capture = path.join(basic.app, 'captures', 'existing', 'context.md');
  fs.mkdirSync(path.dirname(capture), { recursive: true });
  fs.writeFileSync(capture, 'Keep this saved context.');
  const unrelated = [path.join(basic.app, 'unrelated.txt'), path.join(basic.dirs[0], 'com.other.host.json')];
  unrelated.forEach(file => fs.writeFileSync(file, 'Keep this unrelated file.'));
  run(basic, 'uninstall.sh');
  run(basic, 'uninstall.sh');
  [basic.host, basic.receipt, ...basic.manifests].forEach(file => assert(!fs.existsSync(file)));
  assert.equal(fs.readFileSync(capture, 'utf8'), 'Keep this saved context.');
  unrelated.forEach(file => assert.equal(fs.readFileSync(file, 'utf8'), 'Keep this unrelated file.'));
  pass('uninstall is idempotent and retains captures and unrelated files');

  const foreign = fixture('foreign registration');
  fs.mkdirSync(foreign.dirs[0], { recursive: true });
  fs.mkdirSync(foreign.app, { recursive: true });
  fs.writeFileSync(foreign.host, 'Unregistered executable owned by somebody else.');
  const foreignJSON = JSON.stringify({ name: 'com.other.host', path: '/somewhere/else' });
  fs.writeFileSync(foreign.manifests[0], foreignJSON);
  run(foreign, 'install.sh', [], false);
  run(foreign, 'uninstall.sh');
  assert.equal(fs.readFileSync(foreign.manifests[0], 'utf8'), foreignJSON);
  assert.equal(fs.readFileSync(foreign.host, 'utf8'), 'Unregistered executable owned by somebody else.');
  fs.unlinkSync(foreign.manifests[0]);
  run(foreign, 'install.sh', [], false);
  run(foreign, 'uninstall.sh');
  assert.equal(fs.readFileSync(foreign.host, 'utf8'), 'Unregistered executable owned by somebody else.');
  pass('foreign registrations and unregistered executable files remain untouched');

  const foreignReceipt = fixture('foreign receipt');
  fs.mkdirSync(foreignReceipt.app, { recursive: true });
  const foreignReceiptBytes = '{"format":1,"name":"com.other.host","path":"/somewhere/else"}';
  fs.writeFileSync(foreignReceipt.receipt, foreignReceiptBytes);
  run(foreignReceipt, 'install.sh', [], false);
  run(foreignReceipt, 'uninstall.sh');
  assert.equal(fs.readFileSync(foreignReceipt.receipt, 'utf8'), foreignReceiptBytes);
  assert(!fs.existsSync(foreignReceipt.host));
  pass('unrecognized receipt files remain untouched by installation and removal');

  for (const kind of ['manifest', 'host', 'receipt', 'app directory', 'browser directory']) {
    const test = fixture(`symlink ${kind}`);
    const target = path.join(test.folder, 'unrelated target');
    const linked = { manifest: test.manifests[0], host: test.host, receipt: test.receipt, 'app directory': test.app, 'browser directory': test.dirs[0] }[kind];
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    const isDirectory = kind.endsWith('directory');
    if (isDirectory) fs.mkdirSync(target);
    fs.symlinkSync(target, linked);
    const ownJSON = JSON.stringify({ name: hostName, path: test.host });
    const sentinel = kind === 'app directory' ? path.join(target, 'i-know-it-host')
      : kind === 'browser directory' ? path.join(target, `${hostName}.json`) : target;
    const contents = ['manifest', 'browser directory'].includes(kind) ? ownJSON : 'Do not follow or delete this target.';
    fs.writeFileSync(sentinel, contents);
    if (['host', 'app directory'].includes(kind)) {
      fs.mkdirSync(test.dirs[0], { recursive: true });
      fs.writeFileSync(test.manifests[0], ownJSON);
    }
    run(test, 'install.sh', [], false);
    run(test, 'uninstall.sh');
    assert(fs.lstatSync(linked).isSymbolicLink());
    assert.equal(fs.readFileSync(sentinel, 'utf8'), contents);
  }
  pass('manifest, executable, receipt, application-directory, and browser-directory symlinks are preserved');
  console.log(`PASS: ${passes.length} installer checks; real user registrations and clipboard were never accessed.`);
} finally {
  fs.rmSync(root, { recursive: true });
}
