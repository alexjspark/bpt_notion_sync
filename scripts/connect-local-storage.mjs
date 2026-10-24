import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, open, link, unlink } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve, parse } from 'node:path';
import { validNotionToken } from './connect-local-server.mjs';

const execFileAsync = promisify(execFile);
const SYSTEM_SID = 'S-1-5-18';
const ADMINISTRATORS_SID = 'S-1-5-32-544';

export function isPrivateAclReport(report) {
  if (!report || typeof report.currentSid !== 'string' || !/^S-1-5-21-\d+-\d+-\d+-\d+$/.test(report.currentSid) || report.reparsePoint !== false || !Array.isArray(report.rules)) return false;
  const allowed = new Set([report.currentSid, SYSTEM_SID, ADMINISTRATORS_SID]);
  if (!allowed.has(report.ownerSid)) return false;
  let currentAccess = false;
  for (const rule of report.rules) {
    if (rule.access !== 'Allow' && rule.access !== 'Deny') return false;
    if (rule.access === 'Allow') {
      if (!allowed.has(rule.sid)) return false;
      if (rule.sid === report.currentSid) currentAccess = true;
    }
  }
  return currentAccess;
}

/** Returns metadata only. It does not read the file, print its ACL, or alter permissions. */
export async function verifyWindowsPrivatePath(path) {
  if (process.platform !== 'win32') throw new Error('WINDOWS_ACL_CHECK_REQUIRED');
  const script = `$ErrorActionPreference = 'Stop'
# Node can inherit PowerShell 7's PSModulePath when launching Windows PowerShell.
# Select the installed host's own signed module instead of an incompatible autoload candidate.
Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$item = Get-Item -LiteralPath $env:TRAINER_SYNC_PRIVATE_PATH -Force
$acl = Get-Acl -LiteralPath $env:TRAINER_SYNC_PRIVATE_PATH
$sidType = [System.Security.Principal.SecurityIdentifier]
$rules = @($acl.GetAccessRules($true, $true, $sidType) | ForEach-Object { @{ sid = $_.IdentityReference.Value; access = $_.AccessControlType.ToString() } })
@{ currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; ownerSid = $acl.GetOwner($sidType).Value; reparsePoint = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint); rules = $rules } | ConvertTo-Json -Compress -Depth 4`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, TRAINER_SYNC_PRIVATE_PATH: path }, windowsHide: true, maxBuffer: 32_768, timeout: 15_000,
  });
  let report;
  try { report = JSON.parse(stdout.trim()); } catch { throw new Error('PRIVATE_PATH_CHECK_FAILED'); }
  if (!isPrivateAclReport(report)) throw new Error('PRIVATE_PATH_ACL_REQUIRED');
}

async function rejectLinkedComponents(path) {
  const target = resolve(path);
  const root = parse(target).root;
  const components = target.slice(root.length).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) throw new Error('LINKED_PRIVATE_PATH_DENIED');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
  }
}

async function assertAbsent(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('EXISTING_SECRET_PRESERVED');
}

async function writeNewFile(path, content, verifyPrivate) {
  await assertAbsent(path);
  const temporary = `${path}.setup-${randomUUID()}`;
  let handle;
  let created = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    created = true;
    await verifyPrivate(temporary);
    await handle.writeFile(content, { encoding: 'utf8' });
    await handle.sync();
    await handle.close(); handle = undefined;
    // link fails if the final name exists; no existing connection key is overwritten.
    await link(temporary, path);
    await unlink(temporary); created = false;
    await verifyPrivate(path);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new Error('PRIVATE_FILE_METADATA_INVALID');
  } finally {
    if (handle) await handle.close();
    if (created) await unlink(temporary).catch(() => {});
  }
}

export async function preparePrivateSecretWriter({ privateDirectory, verifyPrivate = verifyWindowsPrivatePath }) {
  const directory = resolve(privateDirectory);
  await rejectLinkedComponents(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await rejectLinkedComponents(directory);
  await verifyPrivate(directory);
  const notionTokenPath = join(directory, 'notion-token.txt');
  const previewHmacPath = join(directory, 'preview-hmac.txt');
  await assertAbsent(notionTokenPath);
  await assertAbsent(previewHmacPath);
  let attempted = false;
  return {
    notionTokenPath, previewHmacPath,
    async persist(token) {
      if (attempted) throw new Error('SETUP_ALREADY_ATTEMPTED');
      if (!validNotionToken(token)) throw new Error('INVALID_INPUT');
      attempted = true;
      await rejectLinkedComponents(directory);
      await verifyPrivate(directory);
      await assertAbsent(notionTokenPath);
      await assertAbsent(previewHmacPath);
      const hmac = randomBytes(32).toString('base64url');
      // The token is committed last. A failure is preserved for inspection; it is never retried silently.
      await writeNewFile(previewHmacPath, `${hmac}\n`, verifyPrivate);
      await writeNewFile(notionTokenPath, `${token}\n`, verifyPrivate);
    },
  };
}
