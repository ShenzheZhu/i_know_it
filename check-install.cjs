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
  return { folder, support, source, app, host, dirs, manifests: dirs.map(dir => path.join(dir, `${hostName}.json`)) };
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
function verifyInstalled(test, id) {
  assert.equal(fs.statSync(test.app).mode & 0o777, 0o700);
  assert.equal(fs.statSync(test.host).mode & 0o777, 0o755);
  assert(fs.statSync(test.host).size > 0);
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
  run(basic, 'install.sh');
  verifyInstalled(basic, expectedID);
  pass('real Swift installation and repeat installation use the stable ID and private permissions');

  const beforeFailure = [basic.host, ...basic.manifests].map(file => fs.readFileSync(file));
  fs.writeFileSync(path.join(basic.source, 'native/main.swift'), 'This intentionally does not compile.\n');
  run(basic, 'install.sh', [], false);
  [basic.host, ...basic.manifests].forEach((file, index) => assert.deepEqual(fs.readFileSync(file), beforeFailure[index]));
  verifyInstalled(basic, expectedID);
  fs.writeFileSync(path.join(basic.source, 'native/main.swift'), originalSwift);
  pass('compiler failure preserves the installed host and registrations and cleans temporary files');

  run(basic, 'install.sh', ['a'.repeat(32)]);
  verifyInstalled(basic, 'a'.repeat(32));
  pass('an explicit valid extension ID is registered for both browsers');
  const capture = path.join(basic.app, 'captures', 'existing', 'context.md');
  fs.mkdirSync(path.dirname(capture), { recursive: true });
  fs.writeFileSync(capture, 'Keep this saved context.');
  const unrelated = [path.join(basic.app, 'unrelated.txt'), path.join(basic.dirs[0], 'com.other.host.json')];
  unrelated.forEach(file => fs.writeFileSync(file, 'Keep this unrelated file.'));
  run(basic, 'uninstall.sh');
  run(basic, 'uninstall.sh');
  [basic.host, ...basic.manifests].forEach(file => assert(!fs.existsSync(file)));
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

  for (const kind of ['manifest', 'host', 'app directory', 'browser directory']) {
    const test = fixture(`symlink ${kind}`);
    const target = path.join(test.folder, 'unrelated target');
    const linked = { manifest: test.manifests[0], host: test.host, 'app directory': test.app, 'browser directory': test.dirs[0] }[kind];
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
  pass('manifest, executable, application-directory, and browser-directory symlinks are preserved');
  console.log(`PASS: ${passes.length} installer checks; real user registrations and clipboard were never accessed.`);
} finally {
  fs.rmSync(root, { recursive: true });
}
