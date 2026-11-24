import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir, stat, symlink } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign, constants } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const repository = 'https://github.com/supreme12343/allen-toolbox';
const api = 'https://api.github.com/repos/supreme12343/allen-toolbox/releases/latest';
const windows = process.platform === 'win32';
const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const runtime = { skip: windows ? false : 'Windows PowerShell 5.1/.NET Framework integration test' };
const sources = Object.fromEntries(await Promise.all(['updater.ps1', 'install.ps1', 'native-host.cs'].map(async (name) => [name, await readFile(new URL('../updater/' + name, import.meta.url), 'utf8')])));
const launcher = await readFile(new URL('../Install-ALLEN-Toolbox.cmd', import.meta.url), 'utf8');
const psString = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const hash = (value) => createHash('sha256').update(value).digest('hex');

function extensionId(path) {
  const canonical = resolve(path).replace(/[\\/]+$/, '').replace(/^[a-z]:/, (drive) => drive.toUpperCase());
  const bytes = createHash('sha256').update(Buffer.from(canonical, 'utf16le')).digest().subarray(0, 16);
  return [...bytes].map((value) => String.fromCharCode(97 + (value >> 4), 97 + (value & 15))).join('');
}

const crcTable = Array.from({ length: 256 }, (_, byte) => {
  for (let i = 0; i < 8; i++) byte = (byte & 1) ? (byte >>> 1) ^ 0xedb88320 : byte >>> 1;
  return byte >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

// Deliberately bypass the production ZIP writer's safe-path checks to test hostile ZIPs.
function rawZip(entries) {
  const locals = [], directory = [];
  let offset = 0;
  for (const { path, data = '', attributes = 0, size, flags = 0x0800, method = 0 } of entries) {
    const name = Buffer.from(path, 'utf8'), bytes = Buffer.from(data), crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(size ?? bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, bytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(size ?? bytes.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(attributes >>> 0, 38); central.writeUInt32LE(offset, 42);
    directory.push(central, name); offset += local.length + name.length + bytes.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

function extensionFiles(version) {
  const files = new Map([
    ['manifest.json', JSON.stringify({ manifest_version: 3, name: 'ALLEN Toolbox', version, homepage_url: repository,
      background: { service_worker: 'background.js', type: 'module' }, icons: { 16: 'icons/icon16.png' },
      action: { default_popup: 'popup/popup.html', default_icon: { 16: 'icons/icon16.png' } },
      content_scripts: [{ matches: ['https://example.test/*'], js: ['content/content.js'] }], sandbox: { pages: ['sandbox/check.html'] } })],
    ['background.js', "import './shared/version.js';\n"], ['shared/version.js', 'export const fixture = true;\n'],
    ['offscreen.html', '<script type="module" src="offscreen.js"></script>'], ['offscreen.js', "import './shared/version.js';\n"],
    ['popup/popup.html', '<link rel="stylesheet" href="popup.css"><script src="popup.js"></script>'],
    ['popup/popup.js', "import '../shared/version.js';\n"], ['popup/popup.css', 'body { background-image: url(../icons/icon16.png); }'],
    ['content/content.js', 'void 0;\n'], ['sandbox/check.html', '<script src="check.js"></script>'], ['sandbox/check.js', 'void 0;\n'],
    ['icons/icon16.png', 'fixture-icon'], ['plugins/plugins.json', '[]'],
    ['scripts/scripts.json', '[{"id":"fixture-seed","file":"seed.user.js","enabled":true}]'], ['scripts/seed.user.js', '// Fixture only\n'],
  ]);
  files.set('shared/package.js', 'export const EXTENSION_ASSETS = Object.freeze(' + JSON.stringify([...files.keys(), 'shared/package.js']) + ');\n');
  return files;
}

async function withFixture(work) {
  // No private release key is generated or persisted. This key pair exists in memory for tests only.
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const key = { algorithm: 'RSA-SHA256', modulus: Buffer.from(jwk.n, 'base64url').toString('base64'), exponent: Buffer.from(jwk.e, 'base64url').toString('base64') };
  const temporaryBase = join(process.env.LOCALAPPDATA, 'Temp', 'kilo');
  assert.ok((await stat(temporaryBase)).isDirectory(), 'Fixtures must stay in the preapproved Kilo temp directory');
  const directory = await mkdtemp(join(temporaryBase, 'native-updater-test-'));
  const helper = join(directory, 'updater'), extension = join(directory, 'extension');
  try {
    await mkdir(helper); await mkdir(extension);
    for (const [name, content] of Object.entries(sources)) await writeFile(join(helper, name), content);
    await writeFile(join(helper, 'public-key.json'), JSON.stringify(key));
    const config = { protocol: 1, owner: 'ALLEN Toolbox', repository, helperDirectory: helper, extensionDirectory: extension,
      extensionId: extensionId(extension), publicKeyFingerprint: hash('RSA-SHA256\n' + key.modulus + '\n' + key.exponent),
      installedVersion: '2.1.0', installedAt: Date.now(), taskName: 'ALLEN Toolbox Test-Not-Registered', disabled: false };
    await writeFile(join(helper, 'installation.json'), JSON.stringify(config));
    for (const [name, content] of extensionFiles('2.1.0')) {
      const target = join(extension, name);
      await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, content);
    }
    await writeFile(join(extension, 'local-notes.txt'), 'User fixture data must survive in the retained backup.');
    const entries = [...extensionFiles('2.2.0')].map(([path, data]) => ({ path: 'allen-toolbox/' + path, data }));
    entries.push(...Object.entries(sources).map(([path, data]) => ({ path: 'updater/' + path, data })));
    entries.push({ path: 'updater/public-key.json', data: JSON.stringify(key) }, { path: 'Install-ALLEN-Toolbox.cmd', data: launcher });
    const zip = rawZip(entries), signature = sign('sha256', zip, { key: privateKey, padding: constants.RSA_PKCS1_PADDING });
    await writeFile(join(helper, 'release.zip'), zip); await writeFile(join(helper, 'release.zip.sig'), signature);
    const filename = 'ALLEN-Toolbox-2.2.0.zip', tag = 'v2.2.0';
    const metadata = { draft: false, prerelease: false, tag_name: tag, html_url: repository + '/releases/tag/' + tag,
      assets: [{ name: filename, size: zip.length, state: 'uploaded', browser_download_url: repository + '/releases/download/' + tag + '/' + filename },
        { name: filename + '.sig', size: signature.length, state: 'uploaded', browser_download_url: repository + '/releases/download/' + tag + '/' + filename + '.sig' }] };
    await writeFile(join(helper, 'metadata.json'), JSON.stringify(metadata));
    await work({ directory, helper, extension, config, zip, signature, metadata, entries, key, privateKey });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function encodedArguments(code) {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')];
}
function prelude(fixture) {
  return `
    $ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
    . ${psString(join(root, 'updater', 'updater.ps1'))}
    . ${psString(join(root, 'updater', 'install.ps1'))}
    $fixture = ${psString(fixture.directory)}; $helper = ${psString(fixture.helper)}; $extension = ${psString(fixture.extension)}
    $config = Get-AllenInstallation $helper
    function Assert-Case([bool]$Condition, [string]$Message) { if (-not $Condition) { throw ('fixture assertion: ' + $Message) } }
    function Reject-Case([scriptblock]$Work, [string]$Expected) {
      try { & $Work | Out-Null } catch { Assert-Case ($_.Exception.Message -eq $Expected) ('Expected ' + $Expected + ', got ' + $_.Exception.Message); return }
      throw ('fixture assertion: expected rejection ' + $Expected)
    }
  `;
}
function runPowerShell(fixture, code, { timeout = 30000 } = {}) {
  const result = spawnSync(powershell, encodedArguments(prelude(fixture) + '\n' + code), { cwd: fixture.directory, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
  return result.stdout.trim();
}
const mockRelease = `
  $script:fixtureRelease = ConvertTo-AllenRelease (Read-AllenJson (Join-Path $helper 'metadata.json'))
  function Get-AllenRelease { return $script:fixtureRelease }
  function Get-AllenHttpBytes($Url, $Limit, $TimeoutSeconds, $AssetUrl) {
    if ($Url -ceq $script:fixtureRelease.ZipUrl) { return ,(Read-AllenBytes (Join-Path $helper 'release.zip') 64MB) }
    if ($Url -ceq $script:fixtureRelease.SignatureUrl) { return ,(Read-AllenBytes (Join-Path $helper 'release.zip.sig') 8KB) }
    throw 'fixture unexpected network URL'
  }
`;

test('helper source fixes the repository, protocol, approval default and per-process policy', () => {
  assert.match(sources['updater.ps1'], /AllenRepository = 'https:\/\/github\.com\/supreme12343\/allen-toolbox'/);
  assert.match(sources['native-host.cs'], /Repository = "https:\/\/github\.com\/supreme12343\/allen-toolbox"/);
  assert.match(sources['native-host.cs'], /InputLimit = 64 \* 1024/);
  assert.match(sources['native-host.cs'], /OutputLimit = 1024 \* 1024/);
  assert.match(sources['native-host.cs'], /ProcessTimeoutMilliseconds = 180000/);
  assert.match(sources['install.ps1'], /MessageBoxDefaultButton\]::Button2/);
  assert.match(sources['install.ps1'], /return \$answer -ceq \$word/);
  assert.match(sources['install.ps1'], /if \(-not \(Request-AllenConsent \$plan \$UseConsole\)\)/);
  assert.match(sources['install.ps1'], /Load unpacked ONCE/);
  assert.match(sources['install.ps1'], /LogonType Interactive -RunLevel Limited/);
  assert.match(sources['install.ps1'], /RepetitionInterval \(New-TimeSpan -Hours 1\)/);
  const parameterBlock = sources['install.ps1'].slice(0, sources['install.ps1'].indexOf('$script:AllenInstallerDirectory'));
  assert.doesNotMatch(parameterBlock, /\$(?:Silent|Yes|Force|NoConfirm|Accept|Elevate)\b/i);
  assert.doesNotMatch(Object.values(sources).join('\n') + launcher, /Set-ExecutionPolicy|ExecutionPolicy\s+Unrestricted|Start-Process|runas|--load-extension|DeleteSubKeyTree|Chrome\\Preferences/i);
  assert.match(launcher, /-NoLogo -NoProfile -ExecutionPolicy Bypass -File/);
});

test('dot-sourcing is inert and explicit console approval rejects Enter and lowercase answers', runtime, async () => withFixture(async (f) => {
  const before = await readdir(f.helper);
  runPowerShell(f, `
    $plan = [pscustomobject]@{ Root = $fixture; Helper = $helper; Extension = $extension; Source = $extension; Attach = $true; Uninstall = $false; Config = $config }
    $script:testPlan = $plan
    function Get-AllenInstallPlan { return $script:testPlan }
    function Assert-AllenInstallSlots { throw 'fixture mutation reached' }
    function Request-AllenConsent { return $false }
    $result = Invoke-AllenInstaller
    Assert-Case ($result.cancelled -and -not $result.installed) 'cancel must not reach mutations'
    $plan.Uninstall = $true
    function Unregister-AllenTask { throw 'fixture mutation reached' }
    function Unregister-AllenNativeHost { throw 'fixture mutation reached' }
    $result = Invoke-AllenInstaller '' '' $false $true
    Assert-Case ($result.cancelled -and -not $result.uninstalled) 'cancelled uninstall must not reach mutations'
    $plan.Uninstall = $false
    $consolePrompt = [scriptblock]::Create(${psString(sources['install.ps1'].match(/function Request-AllenConsent[\s\S]*?\n}\n/)[0])})
    . $consolePrompt
    function Write-Host { }
    function Read-Host { return '' }
    Assert-Case (-not (Request-AllenConsent $plan $true)) 'Enter cancels'
    function Read-Host { return 'install' }
    Assert-Case (-not (Request-AllenConsent $plan $true)) 'lowercase cancels'
    function Read-Host { return 'INSTALL' }
    Assert-Case (Request-AllenConsent $plan $true) 'exact INSTALL is explicit approval'
    $plan.Uninstall = $true
    Assert-Case (-not (Request-AllenConsent $plan $true)) 'INSTALL cannot approve uninstall'
    function Read-Host { return 'UNINSTALL' }
    Assert-Case (Request-AllenConsent $plan $true) 'exact UNINSTALL is explicit approval'
  `);
  assert.deepEqual(await readdir(f.helper), before);
}));

test('Windows path IDs, Chrome numeric versions, profile boundaries and reparse protection', runtime, async () => withFixture(async (f) => {
  const junction = join(f.directory, 'junction'), junctionTarget = join(f.directory, 'junction-target');
  await mkdir(junctionTarget); await symlink(junctionTarget, junction, 'junction');
  runPowerShell(f, `
    Assert-Case ((Get-AllenExtensionId $extension) -ceq ${psString(f.config.extensionId)}) 'Chromium UTF16LE path ID'
    Assert-Case ((Get-AllenExtensionId ($extension.Substring(0,1).ToLowerInvariant() + $extension.Substring(1) + '\\')) -ceq $config.extensionId) 'drive normalization and trailing slash'
    Assert-Case ((Compare-AllenVersions '2.1' '2.1.0') -eq 0) 'zero padding'
    Assert-Case ((Compare-AllenVersions '2.2.0' '2.1.65535') -gt 0) 'numeric order'
    foreach ($version in @('0', '0.0.0', '01.2', '1.65536', '1.2.3.4.5', '2.2.0-beta', '-1', '1..2', '1.0 ')) { Reject-Case { Get-AllenVersionParts $version } 'release-invalid' }
    foreach ($path in @('C:\\Windows\\ALLENToolbox', $env:USERPROFILE, (Join-Path $env:USERPROFILE 'AppData\\Local\\Google\\Chrome\\User Data\\Default'), ${psString(junction)})) { Reject-Case { Assert-AllenUserDirectory $path } 'installation-invalid' }
    [void](Test-AllenExtension $extension '2.1.0')
    [IO.File]::WriteAllText((Join-Path $extension 'background.js'), "import './shared/missing.js';")
    Reject-Case { Test-AllenExtension $extension } 'package-invalid'
    [IO.File]::WriteAllText((Join-Path $extension 'background.js'), "import './shared/version.js';")
    [IO.File]::Delete((Join-Path $extension 'shared/version.js'))
    Reject-Case { Test-AllenExtension $extension } 'package-invalid'
  `);
}));

test('stable official release metadata rejects foreign repos, drafts, aliases, versions and oversized assets', runtime, async () => withFixture(async (f) => {
  runPowerShell(f, `
    $metadata = Read-AllenJson (Join-Path $helper 'metadata.json')
    $release = ConvertTo-AllenRelease $metadata
    Assert-Case ($release.Version -ceq '2.2.0') 'version'
    $metadata.draft = $true; Reject-Case { ConvertTo-AllenRelease $metadata } 'release-invalid'; $metadata.draft = $false
    $metadata.prerelease = $true; Reject-Case { ConvertTo-AllenRelease $metadata } 'release-invalid'; $metadata.prerelease = $false
    $metadata.html_url = 'https://github.com/attacker/repo/releases/tag/v2.2.0'; Reject-Case { ConvertTo-AllenRelease $metadata } 'release-invalid'
    $metadata = Read-AllenJson (Join-Path $helper 'metadata.json')
    $metadata.assets[0].browser_download_url = 'https://github.com/attacker/repo/releases/download/v2.2.0/ALLEN-Toolbox-2.2.0.zip'; Reject-Case { ConvertTo-AllenRelease $metadata } 'release-invalid'
    $metadata = Read-AllenJson (Join-Path $helper 'metadata.json')
    $metadata.assets += $metadata.assets[0]; Reject-Case { ConvertTo-AllenRelease $metadata } 'release-invalid'
    $metadata = Read-AllenJson (Join-Path $helper 'metadata.json')
    $metadata.assets[0].size = 64MB + 1; Reject-Case { ConvertTo-AllenRelease $metadata } 'download-too-large'
    Reject-Case { Assert-AllenNetworkUri ([Uri]'https://api.github.com/repos/attacker/repo/releases/latest') } 'release-invalid'
    Reject-Case { Assert-AllenNetworkUri ([Uri]'https://user:password@release-assets.githubusercontent.com/file') $release.ZipUrl } 'release-invalid'
    Reject-Case { Assert-AllenNetworkUri ([Uri]'http://release-assets.githubusercontent.com/file') $release.ZipUrl } 'release-invalid'
    Reject-Case { Get-AllenHttpBytes ${psString(api)} 1MB 0 } 'release-invalid'
    Reject-Case { Get-AllenHttpBytes ${psString(api)} (64MB + 1) 1 } 'release-invalid'
  `);
}));

test('mocked HTTP enforces declared/streaming sizes, total timeout, redirect trust and omitted credentials', runtime, async () => withFixture(async (f) => {
  runPowerShell(f, `
    $script:delayResponse = $false; $script:requestCount = 0
    $script:body = [Text.Encoding]::UTF8.GetBytes('12345678')
    $script:mockResponse = [pscustomobject]@{ StatusCode = 200; ContentLength = [long]-1; Headers = @{} }
    $script:mockResponse | Add-Member ScriptMethod GetResponseStream { return New-Object IO.MemoryStream(,$script:body) }
    $script:mockResponse | Add-Member ScriptMethod Dispose { }
    function New-AllenHttpRequest($Uri) {
      $script:requestCount++
      $request = [pscustomobject]@{ Method = ''; AllowAutoRedirect = $true; Credentials = 'ambient'; UseDefaultCredentials = $true; PreAuthenticate = $true; Proxy = 'ambient'; Timeout = 0; ReadWriteTimeout = 0; CheckCertificateRevocationList = $false; UserAgent = ''; Accept = '' }
      $request | Add-Member ScriptMethod GetResponse { if ($script:delayResponse) { Start-Sleep -Milliseconds 1100 }; return $script:mockResponse }
      $request | Add-Member ScriptMethod Abort { }
      $script:lastRequest = $request
      return $request
    }
    $bytes = Get-AllenHttpBytes ${psString(api)} 8 5
    Assert-Case ($bytes.Length -eq 8) 'bounded body'
    Assert-Case ($null -eq $script:lastRequest.Credentials -and $null -eq $script:lastRequest.Proxy -and -not $script:lastRequest.UseDefaultCredentials -and -not $script:lastRequest.PreAuthenticate) 'no credentials'
    $script:mockResponse.ContentLength = 9
    Reject-Case { Get-AllenHttpBytes ${psString(api)} 8 5 } 'download-too-large'
    $script:mockResponse.ContentLength = -1; $script:body = [Text.Encoding]::UTF8.GetBytes('123456789')
    Reject-Case { Get-AllenHttpBytes ${psString(api)} 8 5 } 'download-too-large'
    $script:delayResponse = $true
    Reject-Case { Get-AllenHttpBytes ${psString(api)} 8 1 } 'network-timeout'
    $script:delayResponse = $false; $script:mockResponse.StatusCode = 302; $script:mockResponse.Headers = @{ Location = 'https://evil.test/payload' }
    $script:requestCount = 0
    $release = ConvertTo-AllenRelease (Read-AllenJson (Join-Path $helper 'metadata.json'))
    Reject-Case { Get-AllenHttpBytes $release.ZipUrl 8 5 $release.ZipUrl } 'release-invalid'
    Assert-Case ($script:requestCount -eq 1) 'foreign redirect is never requested'
    Reject-Case { Get-AllenHttpBytes ${psString(api)} 8 5 } 'release-invalid'
  `);
}));

test('RSA-SHA256 verification rejects changed bytes, missing signatures and replacement pinned keys', runtime, async () => withFixture(async (f) => {
  await writeFile(join(f.helper, 'changed.zip'), Buffer.concat([f.zip.subarray(0, -1), Buffer.from([f.zip.at(-1) ^ 1])]));
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' });
  await writeFile(join(f.helper, 'other-key.json'), JSON.stringify({ algorithm: 'RSA-SHA256', modulus: Buffer.from(other.n, 'base64url').toString('base64'), exponent: Buffer.from(other.e, 'base64url').toString('base64') }));
  runPowerShell(f, `
    $zip = Read-AllenBytes (Join-Path $helper 'release.zip') 64MB; $signature = Read-AllenBytes (Join-Path $helper 'release.zip.sig') 8KB
    Assert-AllenSignature $zip $signature (Join-Path $helper 'public-key.json')
    Reject-Case { Assert-AllenSignature (Read-AllenBytes (Join-Path $helper 'changed.zip') 64MB) $signature (Join-Path $helper 'public-key.json') } 'signature-invalid'
    Reject-Case { Assert-AllenSignature $zip (New-Object byte[] 0) (Join-Path $helper 'public-key.json') } 'signature-invalid'
    Reject-Case { Assert-AllenSignature $zip $signature (Join-Path $helper 'other-key.json') } 'signature-invalid'
    $stage = Join-Path $helper 'replacement-key-stage'; [void][IO.Directory]::CreateDirectory($stage)
    foreach ($file in $script:AllenHelperFiles) { [IO.File]::Copy((Join-Path $helper $file), (Join-Path $stage $file)) }
    [IO.File]::Copy((Join-Path $helper 'other-key.json'), (Join-Path $stage 'public-key.json'), $true)
    Reject-Case { Test-AllenHelperStage $config $stage } 'signature-invalid'
    Reject-Case { Expand-AllenVerifiedArchive ([Text.Encoding]::UTF8.GetBytes('not a ZIP')) $extension $stage } 'archive-invalid'
  `);
}));

test('source copy excludes development/private files and helper cleanup keeps unknown files and browser data', runtime, async () => withFixture(async (f) => {
  await writeFile(join(f.extension, '.env'), 'PRIVATE_FIXTURE_ONLY');
  await mkdir(join(f.extension, 'tools')); await writeFile(join(f.extension, 'tools', 'unused.mjs'), 'PRIVATE_FIXTURE_ONLY');
  await writeFile(join(f.helper, 'user-note.txt'), 'UNKNOWN_FILE_MUST_STAY');
  runPowerShell(f, `
    $copy = Join-Path $fixture 'copied-extension'; [void][IO.Directory]::CreateDirectory($copy)
    Copy-AllenExtension $extension $copy
    Assert-Case ((Get-AllenManifest $copy).version -eq '2.1.0') 'source copy'
    Assert-Case (-not [IO.File]::Exists((Join-Path $copy '.env')) -and -not [IO.Directory]::Exists((Join-Path $copy 'tools'))) 'private/development files excluded'
    Assert-Case ([IO.File]::Exists((Join-Path $extension '.env'))) 'source files not removed'
    $config.disabled = $true
    Write-AllenJsonAtomic (Join-Path $helper 'installation.json') $config
    Reject-Case { Get-AllenInstallation $helper } 'installation-invalid'
    $state = Invoke-AllenUpdater 'update' $false $false $true $helper
    Assert-Case ($state.state -eq 'error' -and $state.error -eq 'installation-invalid') 'disabled helper cannot update'
    [IO.File]::Delete((Join-Path $helper 'public-key.json'))
    [void](Get-AllenInstallation -HelperDirectory $helper -ForUninstall)
    Reject-Case { Get-AllenInstallation $helper } 'installation-invalid'
    Remove-AllenOwnedHelper $config
    Assert-Case ([IO.File]::Exists((Join-Path $helper 'user-note.txt'))) 'unknown helper file preserved'
    Assert-Case ([IO.File]::Exists((Join-Path $extension 'local-notes.txt'))) 'extension data preserved'
    Assert-Case (-not [IO.File]::Exists((Join-Path $helper 'installation.json'))) 'owned helper files removed'
  `);
  assert.equal(await readFile(join(f.helper, 'user-note.txt'), 'utf8'), 'UNKNOWN_FILE_MUST_STAY');
}));

test('signed hostile ZIPs fail preflight before extraction, including case aliases and expansion bombs', runtime, async () => withFixture(async (f) => {
  const cases = [
    [{ path: '../escape.txt' }], [{ path: '/allen-toolbox/manifest.json' }], [{ path: 'C:/escape.txt' }], [{ path: 'allen-toolbox/../escape.txt' }],
    [{ path: 'allen-toolbox\\escape.txt' }], [{ path: 'allen-toolbox//escape.txt' }], [{ path: 'allen-toolbox/NUL.txt' }],
    [{ path: 'allen-toolbox/COM1/file.js' }], [{ path: 'allen-toolbox/conin$.txt' }], [{ path: 'allen-toolbox/file.js.' }],
    [{ path: 'allen-toolbox/file.js ' }], [{ path: 'allen-toolbox/file.js:stream' }], [{ path: 'allen-toolbox/LONGFI~1.js' }],
    [{ path: 'Allen-toolbox/manifest.json' }], [{ path: 'updater/native-host.exe' }], [{ path: 'other/anything' }],
    [{ path: 'allen-toolbox/link', attributes: 0xa1ff0000 }], [{ path: 'allen-toolbox/reparse', attributes: 0x400 }],
    [{ path: 'allen-toolbox/encrypted', flags: 0x0801 }], [{ path: 'allen-toolbox/non-utf8', flags: 0 }], [{ path: 'allen-toolbox/unsupported', method: 12 }],
    [{ path: 'allen-toolbox/manifest.json' }, { path: 'allen-toolbox/manifest.json' }],
    [{ path: 'allen-toolbox/MANIFEST.json' }, { path: 'allen-toolbox/manifest.json' }],
    [{ path: 'allen-toolbox/Folder/one.js' }, { path: 'allen-toolbox/folder/two.js' }],
    [{ path: 'allen-toolbox/a' }, { path: 'allen-toolbox/a/b.js' }],
    [{ path: 'allen-toolbox/huge.js', size: 64 * 1024 * 1024 + 1 }],
    Array.from({ length: 5 }, (_, i) => ({ path: 'allen-toolbox/huge' + i + '.js', size: 64 * 1024 * 1024 })),
  ];
  for (let i = 0; i < cases.length; i++) {
    const zip = rawZip(cases[i]);
    await writeFile(join(f.helper, 'bad-' + i + '.zip'), zip);
    await writeFile(join(f.helper, 'bad-' + i + '.sig'), sign('sha256', zip, { key: f.privateKey, padding: constants.RSA_PKCS1_PADDING }));
  }
  runPowerShell(f, `
    for ($i = 0; $i -lt ${cases.length}; $i++) {
      $zip = Read-AllenBytes (Join-Path $helper ('bad-' + $i + '.zip')) 64MB; $signature = Read-AllenBytes (Join-Path $helper ('bad-' + $i + '.sig')) 8KB
      Assert-AllenSignature $zip $signature (Join-Path $helper 'public-key.json')
      $extStage = Join-Path $fixture ('bad-ext-' + $i); $helperStage = Join-Path $helper ('bad-helper-' + $i)
      [void][IO.Directory]::CreateDirectory($extStage); [void][IO.Directory]::CreateDirectory($helperStage)
      Reject-Case { Expand-AllenVerifiedArchive $zip $extStage $helperStage } 'archive-invalid'
      Assert-Case (-not @([IO.Directory]::EnumerateFileSystemEntries($extStage)).Count -and -not @([IO.Directory]::EnumerateFileSystemEntries($helperStage)).Count) 'preflight must not write archive entries'
    }
  `, { timeout: 60000 });
  assert.equal(await readFile(join(f.extension, 'local-notes.txt'), 'utf8'), 'User fixture data must survive in the retained backup.');
}));

test('busy and browser-running scheduled updates defer without networking or file replacement', runtime, async () => withFixture(async (f) => {
  runPowerShell(f, `
    function Get-AllenRelease { throw 'fixture network must not run' }
    $state = Invoke-AllenUpdater 'update' $true $false $true $helper
    Assert-Case ($state.state -eq 'deferred' -and $state.error -eq 'active-downloads' -and $state.installedVersion -eq '2.1.0') 'busy gate'
    Write-AllenActivity $config $false
    function Get-Process { return [pscustomobject]@{ ProcessName = 'chrome' } }
    $state = Invoke-AllenUpdater 'update' $false $true $false $helper
    Assert-Case ($state.state -eq 'deferred' -and $state.error -eq 'browser-running') 'scheduled browser gate'
    $state = Invoke-AllenUpdater 'update' $false $false $false $helper
    Assert-Case ($state.state -eq 'deferred' -and $state.error -eq 'browser-running') 'non-native CLI is also conservative'
    Assert-Case ((Get-AllenManifest $extension).version -eq '2.1.0') 'no replacement'
  `);
}));

test('signed updates commit actual version, preserve path/ID/key/EXE and retain unexpected user files in backup', runtime, async () => withFixture(async (f) => {
  const executable = join(f.helper, 'ALLEN-Toolbox-NativeHost.exe');
  await writeFile(executable, 'Fixed ABI executable sentinel');
  const keyBefore = await readFile(join(f.helper, 'public-key.json'));
  const output = runPowerShell(f, mockRelease + `
    $state = Invoke-AllenUpdater 'update' $false $false $true $helper
    Assert-Case ($state.state -eq 'updated' -and $state.installedVersion -eq '2.2.0' -and $null -eq $state.availableVersion -and $state.lastUpdatedAt -gt 0) ('actual commit: ' + ($state | ConvertTo-Json -Compress))
    Assert-Case ($state.extensionId -ceq $config.extensionId) 'same extension ID'
    Assert-Case ((Get-AllenManifest $extension).version -eq '2.2.0') 'installed manifest version'
    Assert-Case (-not [IO.File]::Exists((Join-Path $helper 'transaction.json'))) 'transaction finalized'
    $status = Invoke-AllenUpdater 'status' $false $false $true $helper
    Assert-Case ($status.installedVersion -eq '2.2.0' -and $status.lastUpdatedAt -eq $state.lastUpdatedAt) 'machine-readable atomic state'
    ConvertTo-Json -InputObject $state -Compress
  `, { timeout: 60000 });
  const state = JSON.parse(output);
  assert.equal(state.installedVersion, '2.2.0'); assert.equal(state.extensionId, f.config.extensionId);
  assert.deepEqual(await readFile(join(f.helper, 'public-key.json')), keyBefore);
  assert.equal(await readFile(executable, 'utf8'), 'Fixed ABI executable sentinel');
  const backups = (await readdir(f.directory)).filter((name) => name.startsWith('.allen-toolbox-backup-'));
  assert.equal(backups.length, 1);
  assert.equal(JSON.parse(await readFile(join(f.directory, backups[0], 'manifest.json'), 'utf8')).version, '2.1.0');
  assert.equal(await readFile(join(f.directory, backups[0], 'local-notes.txt'), 'utf8'), 'User fixture data must survive in the retained backup.');
  assert.equal(JSON.parse(await readFile(join(f.helper, 'installation.json'), 'utf8')).installedVersion, '2.2.0');
}));

test('late busy heartbeat defers a verified staged release and leaves the old install intact', runtime, async () => withFixture(async (f) => {
  runPowerShell(f, mockRelease + `
    $script:originalFetch = ${'${function:Get-AllenHttpBytes}'}
    function Get-AllenHttpBytes($Url, $Limit, $TimeoutSeconds, $AssetUrl) {
      $bytes = & $script:originalFetch $Url $Limit $TimeoutSeconds $AssetUrl
      Write-AllenActivity $config $true
      return ,$bytes
    }
    $state = Invoke-AllenUpdater 'update' $false $false $true $helper
    Assert-Case ($state.state -eq 'deferred' -and $state.error -eq 'active-downloads' -and $state.availableVersion -eq '2.2.0') 'late heartbeat'
    Assert-Case ((Get-AllenManifest $extension).version -eq '2.1.0') 'old manifest intact'
    Assert-Case (-not @(Get-ChildItem -LiteralPath $fixture -Force | Where-Object Name -Like '.allen-toolbox-*').Count) 'no extension stage or backup left'
    Assert-Case (-not @(Get-ChildItem -LiteralPath $helper -Force | Where-Object Name -Like '.stage-*').Count) 'no helper stage left'
  `);
}));

test('transaction failures roll back helpers, manifest and local user files; crash journals recover safely', runtime, async () => withFixture(async (f) => {
  const before = await readFile(join(f.helper, 'updater.ps1'));
  runPowerShell(f, mockRelease + `
    $script:originalApply = ${'${function:Invoke-AllenApplyRelease}'}
    function Invoke-AllenApplyRelease($Config, $Token, $Version) {
      return & $script:originalApply $Config $Token $Version { throw 'fixture fail after helper replacement' }
    }
    $state = Invoke-AllenUpdater 'update' $false $false $true $helper
    Assert-Case ($state.state -eq 'error' -and $state.error -eq 'transaction-failed' -and $state.installedVersion -eq '2.1.0') ('rollback: ' + ($state | ConvertTo-Json -Compress))
    Assert-Case ([IO.File]::Exists((Join-Path $extension 'local-notes.txt'))) 'local user data restored'
    Assert-Case (-not [IO.File]::Exists((Join-Path $helper 'transaction.json'))) 'rollback finalized'
    $token = [Guid]::NewGuid().ToString('N'); $paths = Get-AllenTransactionPaths $config $token
    [void][IO.Directory]::CreateDirectory($paths.ExtensionStage); [void][IO.Directory]::CreateDirectory($paths.HelperStage)
    Expand-AllenVerifiedArchive (Read-AllenBytes (Join-Path $helper 'release.zip') 64MB) $paths.ExtensionStage $paths.HelperStage
    [void][IO.Directory]::CreateDirectory((Join-Path $paths.HelperStage 'backup'))
    foreach ($file in @('updater.ps1','install.ps1','native-host.cs','installation.json')) { [IO.File]::Copy((Join-Path $helper $file), (Join-Path (Join-Path $paths.HelperStage 'backup') $file)) }
    $journal = [pscustomobject]@{ protocol = 1; token = $token; extensionDirectory = $extension; oldVersion = '2.1.0'; newVersion = '2.2.0'; phase = 'extension-committed'; updatedAt = 0 }
    Write-AllenJsonAtomic (Join-Path $helper 'transaction.json') $journal
    [IO.Directory]::Move($extension, $paths.ExtensionBackup); [IO.Directory]::Move($paths.ExtensionStage, $extension)
    Repair-AllenTransaction $config
    Assert-Case ((Get-AllenManifest $extension).version -eq '2.1.0') 'crash rollback'
    Assert-Case ([IO.File]::Exists((Join-Path $extension 'local-notes.txt'))) 'crash keeps user files'
    $journal.token = '../outside'; Write-AllenJsonAtomic (Join-Path $helper 'transaction.json') $journal
    Reject-Case { Repair-AllenTransaction $config } 'transaction-recovery-required'
    Assert-Case ([IO.File]::Exists((Join-Path $extension 'local-notes.txt'))) 'bad journal cannot delete user files'
  `, { timeout: 60000 });
  assert.deepEqual(await readFile(join(f.helper, 'updater.ps1')), before);
}));

test('cross-process mutex defers a second updater while native heartbeat remains writable', runtime, async () => withFixture(async (f) => {
  const code = prelude(f) + `
    $mutex = New-Object Threading.Mutex($false, (Get-AllenMutexName $config)); [void]$mutex.WaitOne()
    [Console]::WriteLine('fixture-locked'); [Console]::Out.Flush(); [void][Console]::ReadLine()
    $mutex.ReleaseMutex(); $mutex.Dispose()
  `;
  const holder = spawn(powershell, encodedArguments(code), { cwd: f.directory, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  try {
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('Mutex holder failed to start')), 10000);
      let output = '';
      holder.stdout.on('data', (data) => { output += data; if (output.includes('fixture-locked')) { clearTimeout(timer); resolveReady(); } });
      holder.once('error', (error) => { clearTimeout(timer); reject(error); });
      holder.once('exit', (code) => { clearTimeout(timer); reject(new Error('Mutex holder exited early: ' + code)); });
    });
    runPowerShell(f, `
      $state = Invoke-AllenUpdater 'status' $true $false $true $helper
      Assert-Case ($state.state -eq 'deferred' -and $state.error -eq 'update-in-progress') 'cross-process lock'
      $activity = Read-AllenJson (Join-Path $helper 'activity.json')
      Assert-Case $activity.busy 'heartbeat must not block on update lock'
    `);
  } finally {
    holder.stdin.end('\n');
    await new Promise((resolveExit) => { if (holder.exitCode !== null) resolveExit(); else { holder.once('exit', resolveExit); setTimeout(() => { holder.kill(); resolveExit(); }, 5000).unref(); } });
  }
}));

function frame(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length); return Buffer.concat([header, bytes]);
}
function nativeReplies(executable, input, args = []) {
  const result = spawnSync(executable, args, { input, timeout: 20000, maxBuffer: 3 * 1024 * 1024, windowsHide: true });
  assert.ifError(result.error); assert.equal(result.stderr.length, 0, result.stderr.toString());
  const replies = [];
  for (let offset = 0; offset < result.stdout.length;) {
    assert.ok(offset + 4 <= result.stdout.length, 'complete output header');
    const length = result.stdout.readUInt32LE(offset); offset += 4;
    assert.ok(length > 0 && length <= 1024 * 1024 && offset + length <= result.stdout.length, 'bounded complete JSON frame');
    replies.push(JSON.parse(result.stdout.subarray(offset, offset + length).toString('utf8'))); offset += length;
  }
  return replies;
}
function compileNative(f, sourceName = 'native-host.cs', executableName = 'ALLEN-Toolbox-NativeHost.exe') {
  if (sourceName === 'native-host.cs' && executableName === 'ALLEN-Toolbox-NativeHost.exe') runPowerShell(f, 'Compile-AllenNativeHost $helper');
  else runPowerShell(f, `Add-Type -Path (Join-Path $helper ${psString(sourceName)}) -OutputAssembly (Join-Path $helper ${psString(executableName)}) -OutputType ConsoleApplication -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')`);
  return join(f.helper, executableName);
}

test('compiled native host frames multiple replies and rejects protocol, commands, paths, nonboolean busy and foreign callers', runtime, async () => withFixture(async (f) => {
  const executable = compileNative(f), origin = 'chrome-extension://' + f.config.extensionId + '/';
  const requests = [{ protocol: 1, command: 'status', busy: false }, { protocol: 1, command: 'update', busy: true },
    { protocol: 2, command: 'status', busy: false }, { protocol: 1, command: 'status' }, { protocol: 1, command: 'status', busy: 'false' },
    { protocol: 1, command: 'status', busy: false, path: 'C:\\Windows' }, { protocol: 1, command: 'exec', busy: false },
    '{"protocol":1,"command":"update","command":"status","busy":false}',
    '{"protocol":2,"\\u0070rotocol":1,"command":"status","busy":false}',
    '{"protocol":1,"command":\'status\',"busy":false}', Buffer.from([0xff, 0xfe]), '{'];
  const replies = nativeReplies(executable, Buffer.concat(requests.map(frame)), [origin]);
  assert.equal(replies.length, requests.length);
  assert.equal(replies[0].installedVersion, '2.1.0'); assert.equal(replies[0].protocol, 1); assert.equal(replies[0].extensionId, f.config.extensionId);
  assert.equal(replies[1].state, 'deferred'); assert.equal(replies[1].error, 'active-downloads');
  for (const reply of replies.slice(2)) { assert.equal(reply.state, 'error'); assert.equal(reply.error, 'native-input-invalid'); }
  const foreign = nativeReplies(executable, frame(requests[0]), ['chrome-extension://' + 'a'.repeat(32) + '/']);
  assert.equal(foreign[0].error, 'caller-not-allowed');
  const tooLarge = Buffer.alloc(4); tooLarge.writeUInt32LE(64 * 1024 + 1);
  assert.equal(nativeReplies(executable, tooLarge, [origin])[0].error, 'native-input-invalid');
  assert.equal(nativeReplies(executable, Buffer.from([1, 0]), [origin])[0].error, 'native-input-invalid');
  assert.equal(JSON.parse(await readFile(join(f.extension, 'manifest.json'), 'utf8')).version, '2.1.0');
}));

test('native subprocess output is bounded, timeout is finite and success must match the installed manifest', runtime, async () => withFixture(async (f) => {
  const fixtureSource = sources['native-host.cs'].replace('private const int ProcessTimeoutMilliseconds = 180000;', 'private const int ProcessTimeoutMilliseconds = 2000;');
  assert.notEqual(fixtureSource, sources['native-host.cs'], 'Only fixture deadline is shortened, not production code');
  await writeFile(join(f.helper, 'native-host-fixture.cs'), fixtureSource);
  const executable = compileNative(f, 'native-host-fixture.cs', 'NativeHost-Fixture.exe'), origin = 'chrome-extension://' + f.config.extensionId + '/';
  const request = frame({ protocol: 1, command: 'check', busy: false });
  const reply = { protocol: 1, installed: true, installedVersion: '9.9.9', availableVersion: null, state: 'updated', lastCheckedAt: 0, lastUpdatedAt: 0, error: '', extensionId: f.config.extensionId };
  await writeFile(join(f.helper, 'updater.ps1'), `param([string]$Command,[switch]$Busy,[switch]$Native)\n[Console]::WriteLine(${psString(JSON.stringify(reply))})`);
  assert.equal(nativeReplies(executable, request, [origin])[0].error, 'native-output-invalid');
  await writeFile(join(f.helper, 'updater.ps1'), "param([string]$Command,[switch]$Busy,[switch]$Native)\n[Console]::Write(('x' * (1MB + 1)))\n");
  assert.equal(nativeReplies(executable, request, [origin])[0].error, 'native-output-invalid');
  await writeFile(join(f.helper, 'updater.ps1'), 'param([string]$Command,[switch]$Busy,[switch]$Native)\nStart-Sleep -Seconds 10\n');
  const started = Date.now();
  assert.equal(nativeReplies(executable, request, [origin])[0].error, 'native-timeout');
  assert.ok(Date.now() - started < 8000, 'Native helper kills its timed-out child');
}));
