[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows') {
    throw 'Protection preparation is allowed only on an ephemeral GitHub-hosted Windows runner.'
}

# Hosted images disable Defender and exclude entire drives. Restore protection on
# the disposable runner; this script never weakens a user's antivirus settings.
$passive = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows Advanced Threat Protection'
if (Test-Path -LiteralPath $passive) {
    Set-ItemProperty -LiteralPath $passive -Name ForceDefenderPassiveMode -Value 0 -Type DWord
}
$service = Get-Service -Name WinDefend
if ($service.Status -ne 'Running') {
    if ($service.StartType -eq 'Disabled') { Set-Service -Name WinDefend -StartupType Automatic }
    Start-Service -Name WinDefend
    $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30))
}
Set-MpPreference -DisableRealtimeMonitoring $false -DisableArchiveScanning $false -DisableBehaviorMonitoring $false -DisableIOAVProtection $false -DisableScriptScanning $false -DisableBlockAtFirstSeen $false
$preferences = Get-MpPreference
if ($preferences.ExclusionPath) { Remove-MpPreference -ExclusionPath @($preferences.ExclusionPath) }
if ($preferences.ExclusionProcess) { Remove-MpPreference -ExclusionProcess @($preferences.ExclusionProcess) }
if ($preferences.ExclusionExtension) { Remove-MpPreference -ExclusionExtension @($preferences.ExclusionExtension) }
Update-MpSignature

$status = Get-MpComputerStatus
$preferences = Get-MpPreference
if (-not $status.AntivirusEnabled -or -not $status.RealTimeProtectionEnabled -or $preferences.DisableArchiveScanning -ne $false -or
    $preferences.ExclusionPath -or $preferences.ExclusionProcess -or $preferences.ExclusionExtension) {
    throw 'Hosted runner protection could not be enabled fully; publication is blocked.'
}
Write-Host 'Defender enabled, archive scanning enabled, hosted-runner exclusions removed, signatures updated.'
