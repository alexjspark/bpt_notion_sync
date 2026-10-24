# Scoped, user-approved in-place Docker Desktop update. Never uninstall/reset or accept new terms.
$ErrorActionPreference = 'Stop'
$installerPath = 'C:\Users\truep\AppData\Local\Temp\trainer-sync-docker-update-20261022T123824Z-8ff09298\Docker Desktop Installer.exe'
$backupDirectory = 'C:\Users\truep\AppData\Local\Docker-update-backups\20261022T123711Z-2f39afe9'
$manifestPath = Join-Path $backupDirectory 'manifest.json'
$resultPath = Join-Path (Split-Path -Parent $installerPath) 'install-result.json'
if (Test-Path -LiteralPath $resultPath) { throw 'An installation result already exists. Inspect the prior outcome; do not repeat.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if (-not $manifest.Complete -or $manifest.Files.Count -ne 2 -or @($manifest.Files | Where-Object { -not $_.Verified }).Count -ne 0) { throw 'Verified offline backup is not complete; installation is blocked.' }
foreach ($disk in $manifest.Files) {
    $sourceInfo = Get-Item -LiteralPath $disk.Source -Force
    $backupInfo = Get-Item -LiteralPath $disk.Backup -Force
    $recordedLastWrite = if ($disk.SourceLastWriteUtc -is [DateTime]) { $disk.SourceLastWriteUtc.ToUniversalTime() } else { [DateTime]::Parse([string]$disk.SourceLastWriteUtc,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime() }
    if ($sourceInfo.Length -ne $disk.Bytes -or $backupInfo.Length -ne $disk.Bytes -or $sourceInfo.LastWriteTimeUtc -ne $recordedLastWrite) { throw 'Source or backup metadata changed after verification; installation is blocked.' }
}
$running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(Docker Desktop|com\.docker\.backend|com\.docker\.proxy|docker-desktop|docker|dockerd|vmmemWSL|docker-ai)$' })
if ($running.Count -ne 0) { throw 'Docker/WSL processes are active; do not install or terminate them automatically.' }
$features = @(Get-CimInstance Win32_OptionalFeature -Filter "Name='VirtualMachinePlatform' OR Name='Microsoft-Windows-Subsystem-Linux'")
if ($features.Count -ne 2 -or @($features | Where-Object { $_.InstallState -ne 1 }).Count -ne 0) { throw 'Existing Windows features are not enabled; no feature change is authorized.' }
$expectedHash = 'ceb589a9871b52971b24aa65915192854e5391a43d3df1b551db89aac50f24fa'
if ((Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'Official installer checksum mismatch; do not run.' }
$signature = Get-AuthenticodeSignature -LiteralPath $installerPath
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?i)(?:^|,\s*)(CN|O)=Docker Inc(?:\.|,|$)') { throw 'Installer does not have a valid Docker Inc signature; do not run.' }
if ((Get-Item -LiteralPath $installerPath).VersionInfo.ProductVersion -ne '4.96.2.244353') { throw 'Unexpected installer version; do not run.' }
$record = [ordered]@{StartedUtc=[DateTime]::UtcNow.ToString('o');Version='4.96.2.244353';Installer=$installerPath;BackupManifest=$manifestPath;Mode='all-users in-place EXE';Args=@('install','--quiet','--installation-dir=C:\Program Files\Docker\Docker','--backend=wsl-2');LicenseAutoAccepted=$false;Outcome='launch-pending'}
try {
    # Preserve uncertainty if elevation or the caller is interrupted before a PID is returned.
    $record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $resultPath -Encoding utf8
    # RunAs invokes the normal Windows UAC approval path; never automate/bypass that dialog.
    # No --accept-license, --always-run-service, data-root relocation or undocumented flags.
    $installerProcess = Start-Process -FilePath $installerPath -ArgumentList @('install','--quiet','--installation-dir="C:\Program Files\Docker\Docker"','--backend=wsl-2') -Verb RunAs -WindowStyle Hidden -PassThru
    $record.ProcessId = $installerProcess.Id
    $record.Outcome = 'installer-running'
    $record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $resultPath -Encoding utf8
    [PSCustomObject]@{Stage='installer-started';ProcessId=$installerProcess.Id;NewTermsAutoAccepted=$false} | ConvertTo-Json -Compress
    $installerProcess.WaitForExit()
    $installerProcess.Refresh()
    $record.ExitCode = $installerProcess.ExitCode
    $record.FinishedUtc = [DateTime]::UtcNow.ToString('o')
    $record.Outcome = if ($installerProcess.ExitCode -eq 0) { 'installer-exited-success-check-version-and-engine' } else { 'installer-exited-nonzero-do-not-retry' }
    $record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $resultPath -Encoding utf8
    $record | ConvertTo-Json -Depth 4 -Compress
    if ($installerProcess.ExitCode -ne 0) { exit $installerProcess.ExitCode }
} catch {
    $record.Outcome = 'launch-or-install-failed-do-not-retry'
    $record.Error = $_.Exception.Message
    $record.FinishedUtc = [DateTime]::UtcNow.ToString('o')
    $record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $resultPath -Encoding utf8
    throw
}
