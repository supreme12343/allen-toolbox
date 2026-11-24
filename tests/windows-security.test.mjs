import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

test('Windows build verification pins directories, rejects links and rejects unsigned file handles without launching them', { skip: process.platform !== 'win32' }, async () => {
  const parent = join(process.env.LOCALAPPDATA, 'Temp', 'kilo');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'windows-security-test-'));
  const locked = join(directory, 'locked'), target = join(directory, 'target'), link = join(directory, 'link');
  await mkdir(locked); await mkdir(target); await symlink(target, link, 'junction');
  const unsigned = join(directory, 'unsigned.ps1');
  await writeFile(unsigned, '# inert signature fixture; never executed\n');
  const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
  const library = fileURLToPath(new URL('../tools/windows-security.cs', import.meta.url));
  const script = `$ErrorActionPreference='Stop';
Add-Type -Path ${literal(library)};
$pins=[AllenToolbox.WindowsReleaseSecurity]::PinDirectories(${literal(locked)});
$denied=$false;
try { try { [IO.Directory]::Move(${literal(locked)},${literal(join(directory, 'renamed'))}) } catch [IO.IOException] { $denied=$true }; if(-not $denied){throw 'Directory pin did not prevent replacement'} } finally {$pins.Dispose()};
$rejected=$false;
try { $linkPins=[AllenToolbox.WindowsReleaseSecurity]::PinDirectories(${literal(link)}); $linkPins.Dispose() } catch {$rejected=$true};
if(-not $rejected){throw 'A junction was accepted'};
$stream=[IO.File]::Open(${literal(unsigned)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);
$signatureRejected=$false;
try { try { [void][AllenToolbox.WindowsReleaseSecurity]::VerifySigner($stream,${literal(unsigned)}) } catch {$signatureRejected=$true} } finally {$stream.Dispose()};
if(-not $signatureRejected){throw 'An unsigned file was trusted'};
@{compiled=$true;pinned=$denied;linkRejected=$rejected;unsignedRejected=$signatureRejected}|ConvertTo-Json -Compress;`;
  try {
    const powershell = resolve(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const result = await promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'AllSigned', '-Command', script],
      { windowsHide: false, timeout: 60000, encoding: 'utf8', maxBuffer: 65536 });
    assert.deepEqual(JSON.parse(result.stdout.trim()), { compiled: true, pinned: true, linkRejected: true, unsignedRejected: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
