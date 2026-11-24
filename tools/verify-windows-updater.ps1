[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Directory)

$ErrorActionPreference = 'Stop'
if (-not ('AllenToolbox.WindowsReleaseSecurity' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'windows-security.cs') }
$root = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
$directoryLocks = [AllenToolbox.WindowsReleaseSecurity]::PinDirectories($root)
$handles = New-Object 'System.Collections.Generic.List[System.IDisposable]'
$verifiedFiles = [ordered]@{}
try {
$metadataPath = Join-Path $root 'availability.json'
if ((Get-Item -LiteralPath $metadataPath).Length -gt 16KB -or ((Get-Item -LiteralPath $metadataPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Signed helper metadata is oversized or a link.' }
$metadataStream = New-Object IO.FileStream($metadataPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
$handles.Add($metadataStream)
$reader = New-Object IO.BinaryReader($metadataStream, ([Text.UTF8Encoding]::new($false, $true)), $true)
try { $metadataBytes = $reader.ReadBytes(16385) } finally { $reader.Dispose() }
if ($metadataBytes.Length -gt 16384) { throw 'Signed helper metadata exceeds its limit.' }
$metadata = ([Text.UTF8Encoding]::new($false, $true)).GetString($metadataBytes).TrimStart([char]0xFEFF) | ConvertFrom-Json
if ($metadata.protocol -ne 2 -or $metadata.available -ne $true -or $metadata.publisherThumbprint -notmatch '^[A-Fa-f0-9]{40}$') { throw 'Signed helper metadata is invalid.' }
$expected = @('Install-ALLEN-Toolbox.cmd', 'updater/install.ps1', 'updater/updater.ps1', 'updater/public-key.json', 'updater/ALLEN-Toolbox-NativeHost.exe')
if (@($metadata.files.PSObject.Properties).Count -ne $expected.Count) { throw 'Signed helper inventory is invalid.' }
foreach ($relative in $expected) {
    $path = [IO.Path]::GetFullPath((Join-Path $root $relative))
    if (-not $path.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Signed helper path escapes its staging directory.' }
    for ($cursor = $path; $cursor -and $cursor.Length -ge $root.Length; $cursor = [IO.Path]::GetDirectoryName($cursor)) {
        if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Signed helper contains a reparse point.' }
    }
    if ((Get-Item -LiteralPath $path).Length -gt 16MB) { throw 'Signed helper file is oversized.' }
    # Keep each verified file open without write/delete sharing through signature checks.
    $stream = New-Object IO.FileStream($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $handles.Add($stream)
    if ($stream.Length -gt 16MB) { throw 'Opened helper file exceeds its hash limit.' }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    if ($metadata.files.$relative -cne $digest) { throw 'Signed helper inventory does not match its bytes.' }
    $verifiedFiles[$relative] = $digest
    if ($relative -in @('updater/install.ps1', 'updater/updater.ps1', 'updater/ALLEN-Toolbox-NativeHost.exe')) {
        $publisher = [AllenToolbox.WindowsReleaseSecurity]::VerifySigner($stream, $path)
        if ($publisher -ine $metadata.publisherThumbprint) { throw 'Signed helper has a different authenticated publisher.' }
    }
}
[ordered]@{ protocol = 2; verified = $true; publisherThumbprint = $metadata.publisherThumbprint.ToUpperInvariant(); files = $verifiedFiles } | ConvertTo-Json -Depth 4 -Compress
} finally { foreach ($handle in $handles) { $handle.Dispose() }; $directoryLocks.Dispose() }
