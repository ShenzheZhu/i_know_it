// Publisher-only: reuse an existing signed helper; never compile, sign, or install.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const source = __dirname;
const hostName = 'com.iknowit.bridge';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function run(command, args, cwd = source) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${path.basename(command)} failed: ${result.stderr || result.stdout}`);
  return result.stdout + result.stderr;
}

function main() {
  assert.equal(process.platform, 'darwin', 'Packaging requires macOS and Command Line Tools.');
  assert.equal(process.argv.length, 5, 'Usage: node package.cjs SIGNED_HOST BUILD_RECEIPT OUTPUT.zip');
  const [host, receiptFile, output] = process.argv.slice(2).map(file => path.resolve(file));
  assert.equal(path.extname(output), '.zip', 'The output must end in .zip.');
  assert(!fs.existsSync(output), 'The output already exists; refusing to overwrite it.');
  assert.equal(run('/usr/bin/git', ['rev-parse', '--show-toplevel']).trim(), source, 'Run from a repository root.');
  assert.equal(run('/usr/bin/git', ['status', '--porcelain', '--untracked-files=all']).trim(), '',
    'Commit the reviewed source tree before packaging; untracked files are also rejected.');
  const commit = run('/usr/bin/git', ['rev-parse', 'HEAD']).trim();
  const entries = run('/usr/bin/git', ['ls-tree', '-rz', '--full-tree', commit]).split('\0').filter(Boolean)
    .map(entry => {
      const match = /^(100644|100755) blob [0-9a-f]+\t(.+)$/.exec(entry);
      assert(match, 'Only regular committed files can be packaged.');
      assert(!match[2].startsWith('native/prebuilt/'), 'A generated native payload cannot be committed.');
      assert(!match[2].split('/').includes('..'), 'Invalid source path.');
      return { mode: match[1], name: match[2] };
    });
  for (const name of ['Install.command', 'install.sh', 'uninstall.sh']) {
    assert(entries.some(entry => entry.name === name && entry.mode === '100755'), `${name} must be committed executable.`);
  }
  for (const file of [host, receiptFile]) assert(fs.lstatSync(file).isFile(), 'The helper and receipt must be regular files.');
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  assert.equal(receipt.format, 1, 'Unsupported build receipt format.');
  assert.equal(receipt.name, hostName, 'The receipt describes another host.');
  assert.match(receipt.signing_identity, /^[0-9a-f]{40}$/, 'The receipt needs a certificate SHA-1 fingerprint.');
  assert.equal(typeof receipt.designated_requirement, 'string');
  assert(receipt.designated_requirement.length > 0, 'The receipt needs the default designated requirement.');
  assert.match(receipt.source_sha256, /^[0-9a-f]{64}$/);
  assert.match(receipt.executable_sha256, /^[0-9a-f]{64}$/);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'i-know-it-package-'));
  try {
    const archive = path.join(temp, 'source.tar');
    const bundle = path.join(temp, 'i_know_it');
    run('/usr/bin/git', ['archive', '--format=tar', '--prefix=i_know_it/', `--output=${archive}`, commit]);
    run('/usr/bin/tar', ['-xf', archive, '-C', temp]);
    assert.equal(sha256(fs.readFileSync(path.join(bundle, 'native/main.swift'))), receipt.source_sha256,
      'The helper was built from a different native source.');
    const version = JSON.parse(fs.readFileSync(path.join(bundle, 'manifest.json'), 'utf8')).version;
    assert.match(version, /^[0-9]+(\.[0-9]+){0,3}$/);
    const payload = path.join(bundle, 'native/prebuilt');
    fs.mkdirSync(payload);
    const binary = path.join(payload, 'i-know-it-host');
    fs.copyFileSync(host, binary);
    fs.chmodSync(binary, 0o755);
    assert.equal(sha256(fs.readFileSync(binary)), receipt.executable_sha256, 'The executable hash does not match its receipt.');
    run('/usr/bin/codesign', ['--verify', '--strict', binary]);
    run('/usr/bin/codesign', ['--verify', '--strict', '-R', `=identifier "${hostName}"`, binary]);
    const requirements = run('/usr/bin/codesign', ['--display', '-r-', binary]).split('\n')
      .filter(line => line.startsWith('designated => ')).map(line => line.slice('designated => '.length));
    assert.deepEqual(requirements, [receipt.designated_requirement], 'The default signing requirement does not match its receipt.');
    const certificatePrefix = path.join(temp, 'certificate-');
    run('/usr/bin/codesign', ['--display', `--extract-certificates=${certificatePrefix}`, binary]);
    const fingerprint = crypto.createHash('sha1').update(fs.readFileSync(certificatePrefix + '0')).digest('hex');
    assert.equal(fingerprint, receipt.signing_identity, 'The actual signing certificate does not match its receipt.');
    const architecture = run('/usr/bin/xcrun', ['lipo', '-archs', binary]).trim();
    assert.match(architecture, /^(arm64|x86_64)$/, 'Only single-architecture packages are supported.');
    assert.equal(architecture, receipt.architecture, 'The actual Mach-O architecture does not match its receipt.');
    const buildCommands = run('/usr/bin/xcrun', ['vtool', '-show-build', binary]);
    const platforms = [...buildCommands.matchAll(/^\s*platform\s+(\S+)\s*$/gm)].map(match => match[1]);
    // vtool also reports linker versions; read minos for modern build commands only.
    const minimum = [...buildCommands.matchAll(/^\s*minos\s+(\d{1,3}\.\d{1,3}(?:\.\d{1,3})?)\s*$/gm)].map(match => match[1]);
    assert.deepEqual(platforms, ['MACOS'], 'A single macOS LC_BUILD_VERSION is required.');
    assert.equal(minimum.length, 1, 'The Mach-O minimum macOS version could not be established.');
    assert.equal(typeof receipt.compiler, 'string', 'Missing compiler description.');
    const compilerLines = receipt.compiler.split('\n');
    const compilerVersion = compilerLines.find(line => /^Apple Swift version [0-9A-Za-z .()_-]+$/.test(line));
    const compilerHash = compilerLines.find(line => /^[0-9a-f]{64}$/.test(line));
    assert(compilerVersion && compilerHash, 'The receipt needs a Swift version and compiler SHA-256 without local paths.');
    const build = {
      format: 1, name: hostName, version, source_sha256: receipt.source_sha256,
      executable_sha256: receipt.executable_sha256, signing_identity: fingerprint,
      designated_requirement: requirements[0], compiler: `${compilerVersion}\n${compilerHash}`,
      architecture, minimum_macos: minimum[0],
    };
    fs.writeFileSync(path.join(payload, 'build.json'), JSON.stringify(build, null, 2) + '\n', { mode: 0o644 });
    const zip = path.join(temp, 'package.zip');
    run('/usr/bin/zip', ['-q', '-X', '-r', zip, 'i_know_it'], temp);
    fs.copyFileSync(zip, output, fs.constants.COPYFILE_EXCL);
    console.log(JSON.stringify({ output, commit, version, architecture, minimum_macos: minimum[0],
      sha256: sha256(fs.readFileSync(output)), signing_identity: fingerprint,
      notice: 'This tool preserves the existing signature. It does not establish Developer ID trust or notarize the package.' }, null, 2));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
