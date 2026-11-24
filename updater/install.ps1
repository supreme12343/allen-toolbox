[CmdletBinding()]
param(
    [string]$SourceDirectory = '',
    [string]$ExtensionDirectory = '',
    [switch]$Attach,
    [switch]$Uninstall,
    [switch]$ConsoleConsent
)

$script:AllenInstallerDirectory = $PSScriptRoot
# Check the bundle before loading any companion script, even when dot-sourced.
function Get-AllenInstallerPublisher([string]$Directory) {
    $publisher = $null
    try {
        foreach ($file in @('install.ps1', 'updater.ps1', 'ALLEN-Toolbox-NativeHost.exe')) {
            $path = Join-Path $Directory $file
            for ($cursor = $path; $cursor; $cursor = [IO.Path]::GetDirectoryName($cursor)) {
                try { $attributes = [IO.File]::GetAttributes($cursor) }
                catch [IO.FileNotFoundException] { throw 'signature-invalid' }
                catch [IO.DirectoryNotFoundException] { throw 'signature-invalid' }
                if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'signature-invalid' }
            }
            $signature = Get-AuthenticodeSignature -LiteralPath $path -ErrorAction Stop
            $certificate = $signature.SignerCertificate
            if ([string]$signature.Status -cne 'Valid' -or $null -eq $certificate -or $certificate.Thumbprint -cnotmatch '^[A-F0-9]{40}$' -or $certificate.NotBefore.ToUniversalTime() -gt [DateTime]::UtcNow -or $certificate.NotAfter.ToUniversalTime() -lt [DateTime]::UtcNow) { throw 'signature-invalid' }
            $codeSigning = $false
            foreach ($extension in $certificate.Extensions) {
                if ($extension.Oid.Value -eq '2.5.29.37') {
                    foreach ($usage in ([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]$extension).EnhancedKeyUsages) { if ($usage.Value -eq '1.3.6.1.5.5.7.3.3') { $codeSigning = $true } }
                }
            }
            if (-not $codeSigning -or ($publisher -and $publisher.Thumbprint -cne $certificate.Thumbprint)) { throw 'signature-invalid' }
            $publisher = [pscustomobject]@{ Thumbprint = $certificate.Thumbprint; Certificate = $certificate }
        }
        return $publisher
    } catch { throw 'signature-invalid' }
}
try {
    $script:AllenInstallerPublisher = Get-AllenInstallerPublisher $PSScriptRoot
    . (Join-Path $PSScriptRoot 'updater.ps1')
} catch {
    if ($MyInvocation.InvocationName -eq '.') { throw 'signature-invalid' }
    [Console]::Error.WriteLine('ALLEN Toolbox installer failed: signature-invalid. No changes were approved or made.')
    exit 1
}
$script:AllenNativeHostName = 'com.supreme.allen_toolbox_updater_v2'

function Get-AllenPowerShellPath {
    return Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
}

function Get-AllenTaskArguments($Config) {
    return '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy AllSigned -File "' + (Join-Path $Config.helperDirectory 'updater.ps1') + '" -Command update -Scheduled'
}

function Get-AllenTaskDescription($Config) {
    return 'ALLEN Toolbox signed updater, protocol 2; helper: ' + $Config.helperDirectory
}

