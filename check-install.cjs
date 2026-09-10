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
const originalManifest = fs.readFileSync(path.join(__dirname, 'manifest.json'));
const key = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'))).key;
const expectedID = [...crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)]
  .map(char => String.fromCharCode(97 + parseInt(char, 16))).join('');
const passes = [];
const realSigning = Object.hasOwn(process.env, 'IKI_TEST_SIGNING_IDENTITY');
const protocolCertificate = Buffer.from('I Know It installer protocol certificate fixture; not an actual certificate.\n');
const signingIdentity = realSigning ? process.env.IKI_TEST_SIGNING_IDENTITY.toLowerCase()
  : crypto.createHash('sha1').update(protocolCertificate).digest('hex');
assert.match(signingIdentity, /^[0-9a-f]{40}$/, 'IKI_TEST_SIGNING_IDENTITY must be an existing certificate SHA-1 fingerprint');
const signingKeychain = process.env.IKI_TEST_SIGNING_KEYCHAIN ?? '';
console.log(realSigning
  ? 'MODE: existing real signing identity; no certificates, keychains or trust settings are created.'
  : 'MODE: SYNTHETIC codesign protocol fixture + real Swift compilation; no cryptographic or TCC continuity is verified.');
// Serialised into each disposable source tree. This models codesign's I/O protocol,
// not Mach-O signatures, certificate trust, private keys, or cryptographic continuity.
function codesignProtocol() {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const args = process.argv.slice(2), file = args.at(-1), mode = process.env.IKI_TEST_PROTOCOL_MODE;
  fs.appendFileSync(path.join(__dirname, 'codesign.calls'), JSON.stringify(args) + '\n');
  const fail = text => { process.stderr.write('Synthetic codesign fixture: ' + text + '\n'); process.exit(1); };
  const extraction = args.find(arg => arg.startsWith('--extract-certificates='));
  if (args.includes('--extract-certificates') && args.length !== 3) {
    fail('The optional certificate prefix must use --extract-certificates=PREFIX; a separated prefix is another input path');
  }
  const cert = fs.readFileSync(path.join(__dirname, 'protocol-certificate'));
  const fingerprint = crypto.createHash('sha1').update(cert).digest('hex');
  const trailer = Buffer.from('\nIKI_SYNTHETIC_SIGNING_PROTOCOL_V1\n');
  const bytes = fs.readFileSync(file);
  if (args.includes('--sign')) {
    if (['sign-failure', 'missing-key'].includes(mode)) fail(mode);
    if (args[args.indexOf('--sign') + 1].toLowerCase() !== fingerprint) fail('identity not available');
    const identifier = args[args.indexOf('--identifier') + 1];
    const certificate = mode === 'wrong-certificate' ? Buffer.from('different synthetic certificate') : cert;
    const requirement = `identifier "${identifier}" and certificate leaf = H"${fingerprint}"`
      + (mode === 'changed-requirement' ? ' and synthetic-update-mismatch' : '');
    const metadata = { identifier, certificate: certificate.toString('base64'), requirement,
      originalHash: crypto.createHash('sha256').update(bytes).digest('hex') };
    fs.appendFileSync(file, Buffer.concat([trailer, Buffer.from(JSON.stringify(metadata))]));
    process.exit(0);
  }
  const split = bytes.lastIndexOf(trailer);
  if (split < 0) fail('no synthetic signature');
  let signature;
  try { signature = JSON.parse(bytes.subarray(split + trailer.length).toString()); } catch { fail('invalid synthetic signature'); }
  if (signature.originalHash !== crypto.createHash('sha256').update(bytes.subarray(0, split)).digest('hex')) fail('changed binary');
  if (args.includes('--verify')) {
    if (mode === 'verify-failure') fail(mode);
    const required = args.indexOf('-R');
    if (required >= 0 && ![`=identifier "${signature.identifier}"`, '=' + signature.requirement].includes(args[required + 1])) fail('requirement mismatch');
  } else if (extraction || args.includes('--extract-certificates')) {
    if (mode === 'missing-certificate') process.exit(0);
    const prefix = extraction ? extraction.slice('--extract-certificates='.length) : 'codesign';
    fs.writeFileSync(prefix + '0', Buffer.from(signature.certificate, 'base64'));
  } else if (args.includes('--display') && args.includes('-r-')) {
    process.stderr.write('Executable=' + file + '\n');
    process.stdout.write('designated => ' + signature.requirement + '\n');
  } else fail('unexpected protocol arguments: ' + JSON.stringify(args));
}
// Real mode delegates to the system tool and only records arguments for reuse assertions.
function codesignReal() {
  const fs = require('node:fs'), path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const args = process.argv.slice(2);
  fs.appendFileSync(path.join(__dirname, 'codesign.calls'), JSON.stringify(args) + '\n');
  if (args.includes('--sign') && ['sign-failure', 'missing-key'].includes(process.env.IKI_TEST_PROTOCOL_MODE)) {
    process.stderr.write('Injected signing failure; no signing command was executed.\n'); process.exit(1);
  }
  const result = spawnSync('/usr/bin/codesign', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
function calls(test, reset = false) {
  const file = path.join(test.source, 'codesign.calls');
  const result = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  if (reset) fs.rmSync(file, { force: true });
  return result;
}
// Older macOS plutil can put missing-file/key diagnostics on stdout, then exit 1.
// Keep real successful plist operations; make that failure channel deterministic everywhere.
function plutilStdoutFailure() {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync('/usr/bin/plutil', process.argv.slice(2), { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status === 0) {
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  } else process.stdout.write('Old-plutil failure on stdout: ' + (result.stdout + result.stderr || 'operation failed\n'));
  process.exit(result.status ?? 1);
}
function fixture(name) {
  const folder = path.join(root, name);
  const support = path.join(folder, 'Application Support');
  const source = path.join(folder, 'source');
  fs.mkdirSync(path.join(source, 'native'), { recursive: true });
  fs.writeFileSync(path.join(source, 'native/main.swift'), originalSwift);
  fs.writeFileSync(path.join(source, 'manifest.json'), originalManifest);
  fs.copyFileSync(path.join(__dirname, 'Install.command'), path.join(source, 'Install.command'));
  for (const script of ['install.sh', 'uninstall.sh']) {
    let content = fs.readFileSync(path.join(__dirname, script), 'utf8');
    content = content.replaceAll('/usr/bin/codesign', '"$source_dir/codesign-fixture"');
    content = content.replaceAll('/usr/bin/plutil', '"' + path.join(source, 'plutil-fixture').replace(/[\\$"`]/g, '\\$&') + '"');
    const prefix = '$HOME/Library/Application Support';
    assert(content.includes(prefix), `${script} must retain the known installation prefix`);
    fs.writeFileSync(path.join(source, script), content.replaceAll(prefix, support.replace(/[\\$"`]/g, '\\$&')));
  }
  fs.writeFileSync(path.join(source, 'plutil-fixture'), '#!/usr/bin/env node\n(' + plutilStdoutFailure.toString() + ')();\n', { mode: 0o755 });
  if (!realSigning) fs.writeFileSync(path.join(source, 'protocol-certificate'), protocolCertificate);
  fs.writeFileSync(path.join(source, 'codesign-fixture'), '#!/usr/bin/env node\n('
    + (realSigning ? codesignReal : codesignProtocol).toString() + ')();\n', { mode: 0o755 });
  const app = path.join(support, 'I Know It');
  const host = path.join(app, 'i-know-it-host');
  const dirs = ['Chrome', 'ChromeForTesting'].map(browser => path.join(support, 'Google', browser, 'NativeMessagingHosts'));
  return { folder, support, source, app, host, receipt: path.join(app, 'install-receipt.json'), dirs, manifests: dirs.map(dir => path.join(dir, `${hostName}.json`)) };
}
function run(test, script, args = [], succeeds = true, overrides = {}) {
  const env = { ...process.env, IKI_SIGNING_IDENTITY: signingIdentity, IKI_SIGNING_KEYCHAIN: signingKeychain, IKI_TEST_PROTOCOL_MODE: undefined, ...overrides };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  const result = spawnSync('/bin/bash', [path.join(test.source, script), ...args], {
    cwd: test.source, env, encoding: 'utf8', timeout: 120_000,
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
function verifyInstalled(test, id, expectedKeychain = signingKeychain) {
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
  assert.equal(receipt.signing_identity, signingIdentity);
  assert.equal(receipt.signing_keychain, expectedKeychain);
  assert.match(receipt.designated_requirement, /identifier "com\.iknowit\.bridge"/);
  const executable = realSigning ? '/usr/bin/codesign' : path.join(test.source, 'codesign-fixture');
  const verified = spawnSync(executable, ['--verify', '--strict', '-R', '=' + receipt.designated_requirement, test.host], { encoding: 'utf8' });
  assert.equal(verified.status, 0, verified.stderr);
  const requirement = spawnSync(executable, ['--display', '-r-', test.host], { encoding: 'utf8' });
  assert.equal(requirement.status, 0, requirement.stderr);
  const requirements = [...(requirement.stdout + '\n' + requirement.stderr).matchAll(/^designated => (.+)$/gm)];
  assert.deepEqual(requirements.map(match => match[1]), [receipt.designated_requirement]);
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
  assert(!fs.readdirSync(test.app).some(name => name.startsWith('.build.') || name === '.install-lock'));
}
function pass(message) { passes.push(message); console.log(`PASS: ${message}`); }
try {
  const receiptFailure = fixture('old plutil failure stdout');
  const currentHelper = fs.readFileSync(path.join(receiptFailure.source, 'install.sh'), 'utf8')
    .match(/receipt_value\(\) \{[\s\S]*?\n\}/)?.[0];
  assert(currentHelper, 'Expected the production receipt_value helper');
  const oldHelper = 'receipt_value() { "$source_dir/plutil-fixture" -extract "$1" raw -o - "$receipt_path" 2>/dev/null || true; }';
  const helperReceipt = path.join(receiptFailure.source, 'receipt-fixture.json');
  function readReceiptHelper(helper, key) {
    const result = spawnSync('/bin/bash', ['-c', 'source_dir="$1"; receipt_path="$2"; ' + helper
      + '\nvalue="$(receipt_value "$3")"; printf "%s" "$value"', 'receipt-helper', receiptFailure.source, helperReceipt, key], { encoding: 'utf8' });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  for (const missing of ['receipt', 'key']) {
    if (missing === 'key') fs.writeFileSync(helperReceipt, JSON.stringify({ format: 1 }));
    assert.match(readReceiptHelper(oldHelper, 'signing_identity'), /^Old-plutil failure on stdout:/,
      'RED: old helper mistakes failed extraction diagnostics for a receipt value');
    assert.equal(readReceiptHelper(currentHelper, 'signing_identity'), '',
      'GREEN: missing receipt or key must remain absent despite diagnostic stdout');
  }
  fs.writeFileSync(helperReceipt, JSON.stringify({ signing_identity: signingIdentity }));
  assert.equal(readReceiptHelper(currentHelper, 'signing_identity'), signingIdentity, 'Successful extraction still returns its exact value');
  pass('old-plutil stdout diagnostic regression: old helper fails both missing-value checks; current helper passes and preserves successful values');
  const basic = fixture('install twice with spaces');
  for (const id of ['', 'invalid', 'a'.repeat(31), 'q'.repeat(32), 'a'.repeat(33)]) {
    run(basic, 'install.sh', [id], false);
    assert(!fs.existsSync(basic.support), 'Invalid IDs must not create installation files');
  }
  run(basic, 'install.sh', ['a'.repeat(32), 'extra'], false);
  assert(!fs.existsSync(basic.support));
  pass('invalid IDs and extra arguments fail before installation');
  for (const identity of [undefined, '', 'invalid', 'a'.repeat(39), 'a'.repeat(41)]) {
    run(basic, 'install.sh', [], false, { IKI_SIGNING_IDENTITY: identity });
    assert(!fs.existsSync(basic.host) && !fs.existsSync(basic.receipt));
    assert(basic.manifests.every(file => !fs.existsSync(file)));
    assert(!fs.readdirSync(basic.app).some(name => name.startsWith('.build.') || name === '.install-lock'));
  }
  const lock = path.join(basic.app, '.install-lock'); fs.mkdirSync(lock);
  run(basic, 'install.sh', [], false);
  assert(fs.existsSync(lock) && !fs.existsSync(basic.host), 'An existing installer lock must be preserved');
  assert(!fs.readdirSync(basic.app).some(name => name.startsWith('.build.')));
  fs.rmdirSync(lock);
  pass('missing signing identity and concurrent installer lock fail without publishing helper files');
  run(basic, 'install.sh');
  verifyInstalled(basic, expectedID);
  fs.utimesSync(basic.host, 1, 1);
  const initial = snapshot([basic.host, basic.receipt]);
  fs.chmodSync(basic.host, 0o777);
  fs.chmodSync(basic.receipt, 0o644);
  calls(basic, true);
  const repeated = run(basic, 'install.sh', [], true, { IKI_SIGNING_IDENTITY: undefined, IKI_SIGNING_KEYCHAIN: undefined });
  assert(!calls(basic).some(args => args.includes('--sign')), 'Unchanged signed reuse must not invoke signing or key access');
  verifyInstalled(basic, expectedID);
  unchanged([basic.host, basic.receipt], initial);
  assert.match(repeated.stdout, /Reused the unchanged native executable/);
  pass('real Swift installation writes a private receipt; unchanged reinstall preserves executable and receipt bytes and mtime');

  const prebuilt = fixture('prebuilt install without development tools');
  const prebuiltDir = path.join(prebuilt.source, 'native/prebuilt');
  const prebuiltMetadata = path.join(prebuiltDir, 'build.json');
  const prebuiltHost = path.join(prebuiltDir, 'i-know-it-host');
  function packageInstalled(donor) {
    fs.mkdirSync(prebuiltDir, { recursive: true });
    fs.copyFileSync(path.join(donor.source, 'native/main.swift'), path.join(prebuilt.source, 'native/main.swift'));
    fs.copyFileSync(donor.host, prebuiltHost);
    const receipt = JSON.parse(fs.readFileSync(donor.receipt));
    const metadata = { format: 1, name: hostName, version: JSON.parse(originalManifest).version,
      source_sha256: receipt.source_sha256, executable_sha256: receipt.executable_sha256,
      signing_identity: receipt.signing_identity, designated_requirement: receipt.designated_requirement,
      compiler: receipt.compiler, architecture: receipt.architecture, minimum_macos: '10.0' };
    fs.writeFileSync(prebuiltMetadata, JSON.stringify(metadata));
    return metadata;
  }
  const firstPackage = packageInstalled(basic);
  const prebuiltInstallerPath = path.join(prebuilt.source, 'install.sh');
  const prebuiltInstaller = fs.readFileSync(prebuiltInstallerPath, 'utf8')
    .replaceAll('/usr/bin/xcrun', '"$source_dir/unavailable-compiler"');
  fs.writeFileSync(prebuiltInstallerPath, prebuiltInstaller);
  fs.writeFileSync(path.join(prebuilt.source, 'unavailable-compiler'),
    '#!/bin/bash\nprintf "Compiler must not be consulted\\n" >> "$0.calls"\nexit 91\n', { mode: 0o755 });
  function installPrebuilt(succeeds = true, script = 'install.sh', id = expectedID) {
    calls(prebuilt, true);
    const result = run(prebuilt, script, [id], succeeds,
      { IKI_SIGNING_IDENTITY: undefined, IKI_SIGNING_KEYCHAIN: undefined });
    assert(!calls(prebuilt).some(args => args.includes('--sign') || args.includes('--keychain')),
      'Prebuilt installation cannot sign or consult a keychain');
    assert(!fs.existsSync(path.join(prebuilt.source, 'unavailable-compiler.calls')),
      'Prebuilt installation cannot consult the compiler, even on failures');
    return result;
  }
  const firstPrebuilt = installPrebuilt(true, 'Install.command');
  assert.match(firstPrebuilt.stdout, /Installed the verified prebuilt executable/);
  verifyInstalled(prebuilt, expectedID, '');
  assert.deepEqual(fs.readFileSync(prebuilt.host), fs.readFileSync(basic.host));
  fs.utimesSync(prebuilt.host, 1, 1);
  const prebuiltFiles = [prebuilt.host, prebuilt.receipt, ...prebuilt.manifests];
  let prebuiltBefore = snapshot(prebuiltFiles);
  const repeatedPrebuilt = installPrebuilt();
  assert.match(repeatedPrebuilt.stdout, /Reused the unchanged native executable/);
  unchanged([prebuilt.host, prebuilt.receipt], prebuiltBefore);
  prebuiltBefore = snapshot(prebuiltFiles);
  pass('double-click launcher installs an exact prebuilt payload without signing settings or compiler; repeated install preserves bytes and mtime');

  for (const mutation of [
    { format: 2 }, { name: 'com.other.host' }, { version: '999.0' },
    { source_sha256: '0'.repeat(64) }, { executable_sha256: '0'.repeat(64) },
    { signing_identity: '0'.repeat(40) }, { designated_requirement: 'identifier "unexpected"' },
    { compiler: '' }, { architecture: firstPackage.architecture === 'arm64' ? 'x86_64' : 'arm64' },
    { minimum_macos: 'invalid' }, { minimum_macos: '999.0' },
  ]) {
    fs.writeFileSync(prebuiltMetadata, JSON.stringify({ ...firstPackage, ...mutation }));
    installPrebuilt(false);
    unchanged(prebuiltFiles, prebuiltBefore);
  }
  fs.writeFileSync(prebuiltMetadata, '{invalid JSON');
  installPrebuilt(false); unchanged(prebuiltFiles, prebuiltBefore);
  fs.writeFileSync(prebuiltMetadata, JSON.stringify(firstPackage));
  fs.appendFileSync(prebuiltHost, 'Corrupt downloaded payload');
  installPrebuilt(false); unchanged(prebuiltFiles, prebuiltBefore);
  packageInstalled(basic);
  for (const file of [prebuiltHost, prebuiltMetadata]) {
    const bytes = fs.readFileSync(file); fs.unlinkSync(file);
    installPrebuilt(false); unchanged(prebuiltFiles, prebuiltBefore);
    fs.symlinkSync(file === prebuiltHost ? basic.host : basic.receipt, file);
    installPrebuilt(false); unchanged(prebuiltFiles, prebuiltBefore);
    fs.unlinkSync(file); fs.writeFileSync(file, bytes);
  }
  const movedPrebuiltDir = prebuiltDir + '-original';
  fs.renameSync(prebuiltDir, movedPrebuiltDir); fs.symlinkSync(movedPrebuiltDir, prebuiltDir);
  installPrebuilt(false); unchanged(prebuiltFiles, prebuiltBefore);
  fs.unlinkSync(prebuiltDir); fs.renameSync(movedPrebuiltDir, prebuiltDir);
  pass('invalid prebuilt metadata, mismatched platform/source/version/signature, corrupt bytes, missing files and symlinks cannot fall back or modify an installation');

  const signedFiles = [basic.host, basic.receipt, ...basic.manifests];
  const signedBefore = snapshot(signedFiles);
  const changedIdentity = signingIdentity === 'a'.repeat(40) ? 'b'.repeat(40) : 'a'.repeat(40);
  for (const identity of ['', changedIdentity]) {
    calls(basic, true);
    run(basic, 'install.sh', [], false, { IKI_SIGNING_IDENTITY: identity });
    unchanged(signedFiles, signedBefore);
    assert.equal(calls(basic).length, 0, 'Changed signer must fail before any signing tool invocation');
  }
  pass('signed receipt pins identity; missing override or changed identity preserves all installed files');

  const installer = path.join(basic.source, 'install.sh');
  const installerText = fs.readFileSync(installer, 'utf8');
  const compilerStub = path.join(basic.source, 'xcrun-fixture');
  assert(installerText.includes('/usr/bin/xcrun'));
  fs.writeFileSync(installer, installerText.replaceAll('/usr/bin/xcrun', '"$source_dir/xcrun-fixture"'));
  for (const toolchain of ['updated', 'unavailable']) {
    fs.writeFileSync(compilerStub, '#!/bin/bash\nprintf "%s\\n" "$*" >> "$0.calls"\n' + (toolchain === 'updated'
      ? 'if [[ "$1" == --find ]]; then printf "%s\\n" "$0"; elif [[ "$2" == --version ]]; then echo "Swift version fixture-updated"; else exit 91; fi\n'
      : 'exit 91\n'), { mode: 0o755 });
    calls(basic, true);
    const reused = run(basic, 'install.sh');
    assert(!calls(basic).some(args => args.includes('--sign')), 'Verified reuse cannot sign again');
    assert.match(reused.stdout, /Reused the unchanged native executable/);
    unchanged([basic.host, basic.receipt], initial);
    verifyInstalled(basic, expectedID);
    assert(!fs.existsSync(`${compilerStub}.calls`), `${toolchain} compiler must not be consulted for verified reuse`);
  }
  const beforeMissingCompiler = snapshot([basic.host, basic.receipt, ...basic.manifests]);
  fs.appendFileSync(path.join(basic.source, 'native/main.swift'), '\n// A changed source still needs a compiler.\n');
  run(basic, 'install.sh', [], false);
  assert(fs.existsSync(`${compilerStub}.calls`), 'Changed source must require the compiler');
  unchanged([basic.host, basic.receipt, ...basic.manifests], beforeMissingCompiler);
  verifyInstalled(basic, expectedID);
  fs.writeFileSync(path.join(basic.source, 'native/main.swift'), originalSwift);
  fs.writeFileSync(installer, installerText);
  pass('verified native reuse needs no compiler, retains original build metadata, and unavailable tools cannot replace a changed-source installation');

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

  for (const change of ['source', 'architecture', 'corrupt executable', 'non-executable host', 'missing executable', 'missing receipt']) {
    const oldReceipt = JSON.parse(fs.readFileSync(basic.receipt));
    fs.utimesSync(basic.host, 1, 1);
    if (change === 'source') fs.appendFileSync(path.join(basic.source, 'native/main.swift'), '\n// Installer source-change fixture.\n');
    if (change === 'architecture') {
      oldReceipt[change] = 'Different build environment';
      fs.writeFileSync(basic.receipt, JSON.stringify(oldReceipt));
    }
    if (change === 'corrupt executable') fs.appendFileSync(basic.host, 'Modified executable bytes');
    if (change === 'non-executable host') fs.chmodSync(basic.host, 0o600);
    if (change === 'missing executable') fs.unlinkSync(basic.host);
    if (change === 'missing receipt') fs.unlinkSync(basic.receipt);
    const rebuilt = run(basic, 'install.sh', ['a'.repeat(32)]);
    verifyInstalled(basic, 'a'.repeat(32));
    assert(fs.statSync(basic.host).mtimeMs > 1000, `${change} must rebuild instead of reusing`);
    assert.match(rebuilt.stdout, /Built and verified the signed native executable/);
    const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(basic.source, 'native/main.swift'))).digest('hex');
    assert.equal(JSON.parse(fs.readFileSync(basic.receipt)).source_sha256, sourceHash);
  }
  pass('source, architecture, corruption, non-executable or missing host, and legacy unreceipted installs rebuild');

  const sourceFile = path.join(basic.source, 'native/main.swift');
  const beforeSignedUpdate = JSON.parse(fs.readFileSync(basic.receipt));
  fs.appendFileSync(sourceFile, '\nlet installerSigningUpdateFixture = 1\n');
  run(basic, 'install.sh', ['a'.repeat(32)]);
  verifyInstalled(basic, 'a'.repeat(32));
  const afterSignedUpdate = JSON.parse(fs.readFileSync(basic.receipt));
  assert.notEqual(afterSignedUpdate.source_sha256, beforeSignedUpdate.source_sha256);
  assert.notEqual(afterSignedUpdate.executable_sha256, beforeSignedUpdate.executable_sha256);
  assert.equal(afterSignedUpdate.signing_identity, beforeSignedUpdate.signing_identity);
  assert.equal(afterSignedUpdate.designated_requirement, beforeSignedUpdate.designated_requirement);
  pass(realSigning ? 'real changed-source builds retain the same signer and generated designated requirement'
    : 'synthetic signing protocol: changed-source builds retain signer/DR fields and hash final modified bytes');

  packageInstalled(basic);
  const changedPrebuilt = installPrebuilt();
  assert.match(changedPrebuilt.stdout, /Installed the verified prebuilt executable/);
  verifyInstalled(prebuilt, expectedID, '');
  assert.deepEqual(fs.readFileSync(prebuilt.host), fs.readFileSync(basic.host));
  assert.equal(JSON.parse(fs.readFileSync(prebuilt.receipt)).designated_requirement, firstPackage.designated_requirement);
  // Model a different valid build of identical source: the source hash alone
  // must not let an older installed executable override the selected release.
  const sameSourceReceipt = JSON.parse(fs.readFileSync(prebuilt.receipt));
  const secondPackage = JSON.parse(fs.readFileSync(prebuiltMetadata));
  fs.writeFileSync(prebuilt.host, initial[0].bytes);
  sameSourceReceipt.executable_sha256 = firstPackage.executable_sha256;
  fs.writeFileSync(prebuilt.receipt, JSON.stringify(sameSourceReceipt));
  const sameSourceUpdate = installPrebuilt();
  assert.match(sameSourceUpdate.stdout, /Installed the verified prebuilt executable/);
  assert.equal(JSON.parse(fs.readFileSync(prebuilt.receipt)).executable_sha256, secondPackage.executable_sha256);
  assert.deepEqual(fs.readFileSync(prebuilt.host), fs.readFileSync(prebuiltHost));
  pass('same-signer prebuilt update retains the pinned default requirement; selected payload wins even when the older receipt claims identical source');

  const prebuiltUpdatedBefore = snapshot(prebuiltFiles);
  const updateReceipt = JSON.parse(fs.readFileSync(prebuilt.receipt));
  for (const mutation of [{ signing_identity: '0'.repeat(40) }, { designated_requirement: updateReceipt.designated_requirement + ' and identifier "unexpected"' }]) {
    fs.writeFileSync(prebuilt.receipt, JSON.stringify({ ...updateReceipt, ...mutation }));
    const pinnedBefore = snapshot(prebuiltFiles);
    installPrebuilt(false); unchanged(prebuiltFiles, pinnedBefore);
  }
  fs.writeFileSync(prebuilt.receipt, prebuiltUpdatedBefore[1].bytes);
  verifyInstalled(prebuilt, expectedID, '');
  pass('prebuilt updates cannot bypass an installed signer or designated-requirement pin');

  for (const [publication, replacement] of [
    ['mv -f -- "$build_dir/install-receipt.json" "$receipt_path"', 'false # Injected prebuilt receipt failure.'],
    ['mv -f -- "$manifest_temp" "$directory/$host_name.json"',
      'if [[ "$published_manifests" == 1 ]]; then false; else mv -f -- "$manifest_temp" "$directory/$host_name.json"; fi'],
  ]) {
    // Force payload replacement while retaining the selected package and signer.
    fs.writeFileSync(prebuilt.host, initial[0].bytes);
    fs.writeFileSync(prebuilt.receipt, JSON.stringify({ ...updateReceipt, executable_sha256: firstPackage.executable_sha256 }));
    const before = snapshot(prebuiltFiles);
    assert(prebuiltInstaller.includes(publication));
    fs.writeFileSync(prebuiltInstallerPath, prebuiltInstaller.replace(publication, replacement));
    installPrebuilt(false, 'install.sh', 'b'.repeat(32));
    unchanged(prebuiltFiles, before);
  }
  fs.writeFileSync(prebuiltInstallerPath, prebuiltInstaller);
  installPrebuilt(); verifyInstalled(prebuilt, expectedID, '');
  pass('prebuilt receipt and second-registration publication failures restore all installed bytes and mtime');

  const updatedSource = fs.readFileSync(sourceFile);
  fs.appendFileSync(sourceFile, '\n// Force staged signing failure.\n');
  for (const failure of ['sign-failure', 'missing-key', ...(!realSigning ? ['verify-failure', 'wrong-certificate', 'changed-requirement', 'missing-certificate'] : [])]) {
    const before = snapshot(installedFiles); calls(basic, true);
    const failed = run(basic, 'install.sh', ['a'.repeat(32)], false, { IKI_TEST_PROTOCOL_MODE: failure });
    unchanged(installedFiles, before);
    assert(calls(basic).some(args => args.includes('--sign')), `${failure} must reach staged signing`);
    verifyInstalled(basic, 'a'.repeat(32));
    assert(failed.status !== 0);
  }
  fs.writeFileSync(sourceFile, updatedSource);
  pass('injected signing/missing-key/verification failures preserve host, receipt and registration bytes and mtime');

  const correctReceipt = fs.readFileSync(basic.receipt);
  const mismatchedReceipt = JSON.parse(correctReceipt);
  mismatchedReceipt.designated_requirement += ' and identifier "unexpected-fixture"';
  fs.writeFileSync(basic.receipt, JSON.stringify(mismatchedReceipt));
  const wrongRequirementBefore = snapshot(installedFiles);
  run(basic, 'install.sh', ['a'.repeat(32)], false);
  unchanged(installedFiles, wrongRequirementBefore);
  fs.writeFileSync(basic.receipt, correctReceipt);
  verifyInstalled(basic, 'a'.repeat(32));
  pass('an update cannot replace a host when the pinned previous requirement disagrees');

  function legacyReceipt() {
    const receipt = JSON.parse(fs.readFileSync(basic.receipt));
    delete receipt.signing_identity; delete receipt.signing_keychain; delete receipt.designated_requirement;
    return receipt;
  }
  const oldDefaultRequirement = JSON.parse(correctReceipt).designated_requirement;
  fs.writeFileSync(basic.receipt, JSON.stringify(legacyReceipt()));
  const legacySignedBefore = snapshot(installedFiles);
  run(basic, 'install.sh', ['a'.repeat(32)], false, { IKI_SIGNING_IDENTITY: changedIdentity });
  unchanged(installedFiles, legacySignedBefore);
  const migratedSigned = run(basic, 'install.sh', ['a'.repeat(32)]);
  assert(!/Reused the unchanged/.test(migratedSigned.stdout), 'A signed legacy receipt must gain signer fields');
  verifyInstalled(basic, 'a'.repeat(32));
  assert.equal(JSON.parse(fs.readFileSync(basic.receipt)).designated_requirement, oldDefaultRequirement);
  fs.unlinkSync(basic.receipt);
  const withoutReceipt = [basic.host, ...basic.manifests], withoutReceiptBefore = snapshot(withoutReceipt);
  run(basic, 'install.sh', ['a'.repeat(32)], false, { IKI_SIGNING_IDENTITY: changedIdentity });
  unchanged(withoutReceipt, withoutReceiptBefore); assert(!fs.existsSync(basic.receipt));
  run(basic, 'install.sh', ['a'.repeat(32)]); verifyInstalled(basic, 'a'.repeat(32));
  pass('signed legacy/missing receipts cannot rotate identity and are rebuilt with pinned signing metadata');

  // Build a genuine linker ad-hoc binary to model the existing source-install migration.
  const adhoc = spawnSync('/usr/bin/xcrun', ['swiftc', sourceFile, '-o', basic.host], { encoding: 'utf8', timeout: 120_000 });
  assert.ifError(adhoc.error); assert.equal(adhoc.status, 0, adhoc.stderr);
  const oldReceipt = legacyReceipt();
  oldReceipt.executable_sha256 = crypto.createHash('sha256').update(fs.readFileSync(basic.host)).digest('hex');
  fs.writeFileSync(basic.receipt, JSON.stringify(oldReceipt));
  fs.copyFileSync(basic.host, prebuilt.host);
  fs.writeFileSync(prebuilt.receipt, JSON.stringify({ ...oldReceipt, path: prebuilt.host }));
  const prebuiltMigration = installPrebuilt();
  assert.match(prebuiltMigration.stdout, /Installed the verified prebuilt executable/);
  verifyInstalled(prebuilt, expectedID, '');
  assert.deepEqual(fs.readFileSync(prebuilt.host), fs.readFileSync(prebuiltHost));
  pass('prebuilt migration from an old ad-hoc host does not mistake the payload certificate for an existing signer');
  const adhocBefore = snapshot(installedFiles);
  run(basic, 'install.sh', ['a'.repeat(32)], false, { IKI_SIGNING_IDENTITY: undefined, IKI_SIGNING_KEYCHAIN: undefined });
  unchanged(installedFiles, adhocBefore);
  calls(basic, true);
  const migratedAdhoc = run(basic, 'install.sh', ['a'.repeat(32)]);
  assert(!/Reused the unchanged/.test(migratedAdhoc.stdout));
  assert(calls(basic).some(args => args.includes('--sign')), 'Ad-hoc migration must sign despite matching source and executable hashes');
  verifyInstalled(basic, 'a'.repeat(32));
  pass('matching ad-hoc source/hash receipt cannot bypass the initial signing migration');

  const beforePublishFailure = snapshot(installedFiles);
  const sourceBeforePublishFailure = fs.readFileSync(sourceFile);
  const publishReceipt = 'mv -f -- "$build_dir/install-receipt.json" "$receipt_path"';
  assert(installerText.includes(publishReceipt));
  fs.writeFileSync(installer, installerText.replace(publishReceipt, 'false # Injected receipt publication failure.'));
  fs.appendFileSync(path.join(basic.source, 'native/main.swift'), '\n// Force a rebuild for publication failure.\n');
  run(basic, 'install.sh', ['b'.repeat(32)], false);
  unchanged(installedFiles, beforePublishFailure);
  verifyInstalled(basic, 'a'.repeat(32));
  fs.writeFileSync(installer, installerText);
  fs.writeFileSync(sourceFile, sourceBeforePublishFailure);
  pass('receipt publication failure with a changed extension ID restores host, receipt and both registrations byte-for-byte with original mtime');

  const beforeManifestFailure = snapshot(installedFiles);
  const publishManifest = 'mv -f -- "$manifest_temp" "$directory/$host_name.json"';
  assert(installerText.includes(publishManifest));
  fs.writeFileSync(installer, installerText.replace(publishManifest,
    'if [[ "$published_manifests" == 1 ]]; then echo "Injected second registration publication failure." >&2; false; else '
    + publishManifest + '; fi'));
  calls(basic, true);
  const partialPublication = run(basic, 'install.sh', ['b'.repeat(32)], false);
  assert.match(partialPublication.stderr, /Injected second registration publication failure/);
  assert(!calls(basic).some(args => args.includes('--sign')), 'Partial registration rollback must use the unchanged signed host');
  unchanged(installedFiles, beforeManifestFailure);
  verifyInstalled(basic, 'a'.repeat(32));
  fs.writeFileSync(installer, installerText);
  pass('second registration publication failure during reuse restores the first registration and preserves all installed bytes and mtime');
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
  console.log(`PASS: ${passes.length} installer checks (${realSigning ? 'real existing signer' : 'synthetic codesign protocol only'}); real user registrations and clipboard were never accessed.`);
} finally {
  fs.rmSync(root, { recursive: true });
}
