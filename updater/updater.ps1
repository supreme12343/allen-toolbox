[CmdletBinding()]
param(
    [ValidateSet('status', 'check', 'update')][string]$Command = 'status',
    [switch]$Busy,
    [switch]$Scheduled,
    [switch]$Native,
    [string]$ClientId = '',
    [switch]$ActivityRecorded
)

$script:AllenUpdaterDirectory = $PSScriptRoot
$script:AllenRepository = 'https://github.com/supreme12343/allen-toolbox'
$script:AllenReleaseApi = 'https://api.github.com/repos/supreme12343/allen-toolbox/releases/latest'
$script:AllenHelperFiles = @('install.ps1', 'updater.ps1', 'ALLEN-Toolbox-NativeHost.exe', 'public-key.json')
$script:AllenSignedHelperFiles = @('install.ps1', 'updater.ps1', 'ALLEN-Toolbox-NativeHost.exe')
$script:AllenMutableHelperFiles = @('updater.ps1', 'install.ps1')
$script:AllenActivityLifetime = 180000L
$script:AllenArchiveLimit = 64MB
$script:AllenExtractLimit = 256MB
$script:AllenErrorCodes = @(
    'installation-invalid', 'package-invalid', 'release-invalid', 'release-not-found',
    'network-error', 'network-timeout', 'download-too-large', 'signature-invalid',
    'archive-invalid', 'transaction-failed', 'transaction-recovery-required',
    'active-downloads', 'browser-running', 'update-in-progress', 'recovery-deferred',
    'publisher-not-trusted', 'reattach-required', 'internal-error'
)

function Get-AllenTime {
    $epoch = New-Object DateTime(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
    return [long]([DateTime]::UtcNow - $epoch).TotalMilliseconds
}

function Get-AllenFullPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'installation-invalid' }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($full -notmatch '^[a-zA-Z]:\\' -or $full.Substring(2) -match '[<>:"|?*\x00-\x1f]') { throw 'installation-invalid' }
    foreach ($segment in $full.Substring(3).Split('\')) { if ($segment -match '[. ]$') { throw 'installation-invalid' } }
    return $full.Substring(0, 1).ToUpperInvariant() + $full.Substring(1)
}

function Assert-AllenNoReparse([string]$Path, [switch]$Recurse) {
    $full = Get-AllenFullPath $Path
    $cursor = $full
    while ($cursor) {
        try { $attributes = [IO.File]::GetAttributes($cursor) }
        catch [IO.FileNotFoundException] { $attributes = 0 }
        catch [IO.DirectoryNotFoundException] { $attributes = 0 }
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'installation-invalid' }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    if ($Recurse -and [IO.Directory]::Exists($full)) {
        $queue = New-Object 'System.Collections.Generic.Queue[string]'
        $queue.Enqueue($full)
        $count = 0
        while ($queue.Count) {
            foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($queue.Dequeue())) {
                $count++
                if ($count -gt 20000) { throw 'package-invalid' }
                $attributes = [IO.File]::GetAttributes($entry)
                if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'installation-invalid' }
                if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { $queue.Enqueue($entry) }
            }
        }
    }
}