function Get-AllenRegistrationSpecs {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
        foreach ($browser in @('Google\Chrome', 'Microsoft\Edge', 'BraveSoftware\Brave-Browser')) {
            [pscustomobject]@{ View = $view; Path = ('Software\' + $browser + '\NativeMessagingHosts\' + $script:AllenNativeHostName) }
        }
    }
}

function Get-AllenInstallPlan([string]$Source = '', [string]$Extension = '', [bool]$IsAttach = $false, [bool]$IsUninstall = $false) {
    $publisher = Get-AllenInstallerPublisher $script:AllenInstallerDirectory
    $root = Get-AllenControlledRoot
    $helper = Join-Path $root 'updater'
    if ($IsUninstall) {
        if ($Source -or $Extension -or $IsAttach) { throw 'installation-invalid' }
        $config = Get-AllenInstallation -HelperDirectory $helper -ForUninstall
        return [pscustomobject]@{ Root = $root; Helper = $helper; Extension = $config.extensionDirectory; Source = ''; Attach = $true; Uninstall = $true; Reinstall = $false; Config = $config; Publisher = $publisher; AddPublisher = $false; Journal = $null }
    }
    $existing = $null
    if ([IO.File]::Exists($helper)) { throw 'installation-invalid' }
    if ([IO.Directory]::Exists($helper)) {
        # A directory without valid ownership metadata is never adopted or deleted.
        $existing = Get-AllenInstallation -HelperDirectory $helper -ForUninstall
        if ($existing.publisherThumbprint -cne $publisher.Thumbprint) { throw 'signature-invalid' }
        if ($Extension -and (Get-AllenFullPath $Extension) -cne $existing.extensionDirectory) { throw 'installation-invalid' }
        $Extension = $existing.extensionDirectory
        $IsAttach = $true
    }
    $journal = Read-AllenInstallJournal $root
    if ($journal) {
        if ($journal.config.publisherThumbprint -cne $publisher.Thumbprint -or ($existing -and $existing.installationId -cne $journal.config.installationId)) { throw 'installation-invalid' }
        if ($Extension -and (Get-AllenFullPath $Extension) -cne $journal.config.extensionDirectory) { throw 'installation-invalid' }
        $Extension = $journal.config.extensionDirectory
        $IsAttach = [bool]$journal.attach
    }
    if ($IsAttach -and -not $Extension) { throw 'installation-invalid' }
    if (-not $Extension) { $Extension = Join-Path $root 'extension' }
    $extensionPath = Assert-AllenUserDirectory $Extension
    if ($extensionPath.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or $extensionPath.Equals($helper, [StringComparison]::OrdinalIgnoreCase) -or $extensionPath.StartsWith($helper + '\', [StringComparison]::OrdinalIgnoreCase) -or $helper.StartsWith($extensionPath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'installation-invalid' }
    if ($IsAttach) {
        $sourcePath = $extensionPath
    } else {
        if (-not $Source) { $Source = Join-Path ([IO.Path]::GetDirectoryName($script:AllenInstallerDirectory)) 'allen-toolbox' }
        $sourcePath = Get-AllenFullPath $Source
        if ([IO.Directory]::Exists($extensionPath) -or [IO.File]::Exists($extensionPath)) {
            if (-not $journal -or -not (Test-AllenInstalledExtensionOwner $extensionPath $journal.config)) { throw 'extension-path-exists' }
            $sourcePath = $extensionPath
        }
    }
    $manifest = Test-AllenExtension $sourcePath
    foreach ($file in $script:AllenHelperFiles) { [void](Read-AllenBytes (Join-Path $script:AllenInstallerDirectory $file) 2MB) }
    $key = Get-AllenPublicKey (Join-Path $script:AllenInstallerDirectory 'public-key.json')
    $sid = Get-AllenCurrentUserSid
    $config = [pscustomobject][ordered]@{
        protocol = 2; owner = 'ALLEN Toolbox'; repository = $script:AllenRepository
        helperDirectory = $helper; extensionDirectory = $extensionPath; extensionId = (Get-AllenExtensionId $extensionPath)
        publicKeyFingerprint = $key.Fingerprint; installedVersion = $manifest.version
        publisherThumbprint = $publisher.Thumbprint; installationId = [Guid]::NewGuid().ToString('D')
        installedAt = (Get-AllenTime); taskName = ('ALLEN Toolbox Updater-' + $sid); disabled = $true; installationState = 'installing'
        publisherTrust = [pscustomobject]@{ store = 'CurrentUser\TrustedPublisher'; introduced = $false; retainedOnUninstall = $true }
    }
    if ($existing) {
        if ($existing.publicKeyFingerprint -cne $key.Fingerprint) { throw 'signature-invalid' }
        $config.installationId = $existing.installationId; $config.installedAt = $existing.installedAt
        if ($existing.publisherTrust) { $config.publisherTrust = $existing.publisherTrust }
    }
    if ($journal) { $config = $journal.config }
    Test-AllenHelperStage $config $script:AllenInstallerDirectory (Join-Path ([IO.Path]::GetDirectoryName($script:AllenInstallerDirectory)) 'Install-ALLEN-Toolbox.cmd')
    return [pscustomobject]@{ Root = $root; Helper = $helper; Extension = $extensionPath; Source = $sourcePath; Attach = $IsAttach; Uninstall = $false; Reinstall = [bool]$existing; Config = $config; Publisher = $publisher; AddPublisher = (-not (Test-AllenPublisherTrusted $publisher.Thumbprint)); Journal = $journal }
}

function Test-AllenPublisherTrusted([string]$Thumbprint) {
    foreach ($location in @([Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser, [Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine)) {
        $store = New-Object Security.Cryptography.X509Certificates.X509Store('TrustedPublisher', $location)
        try {
            $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
            if (@($store.Certificates.Find([Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $Thumbprint, $false)).Count) { return $true }
        } finally { $store.Close() }
    }
    return $false
}

function Add-AllenVerifiedPublisher($Publisher) {
    # This is reachable only after the install consent explicitly names this leaf/store.
    $verified = Get-AllenInstallerPublisher $script:AllenInstallerDirectory
    if ($verified.Thumbprint -cne $Publisher.Thumbprint) { throw 'signature-invalid' }
    if (Test-AllenPublisherTrusted $Publisher.Thumbprint) { return $false }
    $store = New-Object Security.Cryptography.X509Certificates.X509Store('TrustedPublisher', [Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser)
    try {
        $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
        $store.Add($verified.Certificate)
    } finally { $store.Close() }
    if (-not (Test-AllenPublisherTrusted $Publisher.Thumbprint)) { throw 'publisher-not-trusted' }
    return $true
}

function Read-AllenInstallJournal([string]$Root) {
    $path = Join-Path $Root 'install-transaction.json'
    if (-not [IO.File]::Exists($path)) { return $null }
    try {
        Assert-AllenOwnedPath $Root -Directory
        $journal = Read-AllenJson $path 32KB
        $config = $journal.config
        if ($journal.protocol -isnot [int] -or $journal.protocol -ne 2 -or $journal.owner -cne 'ALLEN Toolbox' -or $journal.userSid -cne (Get-AllenCurrentUserSid) -or $journal.token -cnotmatch '^[a-f0-9]{32}$' -or $journal.attach -isnot [bool] -or $config.protocol -ne 2 -or $config.owner -cne 'ALLEN Toolbox' -or $config.repository -cne $script:AllenRepository -or $config.helperDirectory -cne (Join-Path $Root 'updater') -or $config.publisherThumbprint -cnotmatch '^[A-F0-9]{40}$' -or $config.taskName -cne ('ALLEN Toolbox Updater-' + (Get-AllenCurrentUserSid))) { throw 'transaction-recovery-required' }
        Assert-AllenClientId $config.installationId
        $extension = Assert-AllenUserDirectory $config.extensionDirectory
        if ($extension -cne $config.extensionDirectory -or $extension.Equals($Root, [StringComparison]::OrdinalIgnoreCase) -or $extension.Equals($config.helperDirectory, [StringComparison]::OrdinalIgnoreCase) -or $extension.StartsWith($config.helperDirectory + '\', [StringComparison]::OrdinalIgnoreCase) -or $config.helperDirectory.StartsWith($extension + '\', [StringComparison]::OrdinalIgnoreCase) -or $config.extensionId -cne (Get-AllenExtensionId $extension)) { throw 'transaction-recovery-required' }
        [void](Get-AllenVersionParts $config.installedVersion)
        return $journal
    } catch { throw 'transaction-recovery-required' }
}

function Get-AllenInstallStagePaths($Plan, [string]$Token) {
    if ($Token -cnotmatch '^[a-f0-9]{32}$') { throw 'transaction-recovery-required' }
    return [pscustomobject]@{
        Helper = (Join-Path $Plan.Root ('.install-' + $Token))
        Extension = (Join-Path ([IO.Path]::GetDirectoryName($Plan.Extension)) ('.allen-toolbox-install-' + $Token))
    }
}

function New-AllenOwnership($Config) {
    return [pscustomobject]@{ protocol = 2; owner = 'ALLEN Toolbox'; userSid = (Get-AllenCurrentUserSid); helperDirectory = $Config.helperDirectory; installationId = $Config.installationId; publisherThumbprint = $Config.publisherThumbprint }
}

function Test-AllenInstalledExtensionOwner([string]$Directory, $Config) {
    try {
        $owner = Read-AllenJson (Join-Path $Directory '.allen-installation.json') 8KB
        return $owner.protocol -eq 2 -and $owner.owner -ceq 'ALLEN Toolbox' -and $owner.userSid -ceq (Get-AllenCurrentUserSid) -and $owner.helperDirectory -ceq $Config.helperDirectory -and $owner.installationId -ceq $Config.installationId -and $owner.publisherThumbprint -ceq $Config.publisherThumbprint
    } catch { return $false }
}

function Get-AllenConsentText($Plan) {
    $hostManifest = Join-Path $Plan.Helper 'host.json'
    $instructions = '& "' + (Get-AllenPowerShellPath) + '" -NoProfile -ExecutionPolicy AllSigned -File "' + (Join-Path $Plan.Helper 'install.ps1') + '" -Uninstall'
    if ($Plan.Uninstall) {
        return @"
Uninstall the ALLEN Toolbox external updater for this Windows user?

Remove ONLY the owned hourly/logon task: $($Plan.Config.taskName)
Remove ONLY owned Chrome, Edge and Brave HKCU native host registrations:
$script:AllenNativeHostName (32-bit and 64-bit views)
Registration target: $hostManifest
Remove owned helper files: $($Plan.Helper)
Keep disabled ownership metadata if unknown helper files remain.
KEEP publisher leaf certificates: they can be shared with other software.

KEEP the unpacked extension folder: $($Plan.Extension)
KEEP all browser profiles, extension storage, downloads and extension backups.
This does not unload/remove the extension in Chrome, Edge or Brave.

Default is No/Cancel. Downloading or reading a README is never consent.
"@
    }
    $operation = 'Copy bundled extension files'
    if ($Plan.Attach) { $operation = 'Keep the existing unpacked extension folder in place' }
    $publisherAction = 'The verified publisher is already trusted; no certificate will be added.'
    if ($Plan.AddPublisher) { $publisherAction = 'ADD ONLY the verified code-signing leaf to CurrentUser\TrustedPublisher after this approval. It is retained on uninstall because the publisher can be shared.' }
    return @"
Install ALLEN Toolbox and its external updater for this Windows user?

$operation
Source extension: $($Plan.Source)
Permanent unpacked extension: $($Plan.Extension)
Permanent helper: $($Plan.Helper)
Extension version: $($Plan.Config.installedVersion)
Computed extension ID: $($Plan.Config.extensionId)

The helper will contact ONLY the official public repository over HTTPS:
$script:AllenRepository
It checks/updates hourly and at logon using task: $($Plan.Config.taskName)
Only stable ZIP releases with a pinned RSA-SHA256 signature can replace files.
ZIP signing is NOT Windows Authenticode signing. Every executable/helper script
must also have a valid Authenticode signature from the pinned publisher.
Background updates defer while supported browsers run. Native updates defer
when the extension reports active downloads. Prior extension folders are retained
as backups beside the extension, so unexpected local files are not deleted.

Register native host $script:AllenNativeHostName for Chrome, Edge and Brave
under HKCU Software\{Google\Chrome,Microsoft\Edge,BraveSoftware\Brave-Browser}\NativeMessagingHosts
(32-bit and 64-bit views), pointing to: $hostManifest
Allow ONLY chrome-extension://$($Plan.Config.extensionId)/
No administrator rights, browser Preferences/profile edits, or global policy changes.
PowerShell helper/task processes use AllSigned. Enterprise policy is not bypassed.
Verified CodeSigning publisher thumbprint: $($Plan.Publisher.Thumbprint)
Certificate store: CurrentUser\TrustedPublisher (verified leaf ONLY, never TrustedRoot)
$publisherAction
Create per-user owned lock/activity/installation recovery metadata under: $($Plan.Root)
Interrupted installation can be resumed by this signed installer; unknown files stay.

You must still enable Developer mode and use Load unpacked ONCE in each browser:
$($Plan.Extension)
No store/enterprise restrictions are bypassed.

Uninstall later (asks again; keeps the extension and all browser data):
$instructions

Default is No/Cancel. Downloading or reading a README is never consent.
Only choose Yes or type INSTALL if you explicitly approve these changes.
"@
}

function Request-AllenConsent($Plan, [bool]$UseConsole = $false) {
    $text = Get-AllenConsentText $Plan
    $word = 'INSTALL'
    if ($Plan.Uninstall) { $word = 'UNINSTALL' }
    if (-not $UseConsole) {
        try {
            Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
            $answer = [Windows.Forms.MessageBox]::Show($text, 'ALLEN Toolbox - Explicit Approval Required', [Windows.Forms.MessageBoxButtons]::YesNo, [Windows.Forms.MessageBoxIcon]::Question, [Windows.Forms.MessageBoxDefaultButton]::Button2)
            return $answer -eq [Windows.Forms.DialogResult]::Yes
        } catch { }
    }
    try {
        Write-Host $text
        $answer = Read-Host "Type $word to approve, or press Enter to cancel"
        return $answer -ceq $word
    } catch { return $false }
}

function Assert-AllenInstallSlots($Config) {
    foreach ($spec in Get-AllenRegistrationSpecs) {
        $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $spec.View)
        $key = $null
        try {
            $key = $root.OpenSubKey($spec.Path)
            if ($key -and ($key.GetValue('ALLENToolboxOwner') -cne $Config.helperDirectory -or $key.GetValue('') -cne (Join-Path $Config.helperDirectory 'host.json'))) { throw 'registration-exists' }
        } finally { if ($key) { $key.Dispose() }; $root.Dispose() }
    }
    $task = Get-ScheduledTask -TaskName $Config.taskName -TaskPath '\' -ErrorAction SilentlyContinue
    if ($task -and ($task.Description -cne (Get-AllenTaskDescription $Config) -or @($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -cne (Get-AllenPowerShellPath) -or $task.Actions[0].Arguments -cne (Get-AllenTaskArguments $Config))) { throw 'task-exists' }
}

function Register-AllenNativeHost($Config) {
    foreach ($spec in Get-AllenRegistrationSpecs) {
        $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $spec.View)
        $key = $null
        try {
            $key = $root.CreateSubKey($spec.Path)
            if ($key.SubKeyCount -or ($key.ValueCount -and ($key.GetValue('ALLENToolboxOwner') -cne $Config.helperDirectory -or $key.GetValue('') -cne (Join-Path $Config.helperDirectory 'host.json')))) { throw 'registration-exists' }
            $key.SetValue('ALLENToolboxOwner', $Config.helperDirectory, [Microsoft.Win32.RegistryValueKind]::String)
            $key.SetValue('', (Join-Path $Config.helperDirectory 'host.json'), [Microsoft.Win32.RegistryValueKind]::String)
        } finally { if ($key) { $key.Dispose() }; $root.Dispose() }
    }
}

function Unregister-AllenNativeHost($Config) {
    foreach ($spec in Get-AllenRegistrationSpecs) {
        $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $spec.View)
        $key = $null; $empty = $false
        try {
            $key = $root.OpenSubKey($spec.Path, $true)
            if (-not $key) { continue }
            if ($key.GetValue('ALLENToolboxOwner') -cne $Config.helperDirectory -or ($null -ne $key.GetValue('') -and $key.GetValue('') -cne (Join-Path $Config.helperDirectory 'host.json'))) { continue }
            $key.DeleteValue('', $false); $key.DeleteValue('ALLENToolboxOwner', $false)
            $empty = $key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0
            $key.Dispose(); $key = $null
            if ($empty) { $root.DeleteSubKey($spec.Path, $false) }
        } finally { if ($key) { $key.Dispose() }; $root.Dispose() }
    }
}

function Register-AllenTask($Config) {
    $existing = Get-ScheduledTask -TaskName $Config.taskName -TaskPath '\' -ErrorAction SilentlyContinue
    if ($existing) {
        if ($existing.Description -cne (Get-AllenTaskDescription $Config) -or @($existing.Actions).Count -ne 1 -or $existing.Actions[0].Execute -cne (Get-AllenPowerShellPath) -or $existing.Actions[0].Arguments -cne (Get-AllenTaskArguments $Config)) { throw 'task-exists' }
        return
    }
    $action = New-ScheduledTaskAction -Execute (Get-AllenPowerShellPath) -Argument (Get-AllenTaskArguments $Config)
    $hourly = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(5)) -RepetitionInterval (New-TimeSpan -Hours 1)
    $sid = Get-AllenCurrentUserSid
    $logon = New-ScheduledTaskTrigger -AtLogOn -User $sid
    $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $task = New-ScheduledTask -Action $action -Trigger @($hourly, $logon) -Principal $principal -Settings $settings -Description (Get-AllenTaskDescription $Config)
    [void](Register-ScheduledTask -TaskName $Config.taskName -TaskPath '\' -InputObject $task -ErrorAction Stop)
}

function Unregister-AllenTask($Config) {
    $task = Get-ScheduledTask -TaskName $Config.taskName -TaskPath '\' -ErrorAction SilentlyContinue
    if (-not $task) { return }
    if ($task.Description -cne (Get-AllenTaskDescription $Config) -or @($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -cne (Get-AllenPowerShellPath) -or $task.Actions[0].Arguments -cne (Get-AllenTaskArguments $Config)) { throw 'installation-invalid' }
    Unregister-ScheduledTask -TaskName $Config.taskName -TaskPath '\' -Confirm:$false -ErrorAction Stop
}

function Copy-AllenExtension([string]$Source, [string]$Destination, [switch]$Resume) {
    $paths = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    $inventory = [Text.Encoding]::UTF8.GetString((Read-AllenBytes (Join-Path $Source 'shared/package.js') 2MB))
    $match = [regex]::Match($inventory, 'export\s+const\s+EXTENSION_ASSETS\s*=\s*Object\.freeze\(\s*\[(.*?)\]\s*\)', [Text.RegularExpressions.RegexOptions]::Singleline)
    if (-not $match.Success) { throw 'package-invalid' }
    foreach ($item in [regex]::Matches($match.Groups[1].Value, '[''"]([^''"]+)[''"]')) { [void]$paths.Add($item.Groups[1].Value) }
    foreach ($path in @('manifest.json', 'scripts/scripts.json', 'plugins/plugins.json')) { [void]$paths.Add($path) }
    foreach ($entry in (Read-AllenJson (Join-Path $Source 'scripts/scripts.json'))) { [void]$paths.Add('scripts/' + $entry.file) }
    foreach ($plugin in (Read-AllenJson (Join-Path $Source 'plugins/plugins.json'))) { foreach ($path in @($plugin.file, $plugin.css)) { if ($path) { [void]$paths.Add($path) } } }
    foreach ($path in $paths) {
        [void](Get-AllenArchivePath ('allen-toolbox/' + $path))
        $relative = Get-AllenLocalAsset $Source $path
        $target = Join-Path $Destination $relative.Replace('/', '\')
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
        Assert-AllenNoReparse $target
        if ($Resume -and [IO.File]::Exists($target)) { Write-AllenBytesAtomic $target (Read-AllenBytes (Join-Path $Source $relative.Replace('/', '\')) 64MB) }
        else { [IO.File]::Copy((Join-Path $Source $relative.Replace('/', '\')), $target, $false) }
    }
    [void](Test-AllenExtension $Destination)
}

function Remove-AllenOwnedHelper($Config) {
    $helper = Assert-AllenUserDirectory $Config.helperDirectory
    $owned = Get-AllenInstallation -HelperDirectory $helper -ForUninstall
    if ($owned.installationId -cne $Config.installationId) { throw 'installation-invalid' }
    Assert-AllenNoReparse $helper -Recurse
    if ([IO.File]::Exists((Join-Path $helper 'transaction.json'))) { throw 'transaction-recovery-required' }
    # Unknown files are left alone; uninstall never recursively deletes an extension.
    foreach ($file in @('ALLEN-Toolbox-NativeHost.exe', 'updater.ps1', 'install.ps1', 'public-key.json', 'host.json', 'state.json', 'availability.json')) {
        $path = Join-Path $helper $file
        if ([IO.File]::Exists($path)) {
            try { [IO.File]::Delete($path) }
            catch [IO.IOException] { throw 'helper-files-in-use' }
            catch [UnauthorizedAccessException] { throw 'helper-files-in-use' }
        }
    }
    $remaining = @([IO.Directory]::EnumerateFileSystemEntries($helper) | Where-Object { [IO.Path]::GetFileName($_) -notin @('installation.json', 'ownership.json') })
    if ($remaining.Count) {
        $disabled = $owned.PSObject.Copy(); $disabled.disabled = $true; $disabled.installationState = 'uninstalled'
        Write-AllenJsonAtomic (Join-Path $helper 'installation.json') $disabled
    } else {
        [IO.File]::Delete((Join-Path $helper 'installation.json'))
        [IO.File]::Delete((Join-Path $helper 'ownership.json'))
        [IO.Directory]::Delete($helper)
    }
}

function Invoke-AllenInstaller([string]$Source = '', [string]$Extension = '', [bool]$IsAttach = $false, [bool]$IsUninstall = $false, [bool]$UseConsole = $false) {
    $ErrorActionPreference = 'Stop'
    $plan = Get-AllenInstallPlan $Source $Extension $IsAttach $IsUninstall
    # No filesystem, registry or task mutations are reachable before explicit approval.
    if (-not (Request-AllenConsent $plan $UseConsole)) {
        return [pscustomobject]@{ cancelled = $true; installed = $false; uninstalled = $false; extensionDirectory = $plan.Extension }
    }
    $lock = $null
    try {
        [void](Get-AllenInstallerPublisher $script:AllenInstallerDirectory)
        New-AllenOwnedDirectory $plan.Root
        New-AllenOwnedDirectory (Join-Path $plan.Root 'locks')
        New-AllenOwnedDirectory (Join-Path $plan.Root 'activity')
        $lock = Enter-AllenLock $plan.Config
        if ($plan.Uninstall) {
            $current = Get-AllenInstallation -HelperDirectory $plan.Helper -ForUninstall
            if ($current.installationId -cne $plan.Config.installationId) { throw 'installation-invalid' }
            if (Repair-AllenTransaction $current) { throw 'recovery-deferred' }
            # Existing native connections cannot continue updates if the EXE is locked.
            $disabledConfig = $plan.Config.PSObject.Copy(); $disabledConfig.disabled = $true
            Write-AllenJsonAtomic (Join-Path $plan.Helper 'installation.json') $disabledConfig
            Unregister-AllenTask $plan.Config
            Unregister-AllenNativeHost $plan.Config
            $pending = Read-AllenInstallJournal $plan.Root
            if ($pending -and $pending.config.installationId -cne $plan.Config.installationId) { throw 'installation-invalid' }
            Remove-AllenOwnedHelper $plan.Config
            if ($pending) { [IO.File]::Delete((Join-Path $plan.Root 'install-transaction.json')) }
            return [pscustomobject]@{ cancelled = $false; installed = $false; uninstalled = $true; extensionDirectory = $plan.Extension }
        }
        Assert-AllenInstallSlots $plan.Config
        Assert-AllenNoReparse $plan.Helper
        if ([IO.File]::Exists($plan.Helper)) { throw 'installation-invalid' }
        $existing = $null
        if ([IO.Directory]::Exists($plan.Helper)) {
            $existing = Get-AllenInstallation -HelperDirectory $plan.Helper -ForUninstall
            if ($existing.installationId -cne $plan.Config.installationId -or $existing.publisherThumbprint -cne $plan.Config.publisherThumbprint) { throw 'installation-invalid' }
            if (Repair-AllenTransaction $existing) { throw 'recovery-deferred' }
        }
        Test-AllenHelperStage $plan.Config $script:AllenInstallerDirectory (Join-Path ([IO.Path]::GetDirectoryName($script:AllenInstallerDirectory)) 'Install-ALLEN-Toolbox.cmd')
        $journal = Read-AllenInstallJournal $plan.Root
        if ($journal -and $journal.config.installationId -cne $plan.Config.installationId) { throw 'transaction-recovery-required' }
        if (-not $journal) {
            $journal = [pscustomobject]@{ protocol = 2; owner = 'ALLEN Toolbox'; userSid = (Get-AllenCurrentUserSid); token = [Guid]::NewGuid().ToString('N'); attach = [bool]$plan.Attach; config = $plan.Config }
        }
        $stages = Get-AllenInstallStagePaths $plan $journal.token
        if ([IO.Directory]::Exists($stages.Helper)) {
            try {
                $owner = Read-AllenJson (Join-Path $stages.Helper 'ownership.json') 8KB
                if ($owner.protocol -isnot [int] -or $owner.protocol -ne 2 -or $owner.owner -cne 'ALLEN Toolbox' -or $owner.installationId -cne $plan.Config.installationId -or $owner.helperDirectory -cne $plan.Helper -or $owner.publisherThumbprint -cne $plan.Config.publisherThumbprint -or $owner.userSid -cne (Get-AllenCurrentUserSid)) { throw 'installation-invalid' }
            } catch {
                # Preserve an unowned interrupted stage; use a new owned stage instead.
                $journal.token = [Guid]::NewGuid().ToString('N')
                $stages = Get-AllenInstallStagePaths $plan $journal.token
            }
        }
        $plan.Config.disabled = $true; $plan.Config.installationState = 'installing'
        $journal.config = $plan.Config
        # Persist recovery/ownership intent before helper, extension or registration work.
        Write-AllenJsonAtomic (Join-Path $plan.Root 'install-transaction.json') $journal
        New-AllenOwnedDirectory $stages.Helper
        Write-AllenJsonAtomic (Join-Path $stages.Helper 'ownership.json') (New-AllenOwnership $plan.Config)
        Write-AllenJsonAtomic (Join-Path $stages.Helper 'installation.json') $plan.Config
        foreach ($file in $script:AllenHelperFiles) { Write-AllenBytesAtomic (Join-Path $stages.Helper $file) (Read-AllenBytes (Join-Path $script:AllenInstallerDirectory $file) 2MB) }
        Test-AllenHelperStage $plan.Config $stages.Helper
        if ($existing) {
            Write-AllenJsonAtomic (Join-Path $plan.Helper 'installation.json') $plan.Config
            foreach ($file in $script:AllenHelperFiles) {
                if ($file -in $script:AllenSignedHelperFiles) { [void](Get-AllenCodeSigningPublisher (Join-Path $stages.Helper $file) $plan.Config.publisherThumbprint) }
                Write-AllenBytesAtomic (Join-Path $plan.Helper $file) (Read-AllenBytes (Join-Path $stages.Helper $file) 2MB)
            }
        } else {
            if ([IO.Directory]::Exists($plan.Helper) -or [IO.File]::Exists($plan.Helper)) { throw 'installation-invalid' }
            [IO.Directory]::Move($stages.Helper, $plan.Helper)
        }
        if (-not $journal.attach) {
            Assert-AllenNoReparse $plan.Extension
            if ([IO.Directory]::Exists($plan.Extension) -or [IO.File]::Exists($plan.Extension)) {
                if (-not (Test-AllenInstalledExtensionOwner $plan.Extension $plan.Config)) { throw 'extension-path-exists' }
            } else {
                if ([IO.Directory]::Exists($stages.Extension) -or [IO.File]::Exists($stages.Extension)) {
                    if (-not (Test-AllenInstalledExtensionOwner $stages.Extension $plan.Config)) { throw 'transaction-recovery-required' }
                    # Resume only the verified package inventory; preserve any unknown files.
                    Copy-AllenExtension $plan.Source $stages.Extension -Resume
                } else {
                    New-AllenOwnedDirectory $stages.Extension
                    Write-AllenJsonAtomic (Join-Path $stages.Extension '.allen-installation.json') (New-AllenOwnership $plan.Config)
                    Copy-AllenExtension $plan.Source $stages.Extension
                }
                [void](Test-AllenExtension $stages.Extension $plan.Config.installedVersion)
                [IO.Directory]::Move($stages.Extension, $plan.Extension)
            }
        }
        [void](Test-AllenExtension $plan.Extension $plan.Config.installedVersion)
        if ($plan.AddPublisher) {
            $plan.Config.publisherTrust.introduced = [bool](Add-AllenVerifiedPublisher $plan.Publisher)
            $journal.config = $plan.Config
            Write-AllenJsonAtomic (Join-Path $plan.Root 'install-transaction.json') $journal
        }
        if (-not (Test-AllenPublisherTrusted $plan.Config.publisherThumbprint)) { throw 'publisher-not-trusted' }
        $hostManifest = [pscustomobject][ordered]@{
            name = $script:AllenNativeHostName; description = 'ALLEN Toolbox signed external updater'
            path = (Join-Path $plan.Helper 'ALLEN-Toolbox-NativeHost.exe'); type = 'stdio'
            allowed_origins = @('chrome-extension://' + $plan.Config.extensionId + '/')
        }
        Write-AllenJsonAtomic (Join-Path $plan.Helper 'host.json') $hostManifest
        Register-AllenNativeHost $plan.Config
        Register-AllenTask $plan.Config
        $plan.Config.disabled = $false; $plan.Config.installationState = 'installed'
        Write-AllenJsonAtomic (Join-Path $plan.Helper 'installation.json') $plan.Config
        $state = Read-AllenState $plan.Config; $state.installedVersion = $plan.Config.installedVersion
        $state.state = 'up-to-date'; $state.error = ''; $state.availableVersion = $null
        Write-AllenJsonAtomic (Join-Path $plan.Helper 'state.json') $state
        [void](Get-AllenInstallation $plan.Helper)
        [IO.File]::Delete((Join-Path $plan.Root 'install-transaction.json'))
        if ([IO.Directory]::Exists($stages.Helper)) {
            foreach ($file in $script:AllenHelperFiles + @('installation.json', 'ownership.json')) { [IO.File]::Delete((Join-Path $stages.Helper $file)) }
            if (-not @([IO.Directory]::EnumerateFileSystemEntries($stages.Helper)).Count) { [IO.Directory]::Delete($stages.Helper) }
        }
        return [pscustomobject]@{ cancelled = $false; installed = $true; uninstalled = $false; extensionDirectory = $plan.Extension; extensionId = $plan.Config.extensionId; helperDirectory = $plan.Helper; taskName = $plan.Config.taskName }
    } finally { if ($lock) { $lock.Dispose() } }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $result = Invoke-AllenInstaller $SourceDirectory $ExtensionDirectory ([bool]$Attach) ([bool]$Uninstall) ([bool]$ConsoleConsent)
        if ($result.cancelled) { Write-Host 'Cancelled. Nothing was installed, uninstalled or registered.'; exit 2 }
        if ($result.uninstalled) { Write-Host ('Updater removed. Extension and all browser data were kept: ' + $result.extensionDirectory) }
        else {
            Write-Host ('Installed per-user helper: ' + $result.helperDirectory)
            Write-Host ('Extension ID: ' + $result.extensionId)
            Write-Host ('Enable Developer mode, then Load unpacked ONCE in Chrome, Edge or Brave: ' + $result.extensionDirectory)
            Write-Host 'No browser profile/store/enterprise settings were changed.'
        }
    } catch {
        $code = $_.Exception.Message
        if ($code -notin ($script:AllenErrorCodes + @('already-installed', 'extension-path-exists', 'registration-exists', 'task-exists', 'helper-files-in-use'))) { $code = 'installation-failed' }
        Write-Host ('ALLEN Toolbox installer failed: ' + $code + '. No administrator or policy changes were attempted.')
        if ($code -eq 'helper-files-in-use') { Write-Host 'Updater disabled. Close browser/native helper connections, then rerun -Uninstall to remove the locked helper files.' }
        exit 1
    }
}
