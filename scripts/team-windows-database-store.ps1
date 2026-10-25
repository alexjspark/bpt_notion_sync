param([switch]$OperatorApproved,[switch]$GenerateRandom)
$ErrorActionPreference='Stop'
if(-not $OperatorApproved -or $env:OS -ne 'Windows_NT'){throw 'PILOT_DATABASE_STORE_NOT_APPROVED'}
Add-Type -AssemblyName System.Security

# Returns bytes only to the internal caller. Never format or print the result.
function New-PilotDatabasePasswordBytes {
 $raw=New-Object byte[] 32
 $ascii=New-Object byte[] 64
 $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
 try {
  $rng.GetBytes($raw)
  $alphabet='0123456789abcdef'
  for($i=0;$i -lt $raw.Length;$i++){
   $ascii[$i*2]=[byte][char]$alphabet[($raw[$i] -shr 4)]
   $ascii[$i*2+1]=[byte][char]$alphabet[($raw[$i] -band 15)]
  }
  return ,$ascii
 } catch {
  [Array]::Clear($ascii,0,$ascii.Length)
  throw 'PILOT_DATABASE_RANDOM_FAILED'
 } finally {
  [Array]::Clear($raw,0,$raw.Length)
  $rng.Dispose()
 }
}

function Protect-PilotDatabasePasswordBytes {
 param([Parameter(Mandatory=$true)][byte[]]$Bytes)
 if($Bytes.Length -lt 16 -or $Bytes.Length -gt 128){throw 'PILOT_DATABASE_PASSWORD_INVALID'}
 return ,([Security.Cryptography.ProtectedData]::Protect($Bytes,[Text.Encoding]::UTF8.GetBytes('TrainerSync-team-pilot-database-v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser))
}

$parent=Join-Path $env:LOCALAPPDATA 'TrainerSync\team-pilot'
$target=Join-Path $parent 'database-password.dpapi'
if(Test-Path -LiteralPath $target){throw 'PILOT_DATABASE_STORE_ALREADY_EXISTS'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent();$sid=$identity.User
if(Test-Path -LiteralPath $parent){$dir=Get-Item -LiteralPath $parent;$acl=Get-Acl -LiteralPath $parent;if(($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -ne $sid.Value}).Count){throw 'PILOT_DIRECTORY_REVIEW_REQUIRED'}}else{
 [IO.Directory]::CreateDirectory($parent)|Out-Null;$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')));Set-Acl -LiteralPath $parent -AclObject $acl
}
$secure=$null
$ptr=[IntPtr]::Zero
$text=$null
$bytes=$null
try {
 if($GenerateRandom){
  $bytes=New-PilotDatabasePasswordBytes
 } else {
  $secure=Read-Host 'Choose the separate pilot database password (16-128 characters)' -AsSecureString
  $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $text=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  if($text.Length -lt 16 -or $text.Length -gt 128 -or $text -match '[\r\n\x00]'){throw 'PILOT_DATABASE_PASSWORD_INVALID'}
  $bytes=[Text.Encoding]::UTF8.GetBytes($text)
 }
 $sealed=Protect-PilotDatabasePasswordBytes -Bytes $bytes
 $stream=[IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$stream.Write($sealed,0,$sealed.Length)}finally{$stream.Dispose()}
} finally {
 if($null -ne $bytes){[Array]::Clear($bytes,0,$bytes.Length)}
 $text=$null
 if($ptr -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
 if($null -ne $secure){$secure.Dispose()}
}
$fileAcl=Get-Acl -LiteralPath $target;$fileAcl.SetOwner($sid);Set-Acl -LiteralPath $target -AclObject $fileAcl
if((Get-Acl -LiteralPath $target).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'PILOT_STORE_OWNER_UNVERIFIED'}
Write-Output 'PILOT_DATABASE_PASSWORD_PROTECTED'
