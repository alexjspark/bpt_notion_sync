# PREPARATION ONLY. No invocation until operator approves generation/storage for this service identity.
param([ValidateSet('Create')][string]$Action,[Parameter(Mandatory=$true)][string]$Path,[switch]$OperatorApproved)
$ErrorActionPreference='Stop'
if(-not $OperatorApproved -or $env:OS -ne 'Windows_NT'){throw 'TEAM_KEY_STORE_NOT_APPROVED'}
$target=[IO.Path]::GetFullPath($Path)
$required=Join-Path $env:LOCALAPPDATA 'TrainerSync\team-pilot\operator-keys.dpapi'
if($target -ne $required -or (Test-Path -LiteralPath $target)){throw 'TEAM_KEY_TARGET_INVALID_OR_EXISTS'}
Add-Type -AssemblyName System.Security
$bytes=New-Object byte[] 64
$rng=[Security.Cryptography.RandomNumberGenerator]::Create()
try {
 $rng.GetBytes($bytes)
 $sealed=[Security.Cryptography.ProtectedData]::Protect($bytes,[Text.Encoding]::UTF8.GetBytes('TrainerSync-team-pilot-v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
 $parent=Split-Path -Parent $target
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
 if(Test-Path -LiteralPath $parent){$dir=Get-Item -LiteralPath $parent;$current=Get-Acl -LiteralPath $parent;if(($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $current.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or @($current.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -ne $sid.Value}).Count){throw 'TEAM_KEY_DIRECTORY_REVIEW_REQUIRED'}}else{
 [IO.Directory]::CreateDirectory($parent)|Out-Null
 # New directory ACL only. Existing service/private directories are not changed.
 $identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
 $acl=New-Object Security.AccessControl.DirectorySecurity
 $acl.SetOwner($sid)
 $acl.SetAccessRuleProtection($true,$false)
 $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
 Set-Acl -LiteralPath $parent -AclObject $acl
 }
 $stream=[IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$stream.Write($sealed,0,$sealed.Length)}finally{$stream.Dispose()}
 $fileAcl=Get-Acl -LiteralPath $target;$fileAcl.SetOwner($sid);Set-Acl -LiteralPath $target -AclObject $fileAcl
 if((Get-Acl -LiteralPath $target).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'PILOT_STORE_OWNER_UNVERIFIED'}
 Write-Output 'TEAM_KEYS_PROTECTED'
} finally { [Array]::Clear($bytes,0,$bytes.Length);$rng.Dispose() }
