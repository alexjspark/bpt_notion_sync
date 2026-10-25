import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const loaderUrl = new URL('../apps/team-runner/windows-secrets.ts', import.meta.url).href;

// The only protected data used here is a public, fixed test pattern in a new Temp directory.
// This test never opens the real LOCALAPPDATA pilot stores.
test('Windows DPAPI loader uses Windows PowerShell modules despite an inherited PowerShell 7 path', {
  skip: process.platform !== 'win32',
  timeout: 30_000,
}, () => {
  const tempParent = resolve(tmpdir());
  const fixtureRoot = mkdtempSync(join(tempParent, 'trainersync-public-dpapi-fixture-'));
  assert.equal(dirname(resolve(fixtureRoot)), tempParent);
  assert.ok(basename(fixtureRoot).startsWith('trainersync-public-dpapi-fixture-'));
  try {
    const fakeModules = join(fixtureRoot, 'inherited-ps7-modules');
    const fakeSecurity = join(fakeModules, 'Microsoft.PowerShell.Security');
    mkdirSync(fakeSecurity, { recursive: true });
    writeFileSync(join(fakeSecurity, 'Microsoft.PowerShell.Security.psd1'),
      "@{ RootModule='Microsoft.PowerShell.Security.psm1'; ModuleVersion='7.0.0'; FunctionsToExport=@('Get-Acl') }\n");
    writeFileSync(join(fakeSecurity, 'Microsoft.PowerShell.Security.psm1'),
      "function Get-Acl { throw 'PUBLIC_FIXTURE_MODULE_MUST_NOT_LOAD' }; Export-ModuleMember -Function Get-Acl\n");
    // Windows environment names are case-insensitive; discard aliases before overriding.
    const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !['localappdata', 'psmodulepath', 'team_secret_handoff_approved'].includes(name.toLowerCase())));
    const fixtureEnv = {
      ...inheritedEnv,
      LOCALAPPDATA: fixtureRoot,
      PSModulePath: fakeModules,
      TEAM_SECRET_HANDOFF_APPROVED: 'true',
    };
    const createFixture = String.raw`
$ErrorActionPreference='Stop'
$env:PSModulePath=Join-Path $PSHOME 'Modules'
Add-Type -AssemblyName System.Security
$parent=Join-Path $env:LOCALAPPDATA 'TrainerSync\team-pilot'
[IO.Directory]::CreateDirectory($parent)|Out-Null
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
Set-Acl -LiteralPath $parent -AclObject $acl
$publicFixture=New-Object byte[] 64
for($i=0;$i -lt $publicFixture.Length;$i++){$publicFixture[$i]=90}
try {
 foreach($kind in @('keys','database')){
  if($kind -eq 'keys'){$name='operator-keys.dpapi';$entropy='TrainerSync-team-pilot-v1'}else{$name='database-password.dpapi';$entropy='TrainerSync-team-pilot-database-v1'}
  $sealed=[Security.Cryptography.ProtectedData]::Protect($publicFixture,[Text.Encoding]::UTF8.GetBytes($entropy),[Security.Cryptography.DataProtectionScope]::CurrentUser)
  $target=Join-Path $parent $name
  $stream=[IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$stream.Write($sealed,0,$sealed.Length)}finally{$stream.Dispose()}
  $fileAcl=Get-Acl -LiteralPath $target
  $fileAcl.SetOwner($sid)
  Set-Acl -LiteralPath $target -AclObject $fileAcl
 }
}finally{[Array]::Clear($publicFixture,0,$publicFixture.Length)}
Write-Output 'PUBLIC_FIXTURE_CREATED'
`;
    const created = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', createFixture], {
      cwd: projectRoot, env: fixtureEnv, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    assert.equal(created.status, 0, 'public fixture setup must succeed');
    assert.equal(created.stdout.trim(), 'PUBLIC_FIXTURE_CREATED');
    assert.equal(created.stderr, '');

    // Demonstrate that the inherited module path breaks the exact Get-Acl dependency.
    const baseline = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop';try{Get-Acl -LiteralPath (Join-Path $env:LOCALAPPDATA 'TrainerSync\\team-pilot\\operator-keys.dpapi')|Out-Null;exit 0}catch{exit 19}"], {
      cwd: projectRoot, env: fixtureEnv, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    assert.equal(baseline.status, 19, 'the fixture must reproduce inherited module autoload failure');
    assert.equal(baseline.stdout, '');
    assert.equal(baseline.stderr, '');

    const childCode = `
import assert from 'node:assert/strict';
import { unsealPilotStore } from ${JSON.stringify(loaderUrl)};
assert.equal(process.env.LOCALAPPDATA, ${JSON.stringify(fixtureRoot)});
for (const kind of ['keys', 'database']) {
  const value = await unsealPilotStore(kind);
  try { assert.equal(value.length, 64); assert.ok(value.every(byte => byte === 90)); }
  finally { value.fill(0); }
}
process.env.TEAM_SECRET_HANDOFF_APPROVED = 'false';
await assert.rejects(unsealPilotStore('keys'), /PILOT_STORE_NOT_APPROVED/);
process.stdout.write('PUBLIC_FIXTURE_LOADER_OK');
`;
    const loaded = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childCode], {
      cwd: projectRoot, env: fixtureEnv, encoding: 'utf8', timeout: 15_000, windowsHide: true,
    });
    assert.equal(loaded.status, 0, 'the actual loader must handle both public fixtures');
    assert.equal(loaded.stdout, 'PUBLIC_FIXTURE_LOADER_OK');
    assert.equal(loaded.stderr, '');
  } finally {
    // Resolve and constrain the exact mkdtemp target before recursive removal.
    const cleanupTarget = resolve(fixtureRoot);
    assert.equal(dirname(cleanupTarget), tempParent);
    assert.ok(basename(cleanupTarget).startsWith('trainersync-public-dpapi-fixture-'));
    rmSync(cleanupTarget, { recursive: true, force: true });
  }
});
