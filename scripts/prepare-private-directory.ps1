$ErrorActionPreference = 'Stop'
$privateParent = Join-Path $env:LOCALAPPDATA 'TrainerSync'
$privateTarget = Join-Path $privateParent 'private'
$expectedTarget = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'TrainerSync\private'))
if ([IO.Path]::GetFullPath($privateTarget) -ne $expectedTarget) { throw 'PRIVATE_TARGET_MISMATCH' }

foreach ($pathPart in @($env:LOCALAPPDATA, $privateParent, $privateTarget)) {
  if (Test-Path -LiteralPath $pathPart) {
    $metadata = Get-Item -LiteralPath $pathPart -Force
    if (-not $metadata.PSIsContainer -or ($metadata.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'LINKED_PRIVATE_PATH_DENIED' }
  }
}
if (Test-Path -LiteralPath $privateTarget) { throw 'EXISTING_PRIVATE_DIRECTORY_PRESERVED' }
if (-not (Test-Path -LiteralPath $privateParent)) { New-Item -ItemType Directory -Path $privateParent | Out-Null }
New-Item -ItemType Directory -Path $privateTarget | Out-Null

$currentIdentitySid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$privateAcl = New-Object Security.AccessControl.DirectorySecurity
$privateAcl.SetOwner($currentIdentitySid)
$privateAcl.SetAccessRuleProtection($true, $false)
$inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$propagation = [Security.AccessControl.PropagationFlags]::None
foreach ($allowedSid in @($currentIdentitySid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
  $sid = New-Object Security.Principal.SecurityIdentifier($allowedSid)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inheritance, $propagation, 'Allow')
  $privateAcl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $privateTarget -AclObject $privateAcl

$verifiedAcl = Get-Acl -LiteralPath $privateTarget
$sidType = [Security.Principal.SecurityIdentifier]
$verifiedRules = @($verifiedAcl.GetAccessRules($true, $true, $sidType))
$allowedIdentities = @($currentIdentitySid.Value, 'S-1-5-18', 'S-1-5-32-544')
if (-not $verifiedAcl.AreAccessRulesProtected -or $verifiedRules.Count -ne 3 -or @($verifiedRules | Where-Object { $_.AccessControlType -ne 'Allow' -or $_.IdentityReference.Value -notin $allowedIdentities }).Count -gt 0) { throw 'PRIVATE_ACL_VERIFICATION_FAILED' }
[pscustomobject]@{ Path=$privateTarget; Protected=$verifiedAcl.AreAccessRulesProtected; AllowedRules=$verifiedRules.Count; CredentialFilesCreated=$false } | ConvertTo-Json -Compress
