[CmdletBinding()]
param([string]$OutputDirectory = '')

$ErrorActionPreference = 'Stop'
if (-not ('AllenToolbox.WindowsReleaseSecurity' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'windows-security.cs') }
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $project 'dist/windows-updater' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $output.StartsWith((Join-Path $project 'dist') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Windows helper output must stay inside the project dist directory.' }
function Assert-NoBuildReparse([string]$Path) {
    for ($cursor = $Path; $cursor; $cursor = [IO.Path]::GetDirectoryName($cursor)) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Windows helper output cannot traverse a junction or symbolic link.' }
        }
    }
}
Assert-NoBuildReparse $output
$directoryLocks = [AllenToolbox.WindowsReleaseSecurity]::PinDirectories($output)
try {
if ([IO.Directory]::Exists($output)) { throw 'Use a fresh Windows helper build directory; existing artifacts are not replaced.' }
[void][IO.Directory]::CreateDirectory($output)
$directoryLocks.Add($output)
Assert-NoBuildReparse $output
function Write-BuildMetadata($Value) {
    $file = New-Object IO.FileStream((Join-Path $output 'availability.json'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $writer = New-Object IO.StreamWriter($file, ([Text.UTF8Encoding]::new($false)))
    try { $writer.Write(($Value | ConvertTo-Json -Depth 4)); $writer.Write("`n") } finally { $writer.Dispose() }
}
$configured = $env:WINDOWS_SIGNING_PFX -and $env:WINDOWS_SIGNING_PASSWORD -and $env:WINDOWS_SIGNING_THUMBPRINT
if (-not $configured) {
    if ($env:WINDOWS_SIGNING_PFX -or $env:WINDOWS_SIGNING_PASSWORD -or $env:WINDOWS_SIGNING_THUMBPRINT) { throw 'Windows signing configuration is incomplete.' }
    Write-BuildMetadata ([ordered]@{ protocol = 2; available = $false; reason = 'trusted-windows-signing-not-configured'; publisherThumbprint = ''; files = @{} })
    Write-Host 'No trusted Windows signing certificate configured. No executable or unsigned installer was built.'
    exit 0
}
if ($env:WINDOWS_SIGNING_THUMBPRINT -notmatch '^[A-Fa-f0-9]{40}$') { throw 'Expected Windows signing publisher is invalid.' }
$certificate = $null
try {
    $certificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2
    $flags = [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
    $certificate.Import([Convert]::FromBase64String($env:WINDOWS_SIGNING_PFX), $env:WINDOWS_SIGNING_PASSWORD, $flags)
    if (-not $certificate.HasPrivateKey -or $certificate.Thumbprint -ine $env:WINDOWS_SIGNING_THUMBPRINT) { throw 'Windows signing certificate does not match the pinned publisher.' }
    $chain = New-Object Security.Cryptography.X509Certificates.X509Chain
    $chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::Online
    [void]$chain.ChainPolicy.ApplicationPolicy.Add((New-Object Security.Cryptography.Oid('1.3.6.1.5.5.7.3.3')))
    try { if (-not $chain.Build($certificate)) { throw 'Windows signing certificate is not trusted for code signing.' } }
    finally { $chain.Dispose() }
    [void][IO.Directory]::CreateDirectory((Join-Path $output 'updater'))
    $directoryLocks.Add((Join-Path $output 'updater'))
    foreach ($path in @('Install-ALLEN-Toolbox.cmd', 'updater/install.ps1', 'updater/updater.ps1', 'updater/public-key.json')) {
        [IO.File]::Copy((Join-Path $project $path), (Join-Path $output $path), $false)
    }
    $compiler = Join-Path ([Environment]::GetFolderPath('Windows')) 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    $binary = Join-Path $output 'updater/ALLEN-Toolbox-NativeHost.exe'
    & $compiler /nologo /target:exe /optimize+ /reference:System.Web.Extensions.dll /reference:System.Core.dll ('/out:' + $binary) (Join-Path $project 'updater/native-host.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Windows native helper compilation failed.' }
    foreach ($path in @('updater/install.ps1', 'updater/updater.ps1', 'updater/ALLEN-Toolbox-NativeHost.exe')) {
        $signed = Set-AuthenticodeSignature -LiteralPath (Join-Path $output $path) -Certificate $certificate -HashAlgorithm SHA256 -TimestampServer 'http://timestamp.digicert.com'
        if ($signed.Status -ne 'Valid') { throw 'Windows refused the code-signing signature.' }
    }
    $files = [ordered]@{}
    foreach ($path in @('Install-ALLEN-Toolbox.cmd', 'updater/install.ps1', 'updater/updater.ps1', 'updater/public-key.json', 'updater/ALLEN-Toolbox-NativeHost.exe')) {
        $files[$path] = (Get-FileHash -LiteralPath (Join-Path $output $path) -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    Write-BuildMetadata ([ordered]@{ protocol = 2; available = $true; reason = ''; publisherThumbprint = $certificate.Thumbprint.ToUpperInvariant(); files = $files })
    & (Join-Path $PSScriptRoot 'verify-windows-updater.ps1') -Directory $output
    Write-Host 'Trusted signed Windows helper staged. The private certificate was not written to the project.'
} finally { if ($certificate) { $certificate.Dispose() } }
} finally { $directoryLocks.Dispose() }
