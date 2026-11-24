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
const sources = Object.fromEntries(await Promise.all(['updater.ps1', 'install.ps1', 'native-host.cs'].map(async (name) => [name, (await readFile(new URL('../updater/' + name, import.meta.url), 'utf8')).replace(/\r\n/g, '\n')])));
const launcher = await readFile(new URL('../Install-ALLEN-Toolbox.cmd', import.meta.url), 'utf8');
const psString = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const hash = (value) => createHash('sha256').update(value).digest('hex');
const publisherThumbprint = 'A'.repeat(40);
const clientId = '12345678-1234-4234-8234-123456789abc';
const secondClientId = '87654321-4321-4321-8321-cba987654321';
// Deliberately not a PE/executable. Signature APIs are mocked; this is never launched.
const binaryBytes = Buffer.from('INERT SIGNED-BUNDLE FILE FIXTURE, NOT AN EXECUTABLE');
const ownerSid = windows ? (() => {
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'AllSigned', '-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8' });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^S-1-/); return result.stdout.trim();
})() : '';

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
  assert.ok(resolve(temporaryBase).toLowerCase().startsWith(resolve(process.env.USERPROFILE).toLowerCase() + '\\'), 'fixture root must stay under this Windows profile');
  await mkdir(temporaryBase, { recursive: true });
  const directory = await mkdtemp(join(temporaryBase, 'native-updater-test-'));
  const controlledRoot = join(directory, 'ALLENToolbox'), helper = join(controlledRoot, 'updater'), extension = join(directory, 'extension');
  const bundle = join(directory, 'bundle', 'updater');
  try {
    await mkdir(helper, { recursive: true }); await mkdir(extension); await mkdir(bundle, { recursive: true });
    await mkdir(join(controlledRoot, 'locks')); await mkdir(join(controlledRoot, 'activity'));
    const bundleFiles = { 'install.ps1': sources['install.ps1'], 'updater.ps1': sources['updater.ps1'], 'public-key.json': JSON.stringify(key), 'ALLEN-Toolbox-NativeHost.exe': binaryBytes };
    for (const [name, content] of Object.entries(bundleFiles)) { await writeFile(join(helper, name), content); await writeFile(join(bundle, name), content); }
    await writeFile(join(directory, 'managed-source.cs'), sources['native-host.cs']);
    await writeFile(join(directory, 'bundle', 'Install-ALLEN-Toolbox.cmd'), launcher);
    const availability = { protocol: 2, available: true, reason: '', publisherThumbprint, files: { 'Install-ALLEN-Toolbox.cmd': hash(launcher), ...Object.fromEntries(Object.entries(bundleFiles).map(([name, bytes]) => ['updater/' + name, hash(bytes)])) } };
    await writeFile(join(bundle, 'availability.json'), JSON.stringify(availability));
    const config = { protocol: 2, owner: 'ALLEN Toolbox', repository, helperDirectory: helper, extensionDirectory: extension,
      extensionId: extensionId(extension), publicKeyFingerprint: hash('RSA-SHA256\n' + key.modulus + '\n' + key.exponent),
      publisherThumbprint, installationId: '11111111-1111-4111-8111-111111111111', installationState: 'installed',
      publisherTrust: { store: 'CurrentUser\\TrustedPublisher', introduced: false, retainedOnUninstall: true },
      installedVersion: '2.1.0', installedAt: Date.now(), taskName: 'ALLEN Toolbox Updater-' + ownerSid, disabled: false };
    await writeFile(join(helper, 'installation.json'), JSON.stringify(config));
    const ownership = { protocol: 2, owner: 'ALLEN Toolbox', userSid: ownerSid, helperDirectory: helper, installationId: config.installationId, publisherThumbprint };
    await writeFile(join(helper, 'ownership.json'), JSON.stringify(ownership));
    for (const [name, content] of extensionFiles('2.1.0')) {
      const target = join(extension, name);
      await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, content);
    }
    await writeFile(join(extension, 'local-notes.txt'), 'User fixture data must survive in the retained backup.');
    const entries = [...extensionFiles('2.2.0')].map(([path, data]) => ({ path: 'allen-toolbox/' + path, data }));
    entries.push(...Object.entries(bundleFiles).map(([path, data]) => ({ path: 'updater/' + path, data })));
    entries.push({ path: 'updater/availability.json', data: JSON.stringify(availability) }, { path: 'Install-ALLEN-Toolbox.cmd', data: launcher });
    const zip = rawZip(entries), signature = sign('sha256', zip, { key: privateKey, padding: constants.RSA_PKCS1_PADDING });
    await writeFile(join(helper, 'release.zip'), zip); await writeFile(join(helper, 'release.zip.sig'), signature);
    const filename = 'ALLEN-Toolbox-2.2.0.zip', tag = 'v2.2.0';
    const metadata = { draft: false, prerelease: false, tag_name: tag, html_url: repository + '/releases/tag/' + tag,
      assets: [{ name: filename, size: zip.length, state: 'uploaded', browser_download_url: repository + '/releases/download/' + tag + '/' + filename },
        { name: filename + '.sig', size: signature.length, state: 'uploaded', browser_download_url: repository + '/releases/download/' + tag + '/' + filename + '.sig' }] };
    await writeFile(join(helper, 'metadata.json'), JSON.stringify(metadata));
    // Elevated runners default new objects to the Administrators owner. Fixtures
    // explicitly model the per-user ownership enforced by the real installer.
    const ownershipScript = `$ErrorActionPreference='Stop'; $root=${psString(directory)};
if(-not $root.StartsWith($env:USERPROFILE+'\\',[StringComparison]::OrdinalIgnoreCase)){throw 'fixture ownership escaped its user profile'};
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
$queue=New-Object 'Collections.Generic.Queue[string]'; $queue.Enqueue($root);
while($queue.Count){$path=$queue.Dequeue();$attributes=[IO.File]::GetAttributes($path);
if($attributes -band [IO.FileAttributes]::ReparsePoint){throw 'fixture ownership must not follow links'};
if($attributes -band [IO.FileAttributes]::Directory){
$security=New-Object Security.AccessControl.DirectorySecurity; $security.SetOwner($sid);$security.SetAccessRuleProtection($true,$false);
$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);$security.AddAccessRule($rule);[IO.Directory]::SetAccessControl($path,$security);
foreach($child in [IO.Directory]::EnumerateFileSystemEntries($path)){$queue.Enqueue($child)}
}else{$security=New-Object Security.AccessControl.FileSecurity;$security.SetOwner($sid);$security.SetAccessRuleProtection($true,$false);$security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow)));[IO.File]::SetAccessControl($path,$security)}}`;
    const ownershipResult = spawnSync(powershell, powershellArguments(ownershipScript), { encoding: 'utf8', timeout: 30000 });
    assert.ifError(ownershipResult.error); assert.equal(ownershipResult.status, 0, ownershipResult.stderr);
    await work({ directory, controlledRoot, helper, extension, bundle, config, zip, signature, metadata, entries, key, privateKey, availability });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function powershellArguments(code) {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'AllSigned', '-Command', code];
}
function prelude(fixture) {
  return `
    $ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
    $fixture = ${psString(fixture.directory)}; $helper = ${psString(fixture.helper)}; $extension = ${psString(fixture.extension)}
    $bundle = ${psString(fixture.bundle)}; $env:LOCALAPPDATA = $fixture; $env:TEMP = $fixture; $env:TMP = $fixture
    $usages = New-Object Security.Cryptography.OidCollection
    [void]$usages.Add((New-Object Security.Cryptography.Oid '1.3.6.1.5.5.7.3.3'))
    $eku = New-Object Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension($usages, $false)
    $script:fixtureCertificate = [pscustomobject]@{ Thumbprint = ${psString(publisherThumbprint)}; NotBefore = [DateTime]::UtcNow.AddDays(-1); NotAfter = [DateTime]::UtcNow.AddDays(1); Extensions = @($eku) }
    $script:signatureStatus = 'Valid'; $script:foreignSignature = ''
    function Get-AuthenticodeSignature($LiteralPath) {
      if (-not $LiteralPath.StartsWith($fixture + '\\', [StringComparison]::OrdinalIgnoreCase)) { throw 'fixture signature path outside approved fixture' }
      $certificate = $script:fixtureCertificate.PSObject.Copy()
      if ($script:foreignSignature -and $LiteralPath.EndsWith($script:foreignSignature, [StringComparison]::OrdinalIgnoreCase)) { $certificate.Thumbprint = 'B' * 40 }
      return [pscustomobject]@{ Status = $script:signatureStatus; SignerCertificate = $certificate }
    }
    # Dot-source parsed fixture functions, not unsigned script entrypoints. AllSigned stays active.
    function Import-AllenFixtureFunctions([string]$Path, [bool]$Constants = $false) {
      $tokens = $null; $errors = $null
      $ast = [Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
      if ($errors.Count) { throw ($errors | Out-String) }
      foreach ($statement in $ast.EndBlock.Statements) {
        if ($statement -is [Management.Automation.Language.FunctionDefinitionAst] -or ($Constants -and $statement -is [Management.Automation.Language.AssignmentStatementAst])) { . ([scriptblock]::Create($statement.Extent.Text)) }
      }
    }
    . Import-AllenFixtureFunctions (Join-Path $bundle 'updater.ps1') $true
    . Import-AllenFixtureFunctions (Join-Path $bundle 'install.ps1')
    $script:AllenUpdaterDirectory = $helper; $script:AllenInstallerDirectory = $bundle
    $script:AllenNativeHostName = 'com.supreme.allen_toolbox_updater_v2'
    $script:AllenInstallerPublisher = Get-AllenInstallerPublisher $bundle
    function Get-Process { return @() }
    function Test-AllenPublisherTrusted { return $true }
    function Assert-AllenInstallSlots { throw 'fixture unexpected registration query' }
    function Register-AllenNativeHost { throw 'fixture unexpected registration mutation' }
    function Unregister-AllenNativeHost { throw 'fixture unexpected registration mutation' }
    function Register-AllenTask { throw 'fixture unexpected task mutation' }
    function Unregister-AllenTask { throw 'fixture unexpected task mutation' }
    try { $config = Get-AllenInstallation $helper } catch {
      $record = Read-AllenJson (Join-Path $helper 'installation.json')
      [Console]::Error.WriteLine((@{ fixture = $fixture; profile = $env:USERPROFILE; user = Get-AllenCurrentUserSid;
        rootOwner = [IO.Directory]::GetAccessControl((Get-AllenControlledRoot)).GetOwner([Security.Principal.SecurityIdentifier]).Value;
        helperOwner = [IO.Directory]::GetAccessControl($helper).GetOwner([Security.Principal.SecurityIdentifier]).Value;
        protocolType = $record.protocol.GetType().FullName } | ConvertTo-Json -Compress))
      throw
    }
    $client = ${psString(clientId)}; $otherClient = ${psString(secondClientId)}
    function Assert-Case([bool]$Condition, [string]$Message) { if (-not $Condition) { throw ('fixture assertion: ' + $Message) } }
    function Reject-Case([scriptblock]$Work, [string]$Expected) {
      try { & $Work | Out-Null } catch { Assert-Case ($_.Exception.Message -eq $Expected) ('Expected ' + $Expected + ', got ' + $_.Exception.Message); return }
      throw ('fixture assertion: expected rejection ' + $Expected)
    }
  `;
}
function runPowerShell(fixture, code, { timeout = 30000 } = {}) {
  const result = spawnSync(powershell, powershellArguments(prelude(fixture) + '\n' + code), { cwd: fixture.directory, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
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
const mockInstallation = `
  $script:fixtureApproved = $false; $script:fixtureTrusted = $true
  $script:fixtureNativeRegistrations = 0; $script:fixtureTaskRegistrations = 0; $script:fixturePublisherAdds = 0
  function Request-AllenConsent { return $script:fixtureApproved }
  function Assert-AllenInstallSlots { }
  function Register-AllenNativeHost { Assert-Case $script:fixtureApproved 'registration needs explicit approval'; $script:fixtureNativeRegistrations++ }
  function Register-AllenTask { Assert-Case $script:fixtureApproved 'task needs explicit approval'; $script:fixtureTaskRegistrations++ }
  function Unregister-AllenNativeHost { Assert-Case $script:fixtureApproved 'unregister needs explicit approval' }
  function Unregister-AllenTask { Assert-Case $script:fixtureApproved 'task removal needs explicit approval' }
  function Test-AllenPublisherTrusted { return $script:fixtureTrusted }
  function Add-AllenVerifiedPublisher {
    Assert-Case $script:fixtureApproved 'publisher addition needs explicit approval'
    $script:fixturePublisherAdds++; $script:fixtureTrusted = $true; return $true
  }
`;
const prepareCrashJournal = `
  $token = [Guid]::NewGuid().ToString('N'); $paths = Get-AllenTransactionPaths $config $token
  [void][IO.Directory]::CreateDirectory($paths.ExtensionStage); [void][IO.Directory]::CreateDirectory($paths.HelperStage)
  Expand-AllenVerifiedArchive (Read-AllenBytes (Join-Path $helper 'release.zip') 64MB) $paths.ExtensionStage $paths.HelperStage
  [void][IO.Directory]::CreateDirectory((Join-Path $paths.HelperStage 'backup'))
  foreach ($file in @('updater.ps1', 'install.ps1', 'installation.json')) { [IO.File]::Copy((Join-Path $helper $file), (Join-Path (Join-Path $paths.HelperStage 'backup') $file)) }
  $journal = [pscustomobject]@{ protocol = 2; token = $token; installationId = $config.installationId; publisherThumbprint = $config.publisherThumbprint; extensionDirectory = $extension; oldVersion = '2.1.0'; newVersion = '2.2.0'; phase = 'old-moved'; updatedAt = 0 }
  Write-AllenJsonAtomic (Join-Path $helper 'transaction.json') $journal
  [IO.Directory]::Move($extension, $paths.ExtensionBackup)
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
  assert.doesNotMatch(Object.values(sources).join('\n') + launcher, /Set-ExecutionPolicy|ExecutionPolicy\s+(Bypass|Unrestricted)|Start-Process|CreateNoWindow|runas|--load-extension|DeleteSubKeyTree|Chrome\\Preferences/i);
  assert.doesNotMatch(sources['install.ps1'], /Compile-AllenNativeHost|CodeDom|GenerateExecutable|Add-Type -Path/);
  assert.match(launcher, /-NoLogo -NoProfile -ExecutionPolicy AllSigned -File/);
  assert.match(sources['install.ps1'], /com\.supreme\.allen_toolbox_updater_v2/);
  assert.match(sources['native-host.cs'], /WinVerifyTrust/);
  assert.ok(sources['install.ps1'].indexOf('$script:AllenInstallerPublisher = Get-AllenInstallerPublisher') < sources['install.ps1'].indexOf(". (Join-Path $PSScriptRoot 'updater.ps1')"));
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
    foreach ($path in @('C:\\Windows\\ALLENToolbox', $env:USERPROFILE, (Join-Path $env:USERPROFILE 'AppData\\Local\\Google'), (Join-Path $env:USERPROFILE 'AppData\\Local\\Google\\Chrome'), (Join-Path $env:USERPROFILE 'AppData\\Local\\Google\\Chrome\\User Data'), (Join-Path $env:USERPROFILE 'AppData\\Local\\Google\\Chrome\\User Data\\Default'), (Join-Path $env:USERPROFILE 'AppData\\Local\\Microsoft'), (Join-Path $env:USERPROFILE 'AppData\\Local\\BraveSoftware'), ${psString(junction)})) { Reject-Case { Assert-AllenUserDirectory $path } 'installation-invalid' }
    $manifestPath = Join-Path $extension 'manifest.json'; $manifestBytes = Read-AllenBytes $manifestPath
    $manifest = Read-AllenJson $manifestPath; $manifest | Add-Member NoteProperty key 'manifest keys change the path-derived ID'
    Write-AllenJsonAtomic $manifestPath $manifest
    Reject-Case { Test-AllenExtension $extension } 'package-invalid'
    Write-AllenBytesAtomic $manifestPath $manifestBytes
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
    $state = Invoke-AllenUpdater 'update' $false $false $true $helper $client
    Assert-Case ($state.state -eq 'error' -and $state.error -eq 'installation-invalid') 'disabled helper cannot update'
    [IO.File]::Delete((Join-Path $helper 'public-key.json'))
    [void](Get-AllenInstallation -HelperDirectory $helper -ForUninstall)
    Reject-Case { Get-AllenInstallation $helper } 'installation-invalid'
    Remove-AllenOwnedHelper $config
    Assert-Case ([IO.File]::Exists((Join-Path $helper 'user-note.txt'))) 'unknown helper file preserved'
    Assert-Case ([IO.File]::Exists((Join-Path $extension 'local-notes.txt'))) 'extension data preserved'
    Assert-Case ([IO.File]::Exists((Join-Path $helper 'ownership.json')) -and (Get-AllenInstallation $helper -ForUninstall).installationState -eq 'uninstalled') 'disabled ownership stays with unknown files for safe reinstall'
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
    $state = Invoke-AllenUpdater 'update' $true $false $true $helper $client
    Assert-Case ($state.state -eq 'deferred' -and $state.error -eq 'active-downloads' -and $state.installedVersion -eq '2.1.0') 'busy gate'
    Write-AllenActivity $config $false $client
    function Get-Process { return [pscustomobject]@{ ProcessName = 'chrome' } }
    $state = Invoke-AllenUpdater 'update' $false $true $false $helper
    Assert-Case ($state.state -eq 'deferred' -and $state.error -eq 'browser-running') 'scheduled browser gate'
    $state = Invoke-AllenUpdater 'update' $false $false $false $helper
    Assert-Case ($state.state -eq 'deferred' -and $state.error -eq 'browser-running') 'non-native CLI is also conservative'
    $state = Invoke-AllenUpdater 'update' $false $false $true $helper $client
    Assert-Case ($state.state -eq 'deferred' -and $state.error -eq 'browser-running') 'native callers cannot bypass the all-browser safety gate'
    Assert-Case ((Get-AllenManifest $extension).version -eq '2.1.0') 'no replacement'
  `);
}));

