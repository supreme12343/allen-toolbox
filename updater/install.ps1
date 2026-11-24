[CmdletBinding()]
param(
    [string]$SourceDirectory = '',
    [string]$ExtensionDirectory = '',
    [switch]$Attach,
    [switch]$Uninstall,
    [switch]$ConsoleConsent
)

$script:AllenInstallerDirectory = $PSScriptRoot
. (Join-Path $PSScriptRoot 'updater.ps1')
$script:AllenNativeHostName = 'com.supreme.allen_toolbox_updater'

function Get-AllenPowerShellPath {
    return Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
}

function Get-AllenTaskArguments($Config) {
    return '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $Config.helperDirectory 'updater.ps1') + '" -Command update -Scheduled'
}

function Get-AllenTaskDescription($Config) {
    return 'ALLEN Toolbox signed updater, protocol 1; helper: ' + $Config.helperDirectory
}

function Get-AllenRegistrationSpecs {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
        foreach ($browser in @('Google\Chrome', 'Microsoft\Edge', 'BraveSoftware\Brave-Browser')) {
            [pscustomobject]@{ View = $view; Path = ('Software\' + $browser + '\NativeMessagingHosts\' + $script:AllenNativeHostName) }
        }
    }
}

function Get-AllenInstallPlan([string]$Source = '', [string]$Extension = '', [bool]$IsAttach = $false, [bool]$IsUninstall = $false) {
    $root = Assert-AllenUserDirectory (Join-Path $env:LOCALAPPDATA 'ALLENToolbox')
    $helper = Join-Path $root 'updater'
    if ($IsUninstall) {
        if ($Source -or $Extension -or $IsAttach) { throw 'installation-invalid' }
        $config = Get-AllenInstallation -HelperDirectory $helper -ForUninstall
        return [pscustomobject]@{ Root = $root; Helper = $helper; Extension = $config.extensionDirectory; Source = ''; Attach = $true; Uninstall = $true; Config = $config }
    }
    if ($IsAttach -and -not $Extension) { throw 'installation-invalid' }
    if (-not $Extension) { $Extension = Join-Path $root 'extension' }
    $extensionPath = Assert-AllenUserDirectory $Extension
    if ($extensionPath.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or $extensionPath.Equals($helper, [StringComparison]::OrdinalIgnoreCase) -or $extensionPath.StartsWith($helper + '\', [StringComparison]::OrdinalIgnoreCase) -or $helper.StartsWith($extensionPath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'installation-invalid' }
    if ([IO.File]::Exists($helper) -or [IO.Directory]::Exists($helper)) { throw 'already-installed' }
    if ($IsAttach) {
        $sourcePath = $extensionPath
    } else {
        if (-not $Source) { $Source = Join-Path ([IO.Path]::GetDirectoryName($script:AllenInstallerDirectory)) 'allen-toolbox' }
        $sourcePath = Get-AllenFullPath $Source
        if ([IO.Directory]::Exists($extensionPath) -or [IO.File]::Exists($extensionPath)) { throw 'extension-path-exists' }
    }
    $manifest = Test-AllenExtension $sourcePath
    foreach ($file in $script:AllenHelperFiles) { [void](Read-AllenBytes (Join-Path $script:AllenInstallerDirectory $file) 2MB) }
    $key = Get-AllenPublicKey (Join-Path $script:AllenInstallerDirectory 'public-key.json')
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $config = [pscustomobject][ordered]@{
        protocol = 1; owner = 'ALLEN Toolbox'; repository = $script:AllenRepository
        helperDirectory = $helper; extensionDirectory = $extensionPath; extensionId = (Get-AllenExtensionId $extensionPath)
        publicKeyFingerprint = $key.Fingerprint; installedVersion = $manifest.version
        installedAt = (Get-AllenTime); taskName = ('ALLEN Toolbox Updater-' + $sid); disabled = $false
    }
    return [pscustomobject]@{ Root = $root; Helper = $helper; Extension = $extensionPath; Source = $sourcePath; Attach = $IsAttach; Uninstall = $false; Config = $config }
}

function Get-AllenConsentText($Plan) {
    $hostManifest = Join-Path $Plan.Helper 'host.json'
    $instructions = '& "' + (Get-AllenPowerShellPath) + '" -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $Plan.Helper 'install.ps1') + '" -Uninstall'
    if ($Plan.Uninstall) {
        return @"
Uninstall the ALLEN Toolbox external updater for this Windows user?

Remove ONLY the owned hourly/logon task: $($Plan.Config.taskName)
Remove ONLY owned Chrome, Edge and Brave HKCU native host registrations:
$script:AllenNativeHostName (32-bit and 64-bit views)
Registration target: $hostManifest
Remove owned helper files: $($Plan.Helper)

KEEP the unpacked extension folder: $($Plan.Extension)
KEEP all browser profiles, extension storage, downloads and extension backups.
This does not unload/remove the extension in Chrome, Edge or Brave.

Default is No/Cancel. Downloading or reading a README is never consent.
"@
    }
    $operation = 'Copy bundled extension files'
    if ($Plan.Attach) { $operation = 'Keep the existing unpacked extension folder in place' }
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
Background updates defer while supported browsers run. Native updates defer
when the extension reports active downloads. Prior extension folders are retained
as backups beside the extension, so unexpected local files are not deleted.

Register native host $script:AllenNativeHostName for Chrome, Edge and Brave
under HKCU Software\{Google\Chrome,Microsoft\Edge,BraveSoftware\Brave-Browser}\NativeMessagingHosts
(32-bit and 64-bit views), pointing to: $hostManifest
Allow ONLY chrome-extension://$($Plan.Config.extensionId)/
No administrator rights, browser Preferences/profile edits, or global policy changes.
ExecutionPolicy Bypass applies only to helper PowerShell processes, not your system.

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
            if ($key) { throw 'registration-exists' }
        } finally { if ($key) { $key.Dispose() }; $root.Dispose() }
    }
    if (Get-ScheduledTask -TaskName $Config.taskName -TaskPath '\' -ErrorAction SilentlyContinue) { throw 'task-exists' }
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
    $action = New-ScheduledTaskAction -Execute (Get-AllenPowerShellPath) -Argument (Get-AllenTaskArguments $Config)
    $hourly = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(5)) -RepetitionInterval (New-TimeSpan -Hours 1)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
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

function Copy-AllenExtension([string]$Source, [string]$Destination) {
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
        [IO.File]::Copy((Join-Path $Source $relative.Replace('/', '\')), $target, $false)
    }
    [void](Test-AllenExtension $Destination)
}

function Remove-AllenOwnedHelper($Config) {
    $helper = Assert-AllenUserDirectory $Config.helperDirectory
    Assert-AllenNoReparse $helper -Recurse
    if ([IO.File]::Exists((Join-Path $helper 'transaction.json'))) { throw 'transaction-recovery-required' }
    # Unknown files are left alone; uninstall never recursively deletes an extension.
    foreach ($file in @('host.json', 'state.json', 'activity.json', 'ALLEN-Toolbox-NativeHost.exe', 'native-host.cs', 'updater.ps1', 'install.ps1', 'public-key.json', 'installation.json')) {
        $path = Join-Path $helper $file
        if ([IO.File]::Exists($path)) {
            try { [IO.File]::Delete($path) }
            catch [IO.IOException] { throw 'helper-files-in-use' }
            catch [UnauthorizedAccessException] { throw 'helper-files-in-use' }
        }
    }
    if ([IO.Directory]::Exists($helper) -and -not @([IO.Directory]::EnumerateFileSystemEntries($helper)).Count) { [IO.Directory]::Delete($helper) }
}

function Compile-AllenNativeHost([string]$HelperDirectory) {
    $helper = Assert-AllenUserDirectory $HelperDirectory
    $temporary = Join-Path $helper ('.compile-' + [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($temporary)
    try {
        $compiler = New-Object CodeDom.Compiler.CompilerParameters
        $compiler.TempFiles = New-Object CodeDom.Compiler.TempFileCollection($temporary, $false)
        $compiler.GenerateExecutable = $true; $compiler.GenerateInMemory = $false
        $compiler.OutputAssembly = Join-Path $helper 'ALLEN-Toolbox-NativeHost.exe'
        Add-Type -AssemblyName System.Web.Extensions -ErrorAction Stop
        foreach ($assembly in @([Uri].Assembly, [Linq.Enumerable].Assembly, [Web.Script.Serialization.JavaScriptSerializer].Assembly)) { [void]$compiler.ReferencedAssemblies.Add($assembly.Location) }
        Add-Type -Path (Join-Path $helper 'native-host.cs') -CompilerParameters $compiler -ErrorAction Stop
    } finally { Remove-AllenStage $temporary }
}

function Invoke-AllenInstaller([string]$Source = '', [string]$Extension = '', [bool]$IsAttach = $false, [bool]$IsUninstall = $false, [bool]$UseConsole = $false) {
    $ErrorActionPreference = 'Stop'
    $plan = Get-AllenInstallPlan $Source $Extension $IsAttach $IsUninstall
    # No filesystem, registry or task mutations are reachable before explicit approval.
    if (-not (Request-AllenConsent $plan $UseConsole)) {
        return [pscustomobject]@{ cancelled = $true; installed = $false; uninstalled = $false; extensionDirectory = $plan.Extension }
    }
    $mutex = New-Object Threading.Mutex($false, (Get-AllenMutexName $plan.Config))
    $held = $false
    try {
        try { $held = $mutex.WaitOne(2000) } catch [Threading.AbandonedMutexException] { $held = $true }
        if (-not $held) { throw 'update-in-progress' }
        if ($plan.Uninstall) {
            if ([IO.File]::Exists((Join-Path $plan.Helper 'transaction.json'))) { throw 'transaction-recovery-required' }
            # Existing native connections cannot continue updates if the EXE is locked.
            $disabledConfig = $plan.Config.PSObject.Copy(); $disabledConfig.disabled = $true
            Write-AllenJsonAtomic (Join-Path $plan.Helper 'installation.json') $disabledConfig
            Unregister-AllenTask $plan.Config
            Unregister-AllenNativeHost $plan.Config
            Remove-AllenOwnedHelper $plan.Config
            return [pscustomobject]@{ cancelled = $false; installed = $false; uninstalled = $true; extensionDirectory = $plan.Extension }
        }
        $helperCreated = $false; $extensionCreated = $false; $registered = $false; $taskRegistered = $false
        Assert-AllenInstallSlots $plan.Config
        Assert-AllenNoReparse $plan.Helper
        if ([IO.File]::Exists($plan.Helper) -or [IO.Directory]::Exists($plan.Helper)) { throw 'already-installed' }
        try {
            Assert-AllenNoReparse $plan.Root
            [void][IO.Directory]::CreateDirectory($plan.Helper)
            $helperCreated = $true
            foreach ($file in $script:AllenHelperFiles) { [IO.File]::Copy((Join-Path $script:AllenInstallerDirectory $file), (Join-Path $plan.Helper $file), $false) }
            Test-AllenHelperStage $plan.Config $plan.Helper
            Compile-AllenNativeHost $plan.Helper
            if (-not $plan.Attach) {
                Assert-AllenNoReparse $plan.Extension
                if ([IO.Directory]::Exists($plan.Extension) -or [IO.File]::Exists($plan.Extension)) { throw 'extension-path-exists' }
                [void][IO.Directory]::CreateDirectory($plan.Extension)
                $extensionCreated = $true
                Copy-AllenExtension $plan.Source $plan.Extension
            }
            [void](Test-AllenExtension $plan.Extension $plan.Config.installedVersion)
            Write-AllenJsonAtomic (Join-Path $plan.Helper 'installation.json') $plan.Config
            $hostManifest = [pscustomobject][ordered]@{
                name = $script:AllenNativeHostName; description = 'ALLEN Toolbox signed external updater'
                path = (Join-Path $plan.Helper 'ALLEN-Toolbox-NativeHost.exe'); type = 'stdio'
                allowed_origins = @('chrome-extension://' + $plan.Config.extensionId + '/')
            }
            Write-AllenJsonAtomic (Join-Path $plan.Helper 'host.json') $hostManifest
            $state = New-AllenState; $state.installedVersion = $plan.Config.installedVersion; $state.extensionId = $plan.Config.extensionId
            Write-AllenJsonAtomic (Join-Path $plan.Helper 'state.json') $state
            $registered = $true
            Register-AllenNativeHost $plan.Config
            $taskRegistered = $true
            Register-AllenTask $plan.Config
            return [pscustomobject]@{ cancelled = $false; installed = $true; uninstalled = $false; extensionDirectory = $plan.Extension; extensionId = $plan.Config.extensionId; helperDirectory = $plan.Helper; taskName = $plan.Config.taskName }
        } catch {
            if ($taskRegistered) { try { Unregister-AllenTask $plan.Config } catch { } }
            if ($registered) { try { Unregister-AllenNativeHost $plan.Config } catch { } }
            if ($extensionCreated) { try { Remove-AllenStage $plan.Extension } catch { } }
            if ($helperCreated) { try { Remove-AllenOwnedHelper $plan.Config } catch { } }
            throw
        }
    } finally { if ($held) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
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