function Assert-AllenUserDirectory([string]$Path) {
    $full = Get-AllenFullPath $Path
    $profile = Get-AllenFullPath $env:USERPROFILE
    if (-not $full.StartsWith($profile + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'installation-invalid' }
    # Neither a browser container nor an ancestor of it can be an update target.
    foreach ($relative in @(
        'AppData\Local\Google\Chrome', 'AppData\Local\Google\Chrome Beta',
        'AppData\Local\Google\Chrome Dev', 'AppData\Local\Google\Chrome SxS',
        'AppData\Local\Microsoft\Edge', 'AppData\Local\Microsoft\Edge Beta',
        'AppData\Local\Microsoft\Edge Dev', 'AppData\Local\Microsoft\Edge SxS',
        'AppData\Local\BraveSoftware\Brave-Browser', 'AppData\Local\BraveSoftware\Brave-Browser-Beta',
        'AppData\Local\BraveSoftware\Brave-Browser-Nightly', 'AppData\Roaming\Mozilla',
        'AppData\Local\Mozilla', 'AppData\Local\Chromium', 'AppData\Local\Vivaldi',
        'AppData\Local\Opera Software', 'AppData\Roaming\Opera Software'
    )) {
        $blocked = $profile + '\' + $relative
        if ($full.Equals($blocked, [StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($blocked + '\', [StringComparison]::OrdinalIgnoreCase) -or $blocked.StartsWith($full + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'installation-invalid' }
    }
    Assert-AllenNoReparse $full
    return $full
}

function Get-AllenHexHash([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Get-AllenCurrentUserSid {
    return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}

function Get-AllenControlledRoot {
    return Assert-AllenUserDirectory (Join-Path $env:LOCALAPPDATA 'ALLENToolbox')
}

function Assert-AllenOwnedPath([string]$Path, [switch]$Directory) {
    Assert-AllenNoReparse $Path
    if ($Directory) { $security = [IO.Directory]::GetAccessControl($Path) }
    else { $security = [IO.File]::GetAccessControl($Path) }
    $sid = Get-AllenCurrentUserSid
    if ($security.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid) { throw 'installation-invalid' }
    $writeRights = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($rule in $security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and ($rule.FileSystemRights -band $writeRights) -and $rule.IdentityReference.Value -notin @($sid, 'S-1-5-18', 'S-1-5-32-544')) { throw 'installation-invalid' }
    }
}

function New-AllenOwnedDirectory([string]$Path) {
    Assert-AllenNoReparse $Path
    if ([IO.File]::Exists($Path)) { throw 'installation-invalid' }
    if (-not [IO.Directory]::Exists($Path)) {
        $sid = New-Object Security.Principal.SecurityIdentifier (Get-AllenCurrentUserSid)
        $security = New-Object Security.AccessControl.DirectorySecurity
        $security.SetOwner($sid)
        $security.SetAccessRuleProtection($true, $false)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit', [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
        $security.AddAccessRule($rule)
        [void][IO.Directory]::CreateDirectory($Path, $security)
    }
    Assert-AllenOwnedPath $Path -Directory
}

function Enter-AllenLock($Config, [string]$Name = 'update', [int]$TimeoutMilliseconds = 2000) {
    if ($Name -cnotmatch '^(update|activity-[a-f0-9-]{36})$' -or $TimeoutMilliseconds -lt 0 -or $TimeoutMilliseconds -gt 2000) { throw 'installation-invalid' }
    $root = Get-AllenControlledRoot
    if ($Config.helperDirectory -cne (Join-Path $root 'updater')) { throw 'installation-invalid' }
    $directory = Join-Path $root 'locks'
    Assert-AllenOwnedPath $root -Directory
    Assert-AllenOwnedPath $directory -Directory
    $path = Join-Path $directory ($Name + '.lock')
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        Assert-AllenNoReparse $path
        if ([IO.File]::Exists($path)) { Assert-AllenOwnedPath $path }
        try {
            $lock = New-Object IO.FileStream($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            try { Assert-AllenOwnedPath $path; return $lock } catch { $lock.Dispose(); throw }
        } catch [IO.IOException] {
            if ($clock.ElapsedMilliseconds -ge $TimeoutMilliseconds) { throw 'update-in-progress' }
            Start-Sleep -Milliseconds 25
        }
    }
}

function Assert-AllenClientId([string]$Id) {
    $parsed = [Guid]::Empty
    if (-not [Guid]::TryParseExact($Id, 'D', [ref]$parsed) -or $Id -cne $parsed.ToString('D')) { throw 'installation-invalid' }
}

function Get-AllenCodeSigningPublisher([string]$Path, [string]$ExpectedThumbprint = '') {
    try {
        Assert-AllenNoReparse $Path
        $signature = Get-AuthenticodeSignature -LiteralPath $Path -ErrorAction Stop
        $certificate = $signature.SignerCertificate
        if ([string]$signature.Status -cne 'Valid' -or $null -eq $certificate -or $certificate.Thumbprint -cnotmatch '^[A-F0-9]{40}$' -or $certificate.NotBefore.ToUniversalTime() -gt [DateTime]::UtcNow -or $certificate.NotAfter.ToUniversalTime() -lt [DateTime]::UtcNow) { throw 'signature-invalid' }
        $codeSigning = $false
        foreach ($extension in $certificate.Extensions) {
            if ($extension.Oid.Value -eq '2.5.29.37') {
                foreach ($usage in ([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]$extension).EnhancedKeyUsages) {
                    if ($usage.Value -eq '1.3.6.1.5.5.7.3.3') { $codeSigning = $true }
                }
            }
        }
        if (-not $codeSigning -or ($ExpectedThumbprint -and $certificate.Thumbprint -cne $ExpectedThumbprint)) { throw 'signature-invalid' }
        return [pscustomobject]@{ Thumbprint = $certificate.Thumbprint; Certificate = $certificate }
    } catch { throw 'signature-invalid' }
}

function Assert-AllenHelperPublisher([string]$Directory, [string]$ExpectedThumbprint = '') {
    $publisher = $null
    foreach ($file in $script:AllenSignedHelperFiles) {
        $verified = Get-AllenCodeSigningPublisher (Join-Path $Directory $file) $ExpectedThumbprint
        if (-not $ExpectedThumbprint) { $ExpectedThumbprint = $verified.Thumbprint; $publisher = $verified }
        elseif (-not $publisher) { $publisher = $verified }
    }
    return $publisher
}

function Get-AllenExtensionId([string]$Directory) {
    $canonical = Get-AllenFullPath $Directory
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = $sha.ComputeHash([Text.Encoding]::Unicode.GetBytes($canonical)) }
    finally { $sha.Dispose() }
    $id = New-Object Text.StringBuilder
    for ($i = 0; $i -lt 16; $i++) {
        [void]$id.Append([char](97 + ($digest[$i] -shr 4)))
        [void]$id.Append([char](97 + ($digest[$i] -band 15)))
    }
    return $id.ToString()
}

function Read-AllenBytes([string]$Path, [long]$Limit = 1MB) {
    Assert-AllenNoReparse $Path
    if (-not [IO.File]::Exists($Path) -or (New-Object IO.FileInfo $Path).Length -gt $Limit) { throw 'package-invalid' }
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.LongLength -gt $Limit) { throw 'package-invalid' }
    return ,$bytes
}

function Read-AllenJson([string]$Path, [long]$Limit = 1MB) {
    $encoding = New-Object Text.UTF8Encoding($false, $true)
    $text = $encoding.GetString((Read-AllenBytes $Path $Limit)).TrimStart([char]0xFEFF)
    try {
        $value = ConvertFrom-Json -InputObject $text -ErrorAction Stop
        if ($text.TrimStart().StartsWith('[') -and $null -eq $value) { $value = @() }
        return ,$value
    } catch { throw 'package-invalid' }
}

function Write-AllenBytesAtomic([string]$Path, [byte[]]$Bytes) {
    Assert-AllenNoReparse $Path
    $temporary = $Path + '.tmp-' + [Guid]::NewGuid().ToString('N')
    try {
        [IO.File]::WriteAllBytes($temporary, $Bytes)
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Write-AllenJsonAtomic([string]$Path, $Value) {
    $json = ConvertTo-Json -InputObject $Value -Depth 16 -Compress
    Write-AllenBytesAtomic $Path ([Text.Encoding]::UTF8.GetBytes($json))
}

function Get-AllenVersionParts([string]$Version) {
    if ($Version -notmatch '^(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){0,3}$') { throw 'release-invalid' }
    $parts = @($Version.Split('.') | ForEach-Object { [int]$_ })
    if (@($parts | Where-Object { $_ -gt 65535 }).Count -or -not @($parts | Where-Object { $_ -ne 0 }).Count) { throw 'release-invalid' }
    return ,$parts
}

function Compare-AllenVersions([string]$Left, [string]$Right) {
    $a = Get-AllenVersionParts $Left
    $b = Get-AllenVersionParts $Right
    for ($i = 0; $i -lt 4; $i++) {
        $x = 0; $y = 0
        if ($i -lt $a.Count) { $x = $a[$i] }
        if ($i -lt $b.Count) { $y = $b[$i] }
        if ($x -gt $y) { return 1 }
        if ($x -lt $y) { return -1 }
    }
    return 0
}

function Get-AllenPublicKey([string]$Path) {
    try {
        $key = Read-AllenJson $Path 8KB
        if ($key.algorithm -cne 'RSA-SHA256' -or $key.modulus -isnot [string] -or $key.exponent -isnot [string]) { throw 'signature-invalid' }
        $modulus = [Convert]::FromBase64String($key.modulus)
        $exponent = [Convert]::FromBase64String($key.exponent)
        if ($modulus.Length -notin @(256, 384, 512) -or $modulus[0] -lt 128 -or $exponent.Length -lt 1 -or $exponent.Length -gt 8 -or ($exponent[-1] -band 1) -ne 1) { throw 'signature-invalid' }
        if ($exponent[0] -eq 0 -or ($exponent.Length -eq 1 -and $exponent[0] -lt 3)) { throw 'signature-invalid' }
        if ($key.modulus -cne [Convert]::ToBase64String($modulus) -or $key.exponent -cne [Convert]::ToBase64String($exponent)) { throw 'signature-invalid' }
        $parameters = New-Object Security.Cryptography.RSAParameters
        $parameters.Modulus = $modulus
        $parameters.Exponent = $exponent
        $fingerprint = Get-AllenHexHash ([Text.Encoding]::ASCII.GetBytes("RSA-SHA256`n$($key.modulus)`n$($key.exponent)"))
        return [pscustomobject]@{ Parameters = $parameters; Fingerprint = $fingerprint }
    } catch { throw 'signature-invalid' }
}

function Assert-AllenSignature([byte[]]$Archive, [byte[]]$Signature, [string]$KeyPath) {
    if ($Archive.LongLength -gt $script:AllenArchiveLimit -or $Signature.Length -lt 256 -or $Signature.Length -gt 8KB) { throw 'signature-invalid' }
    $key = Get-AllenPublicKey $KeyPath
    $rsa = New-Object Security.Cryptography.RSACryptoServiceProvider
    $rsa.PersistKeyInCsp = $false
    try {
        $rsa.ImportParameters($key.Parameters)
        if ($Signature.Length -ne $key.Parameters.Modulus.Length -or -not $rsa.VerifyData($Archive, 'SHA256', $Signature)) { throw 'signature-invalid' }
    } catch { throw 'signature-invalid' }
    finally { $rsa.Dispose() }
}

function Get-AllenManifest([string]$Directory, [string]$ExpectedVersion = '') {
    try {
        $manifest = Read-AllenJson (Join-Path $Directory 'manifest.json') 256KB
        if ($manifest.manifest_version -isnot [int] -or $manifest.manifest_version -ne 3 -or $manifest.name -cne 'ALLEN Toolbox' -or $manifest.homepage_url -cne $script:AllenRepository -or $manifest.version -isnot [string] -or 'key' -in @($manifest.PSObject.Properties.Name)) { throw 'package-invalid' }
        [void](Get-AllenVersionParts $manifest.version)
        if ($ExpectedVersion -and $manifest.version -cne $ExpectedVersion) { throw 'package-invalid' }
        return $manifest
    } catch { throw 'package-invalid' }
}

function Get-AllenInstallation([string]$HelperDirectory = $script:AllenUpdaterDirectory, [switch]$ForUninstall) {
    try {
        $helper = Assert-AllenUserDirectory $HelperDirectory
        $root = Get-AllenControlledRoot
        if ($helper -cne (Join-Path $root 'updater')) { throw 'installation-invalid' }
        Assert-AllenOwnedPath $root -Directory
        Assert-AllenOwnedPath $helper -Directory
        $config = Read-AllenJson (Join-Path $helper 'installation.json') 16KB
        if ($config.protocol -isnot [int] -or $config.protocol -ne 2 -or $config.owner -cne 'ALLEN Toolbox' -or $config.repository -cne $script:AllenRepository -or $config.helperDirectory -cne $helper -or $config.publisherThumbprint -cnotmatch '^[A-F0-9]{40}$' -or $config.disabled -isnot [bool] -or $config.installationState -notin @('installing', 'installed', 'uninstalled') -or $config.taskName -cne ('ALLEN Toolbox Updater-' + (Get-AllenCurrentUserSid))) { throw 'installation-invalid' }
        Assert-AllenClientId $config.installationId
        $owner = Read-AllenJson (Join-Path $helper 'ownership.json') 8KB
        if ($owner.protocol -isnot [int] -or $owner.protocol -ne 2 -or $owner.owner -cne 'ALLEN Toolbox' -or $owner.userSid -cne (Get-AllenCurrentUserSid) -or $owner.helperDirectory -cne $helper -or $owner.installationId -cne $config.installationId -or $owner.publisherThumbprint -cne $config.publisherThumbprint) { throw 'installation-invalid' }
        $extension = Assert-AllenUserDirectory $config.extensionDirectory
        if ($extension -cne $config.extensionDirectory -or $extension.StartsWith($helper + '\', [StringComparison]::OrdinalIgnoreCase) -or $helper.StartsWith($extension + '\', [StringComparison]::OrdinalIgnoreCase) -or $extension.Equals($helper, [StringComparison]::OrdinalIgnoreCase)) { throw 'installation-invalid' }
        if ($config.extensionId -cne (Get-AllenExtensionId $extension)) { throw 'installation-invalid' }
        if (-not $ForUninstall) {
            if ($config.disabled -or $config.installationState -cne 'installed') { throw 'installation-invalid' }
            [void](Assert-AllenHelperPublisher $helper $config.publisherThumbprint)
            $key = Get-AllenPublicKey (Join-Path $helper 'public-key.json')
            if ($config.publicKeyFingerprint -cne $key.Fingerprint -or $config.installedVersion -isnot [string]) { throw 'installation-invalid' }
            [void](Get-AllenVersionParts $config.installedVersion)
        }
        return $config
    } catch {
        if ($_.Exception.Message -eq 'signature-invalid') { throw 'signature-invalid' }
        throw 'installation-invalid'
    }
}

function New-AllenState {
    return [pscustomobject][ordered]@{
        protocol = 2; installed = $true; installedVersion = $null; availableVersion = $null
        state = 'up-to-date'; lastCheckedAt = [long]0; lastUpdatedAt = [long]0; error = ''; extensionId = ''
        security = [pscustomobject]@{ authenticode = $false; publisherThumbprint = '' }
    }
}

function Read-AllenState($Config) {
    $state = New-AllenState
    $path = Join-Path $Config.helperDirectory 'state.json'
    if ([IO.File]::Exists($path)) {
        try {
            $saved = Read-AllenJson $path 16KB
            foreach ($field in @('lastCheckedAt', 'lastUpdatedAt')) {
                if ($saved.$field -is [ValueType] -and [long]$saved.$field -ge 0 -and [long]$saved.$field -le (Get-AllenTime)) { $state.$field = [long]$saved.$field }
            }
            if ($saved.availableVersion -is [string]) { [void](Get-AllenVersionParts $saved.availableVersion); $state.availableVersion = $saved.availableVersion }
            if ($saved.state -in @('up-to-date', 'available', 'updated', 'deferred', 'error')) { $state.state = $saved.state }
            if ($saved.error -in $script:AllenErrorCodes) { $state.error = $saved.error }
        } catch { $state.state = 'error'; $state.error = 'installation-invalid' }
    }
    $state.extensionId = $Config.extensionId
    $state.security = [pscustomobject]@{ authenticode = $true; publisherThumbprint = $Config.publisherThumbprint }
    return $state
}

function Write-AllenActivity($Config, [bool]$IsBusy, [string]$Id) {
    Assert-AllenClientId $Id
    $directory = Join-Path (Get-AllenControlledRoot) 'activity'
    Assert-AllenOwnedPath $directory -Directory
    $lock = Enter-AllenLock $Config ('activity-' + $Id) 1000
    try {
        Write-AllenJsonAtomic (Join-Path $directory ($Id + '.json')) ([pscustomobject]@{ protocol = 2; clientId = $Id; busy = $IsBusy; at = (Get-AllenTime) })
    } finally { $lock.Dispose() }
}

function Get-AllenDeferReason($Config, [bool]$IsBusy, [bool]$IsScheduled) {
    if ($IsBusy) { return 'active-downloads' }
    # Browser/profile activity cannot be proven idle from one client's heartbeat.
    if (@(Get-Process -Name chrome, msedge, brave, chromium -ErrorAction SilentlyContinue).Count) { return 'browser-running' }
    try {
        $directory = Join-Path (Get-AllenControlledRoot) 'activity'
        Assert-AllenOwnedPath $directory -Directory
        $paths = @([IO.Directory]::EnumerateFiles($directory, '*.json'))
        if ($paths.Count -gt 256) { return 'active-downloads' }
        foreach ($path in $paths) {
            $id = [IO.Path]::GetFileNameWithoutExtension($path)
            Assert-AllenClientId $id
            $activity = Read-AllenJson $path 4KB
            if ($activity.protocol -isnot [int] -or $activity.protocol -ne 2 -or $activity.clientId -cne $id -or $activity.busy -isnot [bool] -or ($activity.at -isnot [long] -and $activity.at -isnot [int]) -or $activity.at -lt 0) { return 'active-downloads' }
            $age = (Get-AllenTime) - [long]$activity.at
            if ($age -lt 0 -or ($activity.busy -and $age -le $script:AllenActivityLifetime)) { return 'active-downloads' }
        }
    } catch { return 'active-downloads' }
    return ''
}

function Assert-AllenNetworkUri([Uri]$Uri, [string]$AssetUrl = '') {
    if ($Uri.Scheme -cne 'https' -or $Uri.Port -ne 443 -or $Uri.UserInfo -or $Uri.Fragment) { throw 'release-invalid' }
    if (-not $AssetUrl) {
        if ($Uri.AbsoluteUri -cne $script:AllenReleaseApi) { throw 'release-invalid' }
        return
    }
    if ($Uri.AbsoluteUri -ceq $AssetUrl) { return }
    if ($Uri.Host -notin @('release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com')) { throw 'release-invalid' }
}

function New-AllenHttpRequest([Uri]$Uri) {
    return [Net.HttpWebRequest]::Create($Uri)
}

function Get-AllenHttpBytes([string]$Url, [long]$Limit, [int]$TimeoutSeconds, [string]$AssetUrl = '') {
    if ($Limit -lt 1 -or $Limit -gt $script:AllenArchiveLimit -or $TimeoutSeconds -lt 1 -or $TimeoutSeconds -gt 60) { throw 'release-invalid' }
    if ($AssetUrl -and ($Url -cne $AssetUrl -or $AssetUrl -notmatch '^https://github\.com/supreme12343/allen-toolbox/releases/download/[^/?#]+/ALLEN-Toolbox-[0-9.]+\.zip(\.sig)?$')) { throw 'release-invalid' }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $uri = New-Object Uri $Url
    $oldTls = [Net.ServicePointManager]::SecurityProtocol
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        for ($redirect = 0; $redirect -le 3; $redirect++) {
            Assert-AllenNetworkUri $uri $AssetUrl
            $remaining = $TimeoutSeconds * 1000 - [int]$clock.ElapsedMilliseconds
            if ($remaining -le 0) { throw 'network-timeout' }
            $request = New-AllenHttpRequest $uri
            $request.Method = 'GET'; $request.AllowAutoRedirect = $false
            $request.Credentials = $null; $request.UseDefaultCredentials = $false; $request.PreAuthenticate = $false
            $request.Proxy = $null; $request.Timeout = $remaining; $request.ReadWriteTimeout = $remaining
            $request.CheckCertificateRevocationList = $true
            $request.UserAgent = 'ALLEN-Toolbox-Updater/1.0'
            $request.Accept = 'application/octet-stream'
            if (-not $AssetUrl) { $request.Accept = 'application/vnd.github+json' }
            $response = $null; $stream = $null; $buffer = $null
            try {
                $response = $request.GetResponse()
                $status = [int]$response.StatusCode
                if ($status -in @(301, 302, 303, 307, 308)) {
                    if (-not $AssetUrl -or $redirect -eq 3 -or -not $response.Headers['Location']) { throw 'release-invalid' }
                    $uri = New-Object Uri($uri, $response.Headers['Location'])
                    continue
                }
                if ($status -ne 200) { throw 'network-error' }
                if ($response.ContentLength -gt $Limit) { throw 'download-too-large' }
                $stream = $response.GetResponseStream()
                $buffer = New-Object IO.MemoryStream
                $chunk = New-Object byte[] 32768
                while ($true) {
                    $remaining = $TimeoutSeconds * 1000 - [int]$clock.ElapsedMilliseconds
                    if ($remaining -le 0) { throw 'network-timeout' }
                    if ($stream.CanTimeout) { $stream.ReadTimeout = $remaining }
                    $read = $stream.Read($chunk, 0, $chunk.Length)
                    if ($read -eq 0) { break }
                    if ($buffer.Length + $read -gt $Limit) { throw 'download-too-large' }
                    $buffer.Write($chunk, 0, $read)
                }
                if ($clock.ElapsedMilliseconds -gt $TimeoutSeconds * 1000) { throw 'network-timeout' }
                if ($response.ContentLength -ge 0 -and $buffer.Length -ne $response.ContentLength) { throw 'network-error' }
                return ,$buffer.ToArray()
            } catch [Net.WebException] {
                if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) { throw 'release-not-found' }
                if ($_.Exception.Status -eq [Net.WebExceptionStatus]::Timeout -or $clock.ElapsedMilliseconds -ge $TimeoutSeconds * 1000) { throw 'network-timeout' }
                throw 'network-error'
            } catch [IO.IOException] {
                if ($clock.ElapsedMilliseconds -ge $TimeoutSeconds * 1000) { throw 'network-timeout' }
                throw 'network-error'
            } finally {
                if ($stream) { $stream.Dispose() }; if ($buffer) { $buffer.Dispose() }; if ($response) { $response.Dispose() }
                $request.Abort()
            }
        }
        throw 'release-invalid'
    } finally { [Net.ServicePointManager]::SecurityProtocol = $oldTls }
}

function ConvertTo-AllenRelease($Metadata) {
    try {
        if ($Metadata.draft -isnot [bool] -or $Metadata.prerelease -isnot [bool] -or $Metadata.draft -or $Metadata.prerelease -or $Metadata.tag_name -isnot [string]) { throw 'release-invalid' }
        $version = $Metadata.tag_name -creplace '^v', ''
        [void](Get-AllenVersionParts $version)
        if ($Metadata.html_url -cne ($script:AllenRepository + '/releases/tag/' + $Metadata.tag_name)) { throw 'release-invalid' }
        $filename = 'ALLEN-Toolbox-' + $version + '.zip'
        $assets = @($Metadata.assets)
        $zip = @($assets | Where-Object { $_.name -ceq $filename })
        $sig = @($assets | Where-Object { $_.name -ceq ($filename + '.sig') })
        if ($zip.Count -ne 1 -or $sig.Count -ne 1) { throw 'release-invalid' }
        foreach ($asset in @($zip[0], $sig[0])) {
            if ($asset.state -cne 'uploaded' -or $asset.size -isnot [ValueType] -or [long]$asset.size -le 0 -or [long]$asset.size -ne $asset.size) { throw 'release-invalid' }
            $expected = $script:AllenRepository + '/releases/download/' + $Metadata.tag_name + '/' + $asset.name
            if ($asset.browser_download_url -cne $expected) { throw 'release-invalid' }
            Assert-AllenNetworkUri (New-Object Uri $expected) $expected
        }
        if ([long]$zip[0].size -gt $script:AllenArchiveLimit -or [long]$sig[0].size -gt 8KB -or [long]$sig[0].size -lt 256) { throw 'download-too-large' }
        return [pscustomobject]@{ Version = $version; ZipUrl = $zip[0].browser_download_url; SignatureUrl = $sig[0].browser_download_url; ZipSize = [long]$zip[0].size; SignatureSize = [long]$sig[0].size }
    } catch {
        if ($_.Exception.Message -eq 'download-too-large') { throw 'download-too-large' }
        throw 'release-invalid'
    }
}

function Get-AllenRelease {
    $bytes = Get-AllenHttpBytes $script:AllenReleaseApi 1MB 20
    try {
        $encoding = New-Object Text.UTF8Encoding($false, $true)
        $metadata = ConvertFrom-Json -InputObject $encoding.GetString($bytes) -ErrorAction Stop
    } catch { throw 'release-invalid' }
    return ConvertTo-AllenRelease $metadata
}

function Get-AllenArchivePath([string]$Path, [long]$ExternalAttributes = 0) {
    if (-not $Path -or $Path.Length -gt 220 -or $Path -match '[\\<>:"|?*\x00-\x1f\x7f]' -or $Path.Contains('//') -or $Path.StartsWith('/')) { throw 'archive-invalid' }
    $directory = $Path.EndsWith('/')
    $clean = $Path.TrimEnd('/')
    $parts = $clean.Split('/')
    foreach ($part in $parts) {
        if (-not $part -or $part -in @('.', '..') -or $part -match '[. ]$' -or $part -match '(?i)^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(\..*)?$' -or $part -match '~[0-9]') { throw 'archive-invalid' }
    }
    $attributes = $ExternalAttributes -band 4294967295L
    $mode = ($attributes -shr 16) -band 61440
    if (($attributes -band 1024) -ne 0 -or $mode -notin @(0, 16384, 32768) -or ($mode -eq 16384 -and -not $directory) -or ($mode -eq 32768 -and $directory) -or (($attributes -band 16) -ne 0 -and -not $directory)) { throw 'archive-invalid' }
    if ($parts[0] -ceq 'allen-toolbox') {
        if ($parts.Count -eq 1 -and -not $directory) { throw 'archive-invalid' }
        return [pscustomobject]@{ Path = $clean; Directory = $directory; Root = 'extension'; Relative = ($parts | Select-Object -Skip 1) -join '/' }
    }
    if ($parts[0] -ceq 'updater') {
        if ($parts.Count -eq 1 -and $directory) { return [pscustomobject]@{ Path = $clean; Directory = $true; Root = 'helper'; Relative = '' } }
        if ($parts.Count -ne 2 -or $directory -or $parts[1] -cnotin ($script:AllenHelperFiles + @('availability.json'))) { throw 'archive-invalid' }
        return [pscustomobject]@{ Path = $clean; Directory = $false; Root = 'helper'; Relative = $parts[1] }
    }
    if ($clean -ceq 'Install-ALLEN-Toolbox.cmd' -and -not $directory) { return [pscustomobject]@{ Path = $clean; Directory = $false; Root = 'launcher'; Relative = $clean } }
    throw 'archive-invalid'
}

function Get-AllenZipRecords([byte[]]$Bytes) {
    # Read attributes directly: older Windows 10 .NET lacks ExternalAttributes.
    # Official bundles are single-disk ZIP32 with UTF-8 names, not encrypted ZIPs.
    if ($Bytes.Length -lt 22 -or $Bytes.LongLength -gt $script:AllenArchiveLimit) { throw 'archive-invalid' }
    $end = -1
    $minimum = [Math]::Max(0, $Bytes.Length - 65557)
    for ($i = $Bytes.Length - 22; $i -ge $minimum; $i--) {
        if ([BitConverter]::ToUInt32($Bytes, $i) -eq 0x06054b50 -and $i + 22 + [BitConverter]::ToUInt16($Bytes, $i + 20) -eq $Bytes.Length) { $end = $i; break }
    }
    if ($end -lt 0 -or [BitConverter]::ToUInt16($Bytes, $end + 4) -ne 0 -or [BitConverter]::ToUInt16($Bytes, $end + 6) -ne 0) { throw 'archive-invalid' }
    $count = [BitConverter]::ToUInt16($Bytes, $end + 10)
    $size = [long][BitConverter]::ToUInt32($Bytes, $end + 12)
    $cursor = [long][BitConverter]::ToUInt32($Bytes, $end + 16)
    if ($count -gt 8192 -or [BitConverter]::ToUInt16($Bytes, $end + 8) -ne $count -or $cursor + $size -ne $end) { throw 'archive-invalid' }
    $records = New-Object 'System.Collections.Generic.List[object]'
    $encoding = New-Object Text.UTF8Encoding($false, $true)
    for ($i = 0; $i -lt $count; $i++) {
        if ($cursor + 46 -gt $end -or [BitConverter]::ToUInt32($Bytes, [int]$cursor) -ne 0x02014b50) { throw 'archive-invalid' }
        $flags = [BitConverter]::ToUInt16($Bytes, [int]$cursor + 8)
        $method = [BitConverter]::ToUInt16($Bytes, [int]$cursor + 10)
        $nameLength = [BitConverter]::ToUInt16($Bytes, [int]$cursor + 28)
        $extraLength = [BitConverter]::ToUInt16($Bytes, [int]$cursor + 30)
        $commentLength = [BitConverter]::ToUInt16($Bytes, [int]$cursor + 32)
        $next = $cursor + 46 + $nameLength + $extraLength + $commentLength
        if ($next -gt $end -or ($flags -band 2048) -eq 0 -or ($flags -band 8257) -ne 0 -or $method -notin @(0, 8) -or [BitConverter]::ToUInt16($Bytes, [int]$cursor + 34) -ne 0) { throw 'archive-invalid' }
        if ([BitConverter]::ToUInt32($Bytes, [int]$cursor + 20) -eq [uint32]::MaxValue -or [BitConverter]::ToUInt32($Bytes, [int]$cursor + 24) -eq [uint32]::MaxValue -or [BitConverter]::ToUInt32($Bytes, [int]$cursor + 42) -ge $end) { throw 'archive-invalid' }
        $name = $encoding.GetString($Bytes, [int]$cursor + 46, $nameLength)
        $attributes = [long][BitConverter]::ToUInt32($Bytes, [int]$cursor + 38)
        $records.Add([pscustomobject]@{ Name = $name; Attributes = $attributes })
        $cursor = $next
    }
    if ($cursor -ne $end) { throw 'archive-invalid' }
    return ,$records
}

function Expand-AllenVerifiedArchive([byte[]]$Bytes, [string]$ExtensionStage, [string]$HelperStage) {
    Add-Type -AssemblyName System.IO.Compression -ErrorAction Stop
    $memory = New-Object IO.MemoryStream(,$Bytes)
    $archive = $null
    try {
        $records = Get-AllenZipRecords $Bytes
        $archive = New-Object IO.Compression.ZipArchive($memory, [IO.Compression.ZipArchiveMode]::Read, $false)
        $paths = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::OrdinalIgnoreCase)
        $entries = New-Object 'System.Collections.Generic.List[object]'
        $total = [long]0
        if ($archive.Entries.Count -ne $records.Count) { throw 'archive-invalid' }
        $index = 0
        foreach ($entry in $archive.Entries) {
            $record = $records[$index]; $index++
            if ($entry.FullName -cne $record.Name) { throw 'archive-invalid' }
            $path = Get-AllenArchivePath $record.Name $record.Attributes
            if ($entry.Length -gt 64MB -or ($path.Directory -and $entry.Length -ne 0)) { throw 'archive-invalid' }
            $total += $entry.Length
            if ($total -gt $script:AllenExtractLimit) { throw 'archive-invalid' }
            $segments = $path.Path.Split('/')
            for ($i = 0; $i -lt $segments.Count; $i++) {
                $prefix = ($segments[0..$i]) -join '/'
                $isDirectory = $i -lt $segments.Count - 1 -or $path.Directory
                $explicit = $i -eq $segments.Count - 1
                if ($paths.ContainsKey($prefix)) {
                    $prior = $paths[$prefix]
                    if ($prior.Path -cne $prefix -or -not $prior.Directory -or -not $isDirectory -or ($explicit -and $prior.Explicit)) { throw 'archive-invalid' }
                    if ($explicit) { $prior.Explicit = $true }
                } else { $paths.Add($prefix, [pscustomobject]@{ Path = $prefix; Directory = $isDirectory; Explicit = $explicit }) }
            }
            $root = $ExtensionStage
            if ($path.Root -ne 'extension') { $root = $HelperStage }
            $target = $root
            if ($path.Relative) { $target = Join-Path $root $path.Relative.Replace('/', '\') }
            if ($target.Length -ge 260) { throw 'archive-invalid' }
            $entries.Add([pscustomobject]@{ Entry = $entry; Path = $path; Target = $target })
        }
        foreach ($required in @('allen-toolbox/manifest.json', 'Install-ALLEN-Toolbox.cmd') + @($script:AllenHelperFiles | ForEach-Object { 'updater/' + $_ })) {
            if (-not $paths.ContainsKey($required) -or $paths[$required].Directory) { throw 'package-invalid' }
        }
        # All names and expansion limits are checked before creating any archive entry.
        foreach ($item in $entries) {
            if ($item.Path.Directory) { [void][IO.Directory]::CreateDirectory($item.Target); continue }
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($item.Target))
            Assert-AllenNoReparse $item.Target
            $input = $item.Entry.Open()
            $output = $null
            try {
                $output = New-Object IO.FileStream($item.Target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                $chunk = New-Object byte[] 32768
                $count = [long]0
                while (($read = $input.Read($chunk, 0, $chunk.Length)) -gt 0) {
                    $count += $read
                    if ($count -gt $item.Entry.Length) { throw 'archive-invalid' }
                    $output.Write($chunk, 0, $read)
                }
                if ($count -ne $item.Entry.Length) { throw 'archive-invalid' }
            } finally { $input.Dispose(); if ($output) { $output.Dispose() } }
        }
    } catch {
        if ($_.Exception.Message -eq 'package-invalid') { throw 'package-invalid' }
        throw 'archive-invalid'
    } finally { if ($archive) { $archive.Dispose() }; $memory.Dispose() }
}

function Get-AllenLocalAsset([string]$Root, [string]$Reference, [string]$Base = '') {
    if (-not $Reference -or $Reference -match '^(https?:|data:|blob:|#|about:)') { return '' }
    $referencePath = ($Reference -split '[?#]', 2)[0]
    if ($referencePath -match '[\\<>:"|?*\x00-\x1f]' -or $referencePath.StartsWith('//')) { throw 'package-invalid' }
    if ($referencePath.StartsWith('/')) { $Base = ''; $referencePath = $referencePath.TrimStart('/') }
    $target = Get-AllenFullPath (Join-Path (Join-Path $Root $Base) $referencePath.Replace('/', '\'))
    if (-not $target.StartsWith($Root + '\', [StringComparison]::Ordinal) -or -not [IO.File]::Exists($target)) { throw 'package-invalid' }
    Assert-AllenNoReparse $target
    # NTFS is case-insensitive, but a release must not depend on case aliases.
    $relative = $target.Substring($Root.Length + 1).Replace('\', '/')
    $parent = $Root
    foreach ($segment in $relative.Split('/')) {
        if (-not @([IO.Directory]::EnumerateFileSystemEntries($parent) | Where-Object { [IO.Path]::GetFileName($_) -ceq $segment }).Count) { throw 'package-invalid' }
        $parent = Join-Path $parent $segment
    }
    return $relative
}

function Test-AllenExtension([string]$Directory, [string]$ExpectedVersion = '') {
    $root = Get-AllenFullPath $Directory
    Assert-AllenNoReparse $root -Recurse
    $manifest = Get-AllenManifest $root $ExpectedVersion
    $required = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($path in @('manifest.json', 'background.js', 'offscreen.html', 'offscreen.js', 'shared/package.js', 'scripts/scripts.json', 'plugins/plugins.json')) { [void]$required.Add($path) }
    $inventory = [Text.Encoding]::UTF8.GetString((Read-AllenBytes (Join-Path $root 'shared/package.js') 2MB))
    $match = [regex]::Match($inventory, 'export\s+const\s+EXTENSION_ASSETS\s*=\s*Object\.freeze\(\s*\[(.*?)\]\s*\)', [Text.RegularExpressions.RegexOptions]::Singleline)
    if (-not $match.Success) { throw 'package-invalid' }
    foreach ($item in [regex]::Matches($match.Groups[1].Value, '[''"]([^''"]+)[''"]')) {
        $path = $item.Groups[1].Value
        [void](Get-AllenArchivePath ('allen-toolbox/' + $path))
        [void]$required.Add($path)
    }
    foreach ($value in @($manifest.icons.PSObject.Properties.Value) + @($manifest.action.default_icon.PSObject.Properties.Value) + @($manifest.action.default_popup, $manifest.background.service_worker, $manifest.devtools_page, $manifest.options_page, $manifest.options_ui.page) + @($manifest.sandbox.pages)) {
        if ($value) { [void]$required.Add([string]$value) }
    }
    foreach ($scriptEntry in @($manifest.content_scripts)) { foreach ($path in @($scriptEntry.js) + @($scriptEntry.css)) { if ($path) { [void]$required.Add([string]$path) } } }
    foreach ($path in $required) { if (-not (Get-AllenLocalAsset $root $path)) { throw 'package-invalid' } }
    $scripts = Read-AllenJson (Join-Path $root 'scripts/scripts.json') 1MB
    $plugins = Read-AllenJson (Join-Path $root 'plugins/plugins.json') 1MB
    if ($scripts -isnot [array] -or $plugins -isnot [array]) { throw 'package-invalid' }
    $ids = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($entry in $scripts) {
        if ($entry.id -isnot [string] -or -not $entry.id -or -not $ids.Add($entry.id) -or $entry.enabled -isnot [bool] -or $entry.file -isnot [string] -or $entry.file -notmatch '\.user\.js$') { throw 'package-invalid' }
        [void](Get-AllenArchivePath ('allen-toolbox/scripts/' + $entry.file))
        [void](Get-AllenLocalAsset $root ('scripts/' + $entry.file))
    }
    $ids.Clear()
    foreach ($plugin in $plugins) {
        if ($plugin.id -isnot [string] -or -not $plugin.id -or -not $ids.Add($plugin.id) -or (-not $plugin.file -and -not $plugin.css)) { throw 'package-invalid' }
        foreach ($path in @($plugin.file, $plugin.css)) {
            if (-not $path) { continue }
            if ($path -notmatch '^plugins/.+\.(js|css)$') { throw 'package-invalid' }
            [void](Get-AllenArchivePath ('allen-toolbox/' + $path))
            [void](Get-AllenLocalAsset $root $path)
        }
    }
    foreach ($resource in @($manifest.web_accessible_resources)) {
        foreach ($path in @($resource.resources)) {
            if ($path -match '\*') {
                if ($path -match '(^/|\\|\.\.)' -or -not @(Get-ChildItem -LiteralPath $root -File -Recurse | Where-Object { $_.FullName.Substring($root.Length + 1).Replace('\', '/') -clike $path }).Count) { throw 'package-invalid' }
            } else { [void](Get-AllenLocalAsset $root $path) }
        }
    }
    foreach ($file in [IO.Directory]::EnumerateFiles($root, '*', [IO.SearchOption]::AllDirectories)) {
        $relative = $file.Substring($root.Length + 1).Replace('\', '/')
        # Vendored/minified libraries are covered by the explicit package inventory.
        if ($relative -match '^(scripts|lib|tests|tools|dist|updater)/|^\.' -or $relative -notmatch '\.(js|mjs|html|css)$') { continue }
        $text = [Text.Encoding]::UTF8.GetString((Read-AllenBytes $file 8MB))
        $base = [IO.Path]::GetDirectoryName($relative.Replace('/', '\'))
        $patterns = @()
        if ($relative -match '\.(js|mjs)$') {
            $patterns = @('(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)[''"]((?:\.{1,2}/|/)[^''"]+)[''"]', 'new\s+URL\s*\(\s*[''"]([^''"]+)[''"]\s*,\s*import\.meta\.url')
            foreach ($reference in [regex]::Matches($text, 'chrome\.runtime\.getURL\s*\(\s*[''"]([^''"]+)[''"]\s*\)')) { [void](Get-AllenLocalAsset $root $reference.Groups[1].Value) }
        }
        if ($relative -match '\.html$') { $patterns = @('(?i)\b(?:src|href)\s*=\s*[''"]([^''"]+)[''"]') }
        if ($relative -match '\.css$') { $patterns = @('(?i)url\(\s*[''"]?([^''")\s]+)') }
        foreach ($pattern in $patterns) { foreach ($reference in [regex]::Matches($text, $pattern)) { [void](Get-AllenLocalAsset $root $reference.Groups[1].Value $base) } }
    }
    return $manifest
}

function Assert-AllenAvailability([string]$Directory, [string]$Thumbprint, [string]$LauncherPath = '') {
    $path = Join-Path $Directory 'availability.json'
    if (-not [IO.File]::Exists($path)) { return }
    $metadata = Read-AllenJson $path 16KB
    if (@($metadata.PSObject.Properties.Name).Count -ne 5 -or $metadata.protocol -isnot [int] -or $metadata.protocol -ne 2 -or $metadata.available -isnot [bool] -or -not $metadata.available -or $metadata.reason -cne '' -or $metadata.publisherThumbprint -cne $Thumbprint) { throw 'signature-invalid' }
    $names = @('Install-ALLEN-Toolbox.cmd', 'updater/install.ps1', 'updater/updater.ps1', 'updater/public-key.json', 'updater/ALLEN-Toolbox-NativeHost.exe')
    if (@($metadata.files.PSObject.Properties.Name).Count -ne $names.Count) { throw 'package-invalid' }
    foreach ($name in $names) {
        $hash = $metadata.files.$name
        if ($hash -isnot [string] -or $hash -cnotmatch '^[a-f0-9]{64}$') { throw 'package-invalid' }
        if ($name -ceq 'Install-ALLEN-Toolbox.cmd') {
            $file = $LauncherPath
            if (-not $file) { $file = Join-Path $Directory $name }
        } else { $file = Join-Path $Directory ($name.Substring(8)) }
        if ((Get-AllenHexHash (Read-AllenBytes $file 2MB)) -cne $hash) { throw 'package-invalid' }
    }
}

function Test-AllenHelperStage($Config, [string]$Directory, [string]$LauncherPath = '') {
    foreach ($file in $script:AllenHelperFiles) { [void](Read-AllenBytes (Join-Path $Directory $file) 2MB) }
    [void](Assert-AllenHelperPublisher $Directory $Config.publisherThumbprint)
    Assert-AllenAvailability $Directory $Config.publisherThumbprint $LauncherPath
    $key = Get-AllenPublicKey (Join-Path $Directory 'public-key.json')
    if ($key.Fingerprint -cne $Config.publicKeyFingerprint) { throw 'signature-invalid' }
    foreach ($file in @('updater.ps1', 'install.ps1')) {
        $tokens = $null; $errors = $null
        $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $Directory $file), [ref]$tokens, [ref]$errors)
        if ($errors.Count) { throw 'package-invalid' }
        if ($file -eq 'updater.ps1') {
            $parameters = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
            foreach ($parameter in @('Command', 'Busy', 'Native', 'Scheduled', 'ClientId', 'ActivityRecorded')) { if ($parameter -notin $parameters) { throw 'package-invalid' } }
        }
    }
}

function Get-AllenTransactionPaths($Config, [string]$Token) {
    if ($Token -cnotmatch '^[a-f0-9]{32}$') { throw 'transaction-recovery-required' }
    $parent = [IO.Path]::GetDirectoryName($Config.extensionDirectory)
    return [pscustomobject]@{
        ExtensionStage = (Join-Path $parent ('.allen-toolbox-stage-' + $Token))
        ExtensionBackup = (Join-Path $parent ('.allen-toolbox-backup-' + $Token))
        HelperStage = (Join-Path $Config.helperDirectory ('.stage-' + $Token))
    }
}

function Remove-AllenStage([string]$Path) {
    if ([IO.Directory]::Exists($Path)) { Assert-AllenNoReparse $Path -Recurse; [IO.Directory]::Delete($Path, $true) }
}

function Restore-AllenTransaction($Config, $Journal, [bool]$IsBusy = $false) {
    if (Get-AllenDeferReason $Config $IsBusy $true) { throw 'transaction-recovery-required' }
    $paths = Get-AllenTransactionPaths $Config $Journal.token
    try {
        foreach ($owned in @($paths.ExtensionStage, $paths.ExtensionBackup, $paths.HelperStage)) { Assert-AllenNoReparse $owned -Recurse }
        # Authenticate every rollback script before replacing even the first helper file.
        foreach ($file in $script:AllenMutableHelperFiles) {
            $backup = Join-Path (Join-Path $paths.HelperStage 'backup') $file
            if ([IO.File]::Exists($backup)) { [void](Get-AllenCodeSigningPublisher $backup $Config.publisherThumbprint) }
        }
        $configBackup = Join-Path (Join-Path $paths.HelperStage 'backup') 'installation.json'
        if ([IO.File]::Exists($configBackup)) {
            $saved = Read-AllenJson $configBackup 16KB
            if ($saved.protocol -ne 2 -or $saved.helperDirectory -cne $Config.helperDirectory -or $saved.extensionDirectory -cne $Config.extensionDirectory -or $saved.publisherThumbprint -cne $Config.publisherThumbprint -or $saved.installationId -cne $Config.installationId -or $saved.repository -cne $script:AllenRepository -or $saved.installedVersion -cne $Journal.oldVersion) { throw 'transaction-recovery-required' }
        }
        foreach ($file in $script:AllenMutableHelperFiles + @('installation.json')) {
            $backup = Join-Path (Join-Path $paths.HelperStage 'backup') $file
            if ([IO.File]::Exists($backup)) { Write-AllenBytesAtomic (Join-Path $Config.helperDirectory $file) (Read-AllenBytes $backup 2MB) }
        }
        if ([IO.Directory]::Exists($paths.ExtensionBackup)) {
            if ([IO.Directory]::Exists($Config.extensionDirectory)) {
                [void](Get-AllenManifest $Config.extensionDirectory $Journal.newVersion)
                if ([IO.Directory]::Exists($paths.ExtensionStage)) { throw 'transaction-recovery-required' }
                [IO.Directory]::Move($Config.extensionDirectory, $paths.ExtensionStage)
            }
            [IO.Directory]::Move($paths.ExtensionBackup, $Config.extensionDirectory)
        }
        [void](Get-AllenManifest $Config.extensionDirectory $Journal.oldVersion)
        Remove-AllenStage $paths.ExtensionStage
        Remove-AllenStage $paths.HelperStage
        [IO.File]::Delete((Join-Path $Config.helperDirectory 'transaction.json'))
    } catch { throw 'transaction-recovery-required' }
}

function Repair-AllenTransaction($Config, [bool]$IsBusy = $false) {
    $path = Join-Path $Config.helperDirectory 'transaction.json'
    if (-not [IO.File]::Exists($path)) { return '' }
    # Recovery is a folder mutation, including when invoked by a status request.
    if (Get-AllenDeferReason $Config $IsBusy $true) { return 'recovery-deferred' }
    try {
        $journal = Read-AllenJson $path 16KB
        if ($journal.protocol -isnot [int] -or $journal.protocol -ne 2 -or $journal.extensionDirectory -cne $Config.extensionDirectory -or $journal.publisherThumbprint -cne $Config.publisherThumbprint -or $journal.installationId -cne $Config.installationId -or $journal.phase -notin @('prepared', 'old-moved', 'extension-committed', 'committed')) { throw 'transaction-recovery-required' }
        [void](Get-AllenVersionParts $journal.newVersion); [void](Get-AllenVersionParts $journal.oldVersion)
        $paths = Get-AllenTransactionPaths $Config $journal.token
        foreach ($owned in @($paths.ExtensionStage, $paths.ExtensionBackup, $paths.HelperStage)) { Assert-AllenNoReparse $owned -Recurse }
        if ($journal.phase -eq 'committed') {
            [void](Assert-AllenHelperPublisher $Config.helperDirectory $Config.publisherThumbprint)
            if (($journal.updatedAt -isnot [long] -and $journal.updatedAt -isnot [int]) -or $journal.updatedAt -le 0 -or $journal.updatedAt -gt (Get-AllenTime)) { throw 'transaction-recovery-required' }
            [void](Get-AllenManifest $Config.extensionDirectory $journal.newVersion)
            $state = Read-AllenState $Config
            $state.installedVersion = $journal.newVersion; $state.availableVersion = $null; $state.state = 'updated'; $state.error = ''
            $state.lastUpdatedAt = [long]$journal.updatedAt
            Write-AllenJsonAtomic (Join-Path $Config.helperDirectory 'state.json') $state
            Remove-AllenStage $paths.ExtensionStage; Remove-AllenStage $paths.HelperStage
            [IO.File]::Delete($path)
        } else { Restore-AllenTransaction $Config $journal $IsBusy }
    } catch { throw 'transaction-recovery-required' }
    return ''
}

function Invoke-AllenApplyRelease($Config, [string]$Token, [string]$Version, [scriptblock]$BeforeCommit = $null, [bool]$IsBusy = $false, [bool]$CheckBrowsers = $true) {
    $paths = Get-AllenTransactionPaths $Config $Token
    $journalPath = Join-Path $Config.helperDirectory 'transaction.json'
    if ([IO.File]::Exists($journalPath)) { throw 'transaction-recovery-required' }
    Test-AllenHelperStage $Config $paths.HelperStage
    [void](Test-AllenExtension $paths.ExtensionStage $Version)
    [void](Assert-AllenHelperPublisher $Config.helperDirectory $Config.publisherThumbprint)
    $reason = Get-AllenDeferReason $Config $IsBusy $CheckBrowsers
    if ($reason) { throw $reason }
    $old = Get-AllenManifest $Config.extensionDirectory
    if ((Compare-AllenVersions $Version $old.version) -le 0) { throw 'release-invalid' }
    $journal = [pscustomobject]@{ protocol = 2; token = $Token; installationId = $Config.installationId; publisherThumbprint = $Config.publisherThumbprint; extensionDirectory = $Config.extensionDirectory; oldVersion = $old.version; newVersion = $Version; phase = 'prepared'; updatedAt = [long]0 }
    $backup = Join-Path $paths.HelperStage 'backup'
    [void][IO.Directory]::CreateDirectory($backup)
    foreach ($file in $script:AllenMutableHelperFiles + @('installation.json')) {
        [IO.File]::Copy((Join-Path $Config.helperDirectory $file), (Join-Path $backup $file), $false)
    }
    Write-AllenJsonAtomic $journalPath $journal
    try {
        $reason = Get-AllenDeferReason $Config $IsBusy $CheckBrowsers
        if ($reason) { throw $reason }
        [IO.Directory]::Move($Config.extensionDirectory, $paths.ExtensionBackup)
        $journal.phase = 'old-moved'; Write-AllenJsonAtomic $journalPath $journal
        [IO.Directory]::Move($paths.ExtensionStage, $Config.extensionDirectory)
        $journal.phase = 'extension-committed'; Write-AllenJsonAtomic $journalPath $journal
        [void](Assert-AllenHelperPublisher $paths.HelperStage $Config.publisherThumbprint)
        foreach ($file in $script:AllenMutableHelperFiles) {
            [void](Get-AllenCodeSigningPublisher (Join-Path $paths.HelperStage $file) $Config.publisherThumbprint)
            Write-AllenBytesAtomic (Join-Path $Config.helperDirectory $file) (Read-AllenBytes (Join-Path $paths.HelperStage $file) 2MB)
        }
        # The running native EXE and pinned public key are deliberately never replaced.
        if ($BeforeCommit) { & $BeforeCommit }
        [void](Get-AllenManifest $Config.extensionDirectory $Version)
        $updatedConfig = $Config.PSObject.Copy()
        $updatedConfig.installedVersion = $Version
        Write-AllenJsonAtomic (Join-Path $Config.helperDirectory 'installation.json') $updatedConfig
        $journal.updatedAt = Get-AllenTime; $journal.phase = 'committed'
        Write-AllenJsonAtomic $journalPath $journal
    } catch {
        Restore-AllenTransaction $Config $journal $IsBusy
        throw 'transaction-failed'
    }
    # Retain the previous extension directory, including any unexpected local files.
    [void](Repair-AllenTransaction $Config $IsBusy)
    return $journal.updatedAt
}

function Invoke-AllenUpdater(
    [ValidateSet('status', 'check', 'update')][string]$Action,
    [bool]$IsBusy = $false, [bool]$IsScheduled = $false, [bool]$IsNative = $false,
    [string]$HelperDirectory = $script:AllenUpdaterDirectory, [string]$Id = '', [bool]$AlreadyRecorded = $false
) {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $state = New-AllenState
    $config = $null; $lock = $null; $paths = $null
    try {
        $config = Get-AllenInstallation $HelperDirectory
        # Heartbeats must remain writable while a different process holds the update lock.
        if ($IsNative) {
            Assert-AllenClientId $Id
            # The native reader already recorded this request; a delayed child must not
            # overwrite a newer busy heartbeat from the same stdin/client.
            if (-not $AlreadyRecorded) { Write-AllenActivity $config $IsBusy $Id }
        }
        $state = Read-AllenState $config
        try { $lock = Enter-AllenLock $config } catch {
            if ($_.Exception.Message -ne 'update-in-progress') { throw }
            try { $state.installedVersion = (Get-AllenManifest $config.extensionDirectory).version } catch { $state.installedVersion = $config.installedVersion }
            $state.state = 'deferred'; $state.error = 'update-in-progress'
            return $state
        }
        $config = Get-AllenInstallation $HelperDirectory
        if ([IO.File]::Exists((Join-Path (Get-AllenControlledRoot) 'install-transaction.json'))) { $state.state = 'deferred'; $state.error = 'recovery-deferred'; $state.installedVersion = $config.installedVersion; return $state }
        $recovery = Repair-AllenTransaction $config $IsBusy
        if ($recovery) {
            try { $state.installedVersion = (Get-AllenManifest $config.extensionDirectory).version } catch { $state.installedVersion = $config.installedVersion }
            $state.state = 'deferred'; $state.error = $recovery
            return $state
        }
        $state = Read-AllenState $config
        $state.installedVersion = (Get-AllenManifest $config.extensionDirectory).version
        if ($state.availableVersion -and (Compare-AllenVersions $state.availableVersion $state.installedVersion) -le 0) { $state.availableVersion = $null; $state.state = 'up-to-date'; $state.error = '' }
        if ($Action -eq 'status') { return $state }
        if ($Action -eq 'update') {
            $reason = Get-AllenDeferReason $config $IsBusy ($IsScheduled -or -not $IsNative)
            if ($reason) { $state.state = 'deferred'; $state.error = $reason; Write-AllenJsonAtomic (Join-Path $config.helperDirectory 'state.json') $state; return $state }
        }
        $state.lastCheckedAt = Get-AllenTime
        $release = Get-AllenRelease
        $state.error = ''
        if ((Compare-AllenVersions $release.Version $state.installedVersion) -le 0) {
            $state.availableVersion = $null; $state.state = 'up-to-date'
        } else {
            $state.availableVersion = $release.Version; $state.state = 'available'
            if ($Action -eq 'update') {
                $archive = Get-AllenHttpBytes $release.ZipUrl $script:AllenArchiveLimit 60 $release.ZipUrl
                $signature = Get-AllenHttpBytes $release.SignatureUrl 8KB 15 $release.SignatureUrl
                if ($archive.LongLength -ne $release.ZipSize -or $signature.Length -ne $release.SignatureSize) { throw 'release-invalid' }
                Assert-AllenSignature $archive $signature (Join-Path $config.helperDirectory 'public-key.json')
                $token = [Guid]::NewGuid().ToString('N')
                $paths = Get-AllenTransactionPaths $config $token
                foreach ($stage in @($paths.ExtensionStage, $paths.HelperStage)) {
                    Assert-AllenNoReparse $stage
                    if ([IO.Directory]::Exists($stage) -or [IO.File]::Exists($stage)) { throw 'transaction-failed' }
                    [void][IO.Directory]::CreateDirectory($stage)
                }
                Expand-AllenVerifiedArchive $archive $paths.ExtensionStage $paths.HelperStage
                [void](Test-AllenExtension $paths.ExtensionStage $release.Version)
                Test-AllenHelperStage $config $paths.HelperStage
                $reason = Get-AllenDeferReason $config $IsBusy ($IsScheduled -or -not $IsNative)
                if ($reason) { $state.state = 'deferred'; $state.error = $reason }
                else {
                    $state.lastUpdatedAt = Invoke-AllenApplyRelease $config $token $release.Version $null $IsBusy ($IsScheduled -or -not $IsNative)
                    $state.installedVersion = (Get-AllenManifest $config.extensionDirectory $release.Version).version
                    $state.availableVersion = $null; $state.state = 'updated'
                }
            }
        }
        Write-AllenJsonAtomic (Join-Path $config.helperDirectory 'state.json') $state
    } catch {
        $code = $_.Exception.Message
        if ($code -notin $script:AllenErrorCodes) { $code = 'internal-error' }
        if ($config -and [IO.File]::Exists((Join-Path $config.helperDirectory 'transaction.json'))) { $code = 'transaction-recovery-required' }
        $state.state = 'error'; $state.error = $code
        if ($config -and $lock -and $Action -ne 'status') {
            try { $state.installedVersion = (Get-AllenManifest $config.extensionDirectory).version } catch { $state.installedVersion = $null }
            try { Write-AllenJsonAtomic (Join-Path $config.helperDirectory 'state.json') $state } catch { }
        }
    } finally {
        if ($paths -and $config -and -not [IO.File]::Exists((Join-Path $config.helperDirectory 'transaction.json'))) {
            try { Remove-AllenStage $paths.ExtensionStage; Remove-AllenStage $paths.HelperStage } catch { }
        }
        if ($lock) { $lock.Dispose() }
    }
    return $state
}

# Dot-sourcing exposes pure/testable functions and never invokes an update or installer.
if ($MyInvocation.InvocationName -ne '.') {
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    $reply = Invoke-AllenUpdater $Command ([bool]$Busy) ([bool]$Scheduled) ([bool]$Native) $script:AllenUpdaterDirectory $ClientId ([bool]$ActivityRecorded)
    ConvertTo-Json -InputObject $reply -Depth 8 -Compress
}