test('signed updates commit actual version, preserve path/ID/key/EXE and retain unexpected user files in backup', runtime, async () => withFixture(async (f) => {
  const executable = join(f.helper, 'ALLEN-Toolbox-NativeHost.exe');
  await writeFile(executable, 'Fixed ABI executable sentinel');
  const keyBefore = await readFile(join(f.helper, 'public-key.json'));
  const output = runPowerShell(f, mockRelease + `
    $state = Invoke-AllenUpdater 'update' $false $false $true $helper $client
    Assert-Case ($state.state -eq 'updated' -and $state.installedVersion -eq '2.2.0' -and $null -eq $state.availableVersion -and $state.lastUpdatedAt -gt 0) ('actual commit: ' + ($state | ConvertTo-Json -Compress))
    Assert-Case ($state.extensionId -ceq $config.extensionId) 'same extension ID'
    Assert-Case ((Get-AllenManifest $extension).version -eq '2.2.0') 'installed manifest version'
    Assert-Case (-not [IO.File]::Exists((Join-Path $helper 'transaction.json'))) 'transaction finalized'
    $status = Invoke-AllenUpdater 'status' $false $false $true $helper $client
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
      Write-AllenActivity $config $true $otherClient
      return ,$bytes
    }
    $state = Invoke-AllenUpdater 'update' $false $false $true $helper $client
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
    $state = Invoke-AllenUpdater 'update' $false $false $true $helper $client
    Assert-Case ($state.state -eq 'error' -and $state.error -eq 'transaction-failed' -and $state.installedVersion -eq '2.1.0') ('rollback: ' + ($state | ConvertTo-Json -Compress))
    Assert-Case ([IO.File]::Exists((Join-Path $extension 'local-notes.txt'))) 'local user data restored'
    Assert-Case (-not [IO.File]::Exists((Join-Path $helper 'transaction.json'))) 'rollback finalized'
    $token = [Guid]::NewGuid().ToString('N'); $paths = Get-AllenTransactionPaths $config $token
    [void][IO.Directory]::CreateDirectory($paths.ExtensionStage); [void][IO.Directory]::CreateDirectory($paths.HelperStage)
    Expand-AllenVerifiedArchive (Read-AllenBytes (Join-Path $helper 'release.zip') 64MB) $paths.ExtensionStage $paths.HelperStage
    [void][IO.Directory]::CreateDirectory((Join-Path $paths.HelperStage 'backup'))
    foreach ($file in @('updater.ps1','install.ps1','installation.json')) { [IO.File]::Copy((Join-Path $helper $file), (Join-Path (Join-Path $paths.HelperStage 'backup') $file)) }
    $journal = [pscustomobject]@{ protocol = 2; token = $token; installationId = $config.installationId; publisherThumbprint = $config.publisherThumbprint; extensionDirectory = $extension; oldVersion = '2.1.0'; newVersion = '2.2.0'; phase = 'extension-committed'; updatedAt = 0 }
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

test('user-owned exclusive filesystem lock defers other sessions while client heartbeats stay writable', runtime, async () => withFixture(async (f) => {
  const code = prelude(f) + `
    $lock = Enter-AllenLock $config
    [Console]::WriteLine('fixture-locked'); [Console]::Out.Flush(); [void][Console]::ReadLine()
    $lock.Dispose()
  `;
  const holder = spawn(powershell, powershellArguments(code), { cwd: f.directory, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('Filesystem lock holder failed to start')), 10000);
      let output = '';
      holder.stdout.on('data', (data) => { output += data; if (output.includes('fixture-locked')) { clearTimeout(timer); resolveReady(); } });
      holder.once('error', (error) => { clearTimeout(timer); reject(error); });
      holder.once('exit', (code) => { clearTimeout(timer); reject(new Error('Filesystem lock holder exited early: ' + code)); });
    });
    runPowerShell(f, `
      $state = Invoke-AllenUpdater 'status' $true $false $true $helper $client
      Assert-Case ($state.state -eq 'deferred' -and $state.error -eq 'update-in-progress') 'cross-process lock'
      $activity = Read-AllenJson (Join-Path (Join-Path (Get-AllenControlledRoot) 'activity') ($client + '.json'))
      Assert-Case $activity.busy 'heartbeat must not block on update lock'
    `);
  } finally {
    holder.stdin.end('\n');
    await new Promise((resolveExit) => { if (holder.exitCode !== null) resolveExit(); else { holder.once('exit', resolveExit); setTimeout(() => { holder.kill(); resolveExit(); }, 5000).unref(); } });
  }
}));

test('unsigned, mismatched, non-CodeSigning and expired helpers fail closed before consent; metadata is not Authenticode', runtime, async () => withFixture(async (f) => {
  runPowerShell(f, `
    $script:consentCalls = 0
    function Request-AllenConsent { $script:consentCalls++; return $false }
    $script:signatureStatus = 'NotSigned'
    Reject-Case { Get-AllenInstallerPublisher $bundle } 'signature-invalid'
    Reject-Case { Invoke-AllenInstaller '' $extension $true } 'signature-invalid'
    Reject-Case { Get-AllenInstallation $helper } 'signature-invalid'
    $script:signatureStatus = 'Valid'
    foreach ($file in @('updater.ps1', 'ALLEN-Toolbox-NativeHost.exe')) {
      $script:foreignSignature = $file
      Reject-Case { Get-AllenInstallerPublisher $bundle } 'signature-invalid'
      Reject-Case { Invoke-AllenInstaller '' $extension $true } 'signature-invalid'
    }
    $script:foreignSignature = ''
    $extensions = $script:fixtureCertificate.Extensions; $script:fixtureCertificate.Extensions = @()
    Reject-Case { Get-AllenInstallerPublisher $bundle } 'signature-invalid'
    $script:fixtureCertificate.Extensions = $extensions
    $notAfter = $script:fixtureCertificate.NotAfter; $script:fixtureCertificate.NotAfter = [DateTime]::UtcNow.AddMinutes(-1)
    Reject-Case { Get-AllenInstallerPublisher $bundle } 'signature-invalid'
    $script:fixtureCertificate.NotAfter = $notAfter
    Assert-Case ($script:consentCalls -eq 0) 'signature failure precedes installer consent'
    Assert-Case (-not [IO.File]::Exists((Join-Path (Get-AllenControlledRoot) 'install-transaction.json'))) 'no install journal before consent'
    Test-AllenHelperStage $config $bundle (Join-Path ([IO.Path]::GetDirectoryName($bundle)) 'Install-ALLEN-Toolbox.cmd')
    $metadataPath = Join-Path $bundle 'availability.json'; $metadataBytes = Read-AllenBytes $metadataPath
    $metadata = Read-AllenJson $metadataPath; $metadata.files.'updater/updater.ps1' = '0' * 64
    Write-AllenJsonAtomic $metadataPath $metadata
    Reject-Case { Test-AllenHelperStage $config $bundle (Join-Path ([IO.Path]::GetDirectoryName($bundle)) 'Install-ALLEN-Toolbox.cmd') } 'package-invalid'
    Write-AllenBytesAtomic $metadataPath $metadataBytes
    $metadata = Read-AllenJson $metadataPath; $metadata.available = $false; Write-AllenJsonAtomic $metadataPath $metadata
    Reject-Case { Test-AllenHelperStage $config $bundle } 'signature-invalid'
    Write-AllenBytesAtomic $metadataPath $metadataBytes
    $original = Read-AllenBytes (Join-Path $helper 'installation.json')
    $legacy = $config.PSObject.Copy(); $legacy.protocol = 1; Write-AllenJsonAtomic (Join-Path $helper 'installation.json') $legacy
    Reject-Case { Get-AllenInstallation $helper } 'installation-invalid'
    Write-AllenBytesAtomic (Join-Path $helper 'installation.json') $original
    [IO.File]::Delete((Join-Path $bundle 'ALLEN-Toolbox-NativeHost.exe'))
    Reject-Case { Get-AllenInstallerPublisher $bundle } 'signature-invalid'
    Assert-Case ($script:consentCalls -eq 0) 'missing prebuilt binary cannot offer consent'
  `);
}));

test('fresh busy clients aggregate for three minutes and delayed children cannot overwrite newer same-client heartbeats', runtime, async () => withFixture(async (f) => {
  runPowerShell(f, `
    $script:fixtureClock = Get-AllenTime
    function Get-AllenTime { return $script:fixtureClock }
    Write-AllenActivity $config $true $otherClient
    Write-AllenActivity $config $false $client
    Assert-Case ((Get-AllenDeferReason $config $false $false) -ceq 'active-downloads') 'idle client cannot clear another client'
    function Get-AllenRelease { throw 'fixture network must not run' }
    $state = Invoke-AllenUpdater 'update' $false $false $true $helper $client
    Assert-Case ($state.error -ceq 'active-downloads' -and $state.state -ceq 'deferred') 'aggregate update gate'
    Write-AllenActivity $config $true $client
    $state = Invoke-AllenUpdater 'status' $false $false $true $helper $client $true
    $activityPath = Join-Path (Join-Path (Get-AllenControlledRoot) 'activity') ($client + '.json')
    Assert-Case (Read-AllenJson $activityPath).busy 'delayed child must not replace already-recorded newer busy heartbeat'
    $script:fixtureClock += 180000
    Assert-Case ((Get-AllenDeferReason $config $false $false) -ceq 'active-downloads') 'three-minute boundary remains busy'
    $script:fixtureClock++
    Assert-Case ((Get-AllenDeferReason $config $false $false) -ceq '') 'expired busy heartbeat'
    foreach ($id in @('', $client.ToUpperInvariant(), 'not-a-uuid')) { Reject-Case { Write-AllenActivity $config $false $id } 'installation-invalid' }
    $malformed = Read-AllenJson $activityPath; $malformed.at = -1; Write-AllenJsonAtomic $activityPath $malformed
    Assert-Case ((Get-AllenDeferReason $config $false $false) -ceq 'active-downloads') 'malformed heartbeat fails closed'
  `);
}));

test('status and direct crash recovery leave folders untouched while any client or browser is busy', runtime, async () => withFixture(async (f) => {
  runPowerShell(f, prepareCrashJournal + `
    Write-AllenActivity $config $true $otherClient
    $before = Get-AllenHexHash (Read-AllenBytes (Join-Path $helper 'updater.ps1') 2MB)
    $state = Invoke-AllenUpdater 'status' $false $false $true $helper $client
    Assert-Case ($state.state -ceq 'deferred' -and $state.error -ceq 'recovery-deferred' -and $state.installedVersion -ceq '2.1.0') 'status reports deferred recovery'
    Assert-Case ((Repair-AllenTransaction $config) -ceq 'recovery-deferred') 'direct repair enforces busy gate'
    Assert-Case (-not [IO.Directory]::Exists($extension) -and [IO.Directory]::Exists($paths.ExtensionBackup) -and [IO.Directory]::Exists($paths.ExtensionStage)) 'no folder mutation before client idle'
    Write-AllenActivity $config $false $otherClient
    function Get-Process { return [pscustomobject]@{ ProcessName = 'chrome' } }
    $state = Invoke-AllenUpdater 'status' $false $false $true $helper $client
    Assert-Case ($state.error -ceq 'recovery-deferred' -and [IO.File]::Exists((Join-Path $helper 'transaction.json'))) 'even native status respects browser recovery gate'
    Assert-Case ((Get-AllenHexHash (Read-AllenBytes (Join-Path $helper 'updater.ps1') 2MB)) -ceq $before) 'no helper rollback before idle'
    function Get-Process { return @() }
    $state = Invoke-AllenUpdater 'status' $false $false $true $helper $client
    Assert-Case ($state.installedVersion -ceq '2.1.0' -and [IO.File]::Exists((Join-Path $extension 'local-notes.txt'))) 'idle status can recover the interrupted transaction'
    Assert-Case (-not [IO.File]::Exists((Join-Path $helper 'transaction.json'))) 'recovery finalized only after idle'
  `, { timeout: 60000 });
}));

test('mismatched rollback publisher preserves unresolved journal and never replaces even the first helper', runtime, async () => withFixture(async (f) => {
  runPowerShell(f, prepareCrashJournal + `
    [IO.Directory]::Move($paths.ExtensionStage, $extension)
    $journal.phase = 'extension-committed'; Write-AllenJsonAtomic (Join-Path $helper 'transaction.json') $journal
    $before = Get-AllenHexHash (Read-AllenBytes (Join-Path $helper 'updater.ps1') 2MB)
    $script:foreignSignature = 'backup\\updater.ps1'
    Reject-Case { Repair-AllenTransaction $config } 'transaction-recovery-required'
    Assert-Case ([IO.File]::Exists((Join-Path $helper 'transaction.json')) -and [IO.Directory]::Exists($paths.ExtensionBackup)) 'mismatched backup remains recoverable'
    Assert-Case ((Get-AllenManifest $extension).version -ceq '2.2.0') 'no unauthenticated rollback folder replacement'
    Assert-Case ((Get-AllenHexHash (Read-AllenBytes (Join-Path $helper 'updater.ps1') 2MB)) -ceq $before) 'no first helper replacement'
  `);
}));

test('interrupted owned helper reinstall resumes safely; uninstall and reattach preserve unknown files and shared publishers', runtime, async () => withFixture(async (f) => {
  await writeFile(join(f.helper, 'unknown-user-file.txt'), 'KEEP UNKNOWN HELPER DATA');
  runPowerShell(f, mockInstallation + `
    $plan = Get-AllenInstallPlan '' $extension $true
    Assert-Case ($plan.Reinstall -and $plan.Attach) 'owned reinstall is supported'
    $result = Invoke-AllenInstaller '' $extension $true
    Assert-Case $result.cancelled 'No is still the default during reinstall'
    Assert-Case (-not [IO.File]::Exists((Join-Path (Get-AllenControlledRoot) 'install-transaction.json'))) 'no transaction before approval'
    $script:fixtureApproved = $true
    function Register-AllenTask { throw 'fixture install interruption' }
    Reject-Case { Invoke-AllenInstaller '' $extension $true } 'fixture install interruption'
    $incomplete = Get-AllenInstallation $helper -ForUninstall
    Assert-Case ($incomplete.disabled -and $incomplete.installationState -ceq 'installing') 'interrupted helper is owned and disabled'
    Assert-Case ([IO.File]::Exists((Join-Path (Get-AllenControlledRoot) 'install-transaction.json')) -and [IO.File]::Exists((Join-Path $helper 'ownership.json'))) 'early durable ownership and journal'
    function Register-AllenTask { $script:fixtureTaskRegistrations++ }
    $result = Invoke-AllenInstaller '' $extension $true
    Assert-Case ($result.installed -and (Get-AllenInstallation $helper).installationState -ceq 'installed') 'signed retry resumes'
    Assert-Case ([IO.File]::Exists((Join-Path $helper 'unknown-user-file.txt'))) 'reinstall preserves unknown helper files'
    $result = Invoke-AllenInstaller '' '' $false $true
    Assert-Case ($result.uninstalled -and (Get-AllenInstallation $helper -ForUninstall).disabled) 'uninstall leaves disabled ownership with unknown files'
    Assert-Case ($script:fixturePublisherAdds -eq 0 -and [IO.File]::Exists((Join-Path $extension 'local-notes.txt'))) 'no shared certificate removal or browser/extension data removal'
    $result = Invoke-AllenInstaller '' $extension $true
    Assert-Case ($result.installed -and [IO.File]::Exists((Join-Path $helper 'unknown-user-file.txt'))) 'owned tombstone permits safe signed reattach'
    [IO.File]::Delete((Join-Path $helper 'ownership.json'))
    Reject-Case { Get-AllenInstallPlan '' $extension $true } 'installation-invalid'
    Assert-Case ([IO.File]::Exists((Join-Path $helper 'unknown-user-file.txt'))) 'unowned directory is not deleted or adopted'
  `, { timeout: 60000 });
}));

test('fresh partial install is recoverable and verified publisher leaf addition is consented and never a root install', runtime, async () => withFixture(async (f) => {
  runPowerShell(f, mockInstallation + `
    [IO.Directory]::Move($helper, (Join-Path (Get-AllenControlledRoot) 'prior-owned-fixture'))
    $target = Join-Path $fixture 'fresh-extension'
    $script:fixtureTrusted = $false
    $plan = Get-AllenInstallPlan $extension $target
    $text = Get-AllenConsentText $plan
    Assert-Case ($plan.AddPublisher -and $text.Contains(${psString(publisherThumbprint)}) -and $text.Contains('CurrentUser\\TrustedPublisher')) 'leaf thumbprint and exact store are disclosed'
    $cancel = Invoke-AllenInstaller $extension $target
    Assert-Case ($cancel.cancelled -and $script:fixturePublisherAdds -eq 0 -and -not [IO.Directory]::Exists($helper)) 'no certificate/helper mutations before consent'
    $script:fixtureApproved = $true
    $script:originalCopy = ${'${function:Copy-AllenExtension}'}; $script:copyCrash = $true
    function Copy-AllenExtension($Source, $Destination, [switch]$Resume) {
      if ($script:copyCrash) { $script:copyCrash = $false; [IO.File]::Copy((Join-Path $Source 'manifest.json'), (Join-Path $Destination 'manifest.json')); throw 'fixture partial copy interruption' }
      & $script:originalCopy $Source $Destination -Resume:$Resume
    }
    Reject-Case { Invoke-AllenInstaller $extension $target } 'fixture partial copy interruption'
    $journal = Read-AllenInstallJournal (Get-AllenControlledRoot)
    $incomplete = Get-AllenInstallation $helper -ForUninstall
    Assert-Case ($journal.config.installationId -ceq $incomplete.installationId -and $incomplete.disabled) 'fresh interrupted helper has early ownership'
    $retryPlan = Get-AllenInstallPlan $extension $target
    $stages = Get-AllenInstallStagePaths $retryPlan $journal.token
    [IO.File]::WriteAllText((Join-Path $stages.Extension 'unknown-during-interruption.txt'), 'KEEP PARTIAL STAGE USER FILE')
    $result = Invoke-AllenInstaller $extension $target
    Assert-Case ($result.installed -and (Get-AllenManifest $target).version -ceq '2.1.0') 'partial package copy resumes'
    Assert-Case ([IO.File]::Exists((Join-Path $target 'unknown-during-interruption.txt'))) 'partial-stage unknown data is preserved'
    Assert-Case ($script:fixturePublisherAdds -eq 1 -and (Get-AllenInstallation $helper).publisherTrust.introduced) 'verified leaf introduced only after explicit approval'
    Assert-Case (-not [IO.File]::Exists((Join-Path (Get-AllenControlledRoot) 'install-transaction.json'))) 'fresh install finalized'
    Assert-Case ($result.extensionId -ceq (Get-AllenExtensionId $target)) 'fresh path-derived extension ID'
    Assert-Case ((Get-AllenTaskArguments (Get-AllenInstallation $helper)).Contains('-ExecutionPolicy AllSigned')) 'scheduled signed script uses AllSigned'
  `, { timeout: 60000 });
}));

function frame(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length); return Buffer.concat([header, bytes]);
}
test('in-memory managed library validates RPC2, required origins, framing and bounded streams without launching a process', runtime, async () => withFixture(async (f) => {
  const valid = { protocol: 2, command: 'status', busy: false, clientId };
  const invalid = [{ ...valid, protocol: 1 }, { ...valid, clientId: clientId.toUpperCase() }, { ...valid, clientId: '' },
    { ...valid, busy: 'false' }, { ...valid, command: 'exec' }, { ...valid, path: 'C:\\Windows' },
    { protocol: 2, command: 'status', busy: false },
    '{"protocol":2,"command":"update","command":"status","busy":false,"clientId":"' + clientId + '"}',
    '{"protocol":2,"command":\'status\',"busy":false,"clientId":"' + clientId + '"}',
    '{"protocol":2,"\\u0063ommand":"status","busy":false,"clientId":"' + clientId + '"}'];
  await writeFile(join(f.directory, 'requests.json'), JSON.stringify({ valid, invalid }));
  await writeFile(join(f.directory, 'frame.bin'), frame(valid));
  const tooLarge = Buffer.alloc(4); tooLarge.writeUInt32LE(64 * 1024 + 1);
  const badFrames = [tooLarge, Buffer.from([1, 0]), Buffer.from([0, 0, 0, 0]), Buffer.from([2, 0, 0, 0, 1])];
  for (let i = 0; i < badFrames.length; i++) await writeFile(join(f.directory, 'bad-frame-' + i + '.bin'), badFrames[i]);
  runPowerShell(f, `
    Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $fixture 'managed-source.cs'))) -ReferencedAssemblies @('System.dll', 'System.Core.dll', 'System.Web.Extensions.dll') -ErrorAction Stop
    $type = [AllenToolbox.NativeHost]; $flags = [Reflection.BindingFlags]'NonPublic, Static'
    $type.GetField('extensionId', $flags).SetValue($null, $config.extensionId)
    $json = New-Object Web.Script.Serialization.JavaScriptSerializer
    function Invoke-Inert([string]$Name, [object[]]$Arguments) {
      for ($i = 0; $i -lt $Arguments.Count; $i++) { if ($null -ne $Arguments[$i]) { $Arguments[$i] = $Arguments[$i].PSObject.BaseObject } }
      return $type.GetMethod($Name, $flags).Invoke($null, $Arguments)
    }
    function Reject-Inert([scriptblock]$Work) {
      try { & $Work | Out-Null } catch { $error = $_.Exception; while ($error.InnerException) { $error = $error.InnerException }; Assert-Case ($error -is [IO.InvalidDataException]) $error.Message; return }
      throw 'fixture assertion: expected InvalidDataException'
    }
    $requests = Read-AllenJson (Join-Path $fixture 'requests.json')
    $text = $requests.valid | ConvertTo-Json -Compress
    Assert-Case (Invoke-Inert 'ValidRequest' @($json.DeserializeObject($text), $text)) 'valid RPC2'
    foreach ($item in $requests.invalid) {
      $text = if ($item -is [string]) { $item } else { $item | ConvertTo-Json -Compress }
      try { $request = $json.DeserializeObject($text) } catch { $request = $null }
      Assert-Case (-not (Invoke-Inert 'ValidRequest' @($request, $text))) 'invalid literal RPC2'
    }
    $origin = 'chrome-extension://' + $config.extensionId + '/'
    Assert-Case (Invoke-Inert 'IsCallerAllowed' @(,[string[]]@($origin))) 'exact origin'
    Assert-Case (Invoke-Inert 'IsCallerAllowed' @(,[string[]]@($origin, '--parent-window=0'))) 'origin plus Chromium parent'
    foreach ($args in @(@(), @('--parent-window=1'), @($origin.TrimEnd('/')), @($origin.ToUpperInvariant()), @($origin, $origin), @($origin, '--parent-window=1', '--parent-window=2'), @($origin, '--parent-window=-1'))) {
      Assert-Case (-not (Invoke-Inert 'IsCallerAllowed' @(,[string[]]$args))) 'missing/foreign/duplicate origin or parent rejected'
    }
    foreach ($path in @((Join-Path $env:USERPROFILE 'AppData\\Local\\Google'), (Join-Path $env:USERPROFILE 'AppData\\Local\\Google\\Chrome\\User Data\\Default'), (Join-Path $env:USERPROFILE 'AppData\\Local\\Microsoft'), (Join-Path $env:USERPROFILE 'AppData\\Local\\BraveSoftware'))) { Reject-Inert { Invoke-Inert 'UserDirectory' @($path) } }
    $stream = New-Object IO.MemoryStream(,(Read-AllenBytes (Join-Path $fixture 'frame.bin')))
    $bytes = Invoke-Inert 'ReadFrame' @($stream)
    Assert-Case ($json.DeserializeObject([Text.Encoding]::UTF8.GetString($bytes))['clientId'] -ceq $client) 'round-trip bounded frame'
    Assert-Case ($null -eq (Invoke-Inert 'ReadFrame' @($stream))) 'clean EOF'
    for ($i = 0; $i -lt ${badFrames.length}; $i++) {
      $stream = New-Object IO.MemoryStream(,(Read-AllenBytes (Join-Path $fixture ('bad-frame-' + $i + '.bin'))))
      Reject-Inert { Invoke-Inert 'ReadFrame' @($stream) }
    }
    $stream = New-Object IO.MemoryStream(,([Text.Encoding]::UTF8.GetBytes('12345678')))
    $bounded = Invoke-Inert 'ReadBoundedAsync' @($stream, 8)
    Assert-Case ($bounded.GetAwaiter().GetResult().Length -eq 8) 'bounded managed stream'
    $stream = New-Object IO.MemoryStream(,([Text.Encoding]::UTF8.GetBytes('123456789')))
    $bounded = Invoke-Inert 'ReadBoundedAsync' @($stream, 8)
    Reject-Inert { $bounded.GetAwaiter().GetResult() }
    Assert-Case ($type.GetField('ProcessTimeoutMilliseconds', $flags).GetRawConstantValue() -eq 180000) 'finite child deadline is unchanged'
  `, { timeout: 60000 });
}));

test('same stdin transport accepts a validated busy heartbeat before a pending update completes, with ordered replies', runtime, async () => withFixture(async (f) => {
  const input = Buffer.concat([frame({ protocol: 2, command: 'update', busy: false, clientId }), frame({ protocol: 2, command: 'status', busy: true, clientId })]);
  await writeFile(join(f.directory, 'transport.bin'), input);
  const harness = `
namespace AllenFixture {
  public sealed class ChunkedStream : System.IO.MemoryStream {
    public ChunkedStream(byte[] bytes) : base(bytes) { }
    public override int Read(byte[] buffer, int offset, int count) { return base.Read(buffer, offset, System.Math.Min(count, 2)); }
  }
  public static class InertTransport {
    public static void Test(byte[] frames) {
      var type = typeof(AllenToolbox.NativeHost);
      var flags = System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static;
      var first = new System.Threading.Tasks.TaskCompletionSource<System.Collections.Generic.Dictionary<string, object>>();
      bool heartbeatBeforeCompletion = false;
      int calls = 0;
      System.Func<System.Collections.Generic.Dictionary<string, object>, System.Threading.Tasks.Task<System.Collections.Generic.Dictionary<string, object>>> dispatch = request => {
        calls++;
        if ((string)request["command"] == "update") return first.Task;
        heartbeatBeforeCompletion = !first.Task.IsCompleted && (bool)request["busy"] && (string)request["clientId"] == "${clientId}";
        first.SetResult(new System.Collections.Generic.Dictionary<string, object> { { "sequence", 1 } });
        return System.Threading.Tasks.Task.FromResult(new System.Collections.Generic.Dictionary<string, object> { { "sequence", 2 } });
      };
      System.Func<string, System.Collections.Generic.Dictionary<string, object>> error = code => new System.Collections.Generic.Dictionary<string, object> { { "error", code } };
      using (var input = new ChunkedStream(frames))
      using (var output = new System.IO.MemoryStream()) {
        int exit = (int)type.GetMethod("ProcessFrames", flags).Invoke(null, new object[] { input, output, dispatch, error });
        if (exit != 0 || calls != 2 || !heartbeatBeforeCompletion) throw new System.Exception("same-stdin heartbeat blocked behind update");
        output.Position = 0;
        var json = new System.Web.Script.Serialization.JavaScriptSerializer();
        for (int index = 1; index <= 2; index++) {
          byte[] reply = (byte[])type.GetMethod("ReadFrame", flags).Invoke(null, new object[] { output });
          var value = (System.Collections.Generic.Dictionary<string, object>)json.DeserializeObject(System.Text.Encoding.UTF8.GetString(reply));
          if ((int)value["sequence"] != index) throw new System.Exception("reply order changed");
        }
        if (type.GetMethod("ReadFrame", flags).Invoke(null, new object[] { output }) != null) throw new System.Exception("extra reply");
      }
    }
  }
}`;
  await writeFile(join(f.directory, 'inert-transport.cs'), harness);
  runPowerShell(f, `
    $code = [IO.File]::ReadAllText((Join-Path $fixture 'managed-source.cs')) + [IO.File]::ReadAllText((Join-Path $fixture 'inert-transport.cs'))
    Add-Type -TypeDefinition $code -ReferencedAssemblies @('System.dll', 'System.Core.dll', 'System.Web.Extensions.dll') -ErrorAction Stop
    [AllenFixture.InertTransport]::Test((Read-AllenBytes (Join-Path $fixture 'transport.bin')))
  `, { timeout: 60000 });
}));
