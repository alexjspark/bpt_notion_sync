import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, '.runtime', 'local-input');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const urlPattern = /^Connection key input \(localhost only\): (http:\/\/127\.0\.0\.1:4311\/connect\/[a-f0-9]{48})$/m;
const marker = (text, value) => text.split(/\r?\n/).includes(value);
const lines = {
  saved: 'PRIVATE_CONNECTION_FILES_SAVED; external writes remain disabled.',
  uncertain: 'CONNECTION_STORAGE_RESULT_REQUIRES_INSPECTION; do not repeat setup.',
  expired: 'INPUT_WINDOW_EXPIRED; no automatic restart.',
};
async function text(path) { try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; } }
async function powershell(command, env = {}) {
  return execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, ...env }, windowsHide: true, timeout: 20000, maxBuffer: 16384,
  });
}
async function latestReceipt() {
  let names;
  try { names = await readdir(runtime); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const receipts = [];
  for (const name of names.filter(name => name.endsWith('.json') && uuid.test(name.slice(0, -5)))) {
    const item = JSON.parse(await text(join(runtime, name)));
    if (Object.keys(item).sort().join(',') !== 'instanceId,pid,startedAt' || item.instanceId !== name.slice(0, -5)
      || !Number.isSafeInteger(item.pid) || item.pid <= 0 || !Number.isFinite(Date.parse(item.startedAt))) throw new Error('INVALID_RECEIPT');
    receipts.push(item);
  }
  return receipts.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0] ?? null;
}
async function status(receipt) {
  if (!receipt) return 'unknown';
  const out = await text(join(runtime, `${receipt.instanceId}.stdout.log`));
  const err = await text(join(runtime, `${receipt.instanceId}.stderr.log`));
  if (marker(out, lines.saved) || marker(out, 'PRIVATE_CONNECTION_FILES_SAVED; input server stopped; external writes remain disabled.')) return 'saved';
  if (marker(err, lines.uncertain)) return 'uncertain';
  if (marker(out, lines.expired)) return 'expired';
  if (!urlPattern.test(out) || Date.now() - Date.parse(receipt.startedAt) >= 30 * 60 * 1000) return 'unknown';
  // Read only this launch's process/listener metadata; never inspect secret files.
  const { stdout } = await powershell(`$ErrorActionPreference='Stop'
$p=Get-Process -Id ([int]$env:TRAINER_INPUT_PID) -ErrorAction SilentlyContinue
$owned=$null -ne $p -and $p.StartTime.ToUniversalTime().ToString('o') -eq $env:TRAINER_INPUT_STARTED
if($owned){$owned=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq 4311 -and $_.OwningProcess -eq $p.Id }).Count -gt 0}
if($owned){[Console]::Out.Write('listening')}else{[Console]::Out.Write('unknown')}`, {
    TRAINER_INPUT_PID: String(receipt.pid), TRAINER_INPUT_STARTED: receipt.startedAt,
  });
  return stdout === 'listening' ? 'listening' : 'unknown';
}
async function start() {
  const instanceId = randomUUID();
  await mkdir(runtime, { recursive: true });
  const input = join(runtime, `${instanceId}.stdin`);
  await writeFile(input, '', { flag: 'wx' });
  const { stdout } = await powershell(`$ErrorActionPreference='Stop'
if(@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq 4311 }).Count -gt 0){[Console]::Out.Write('PORT_IN_USE');exit}
$p=Start-Process -FilePath $env:TRAINER_INPUT_NODE -ArgumentList ('"'+$env:TRAINER_INPUT_HELPER+'"') -WorkingDirectory $env:TRAINER_INPUT_ROOT -WindowStyle Hidden -RedirectStandardInput $env:TRAINER_INPUT_STDIN -RedirectStandardOutput $env:TRAINER_INPUT_STDOUT -RedirectStandardError $env:TRAINER_INPUT_STDERR -PassThru
@{pid=$p.Id;startedAt=$p.StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress`, {
    TRAINER_INPUT_NODE: process.execPath, TRAINER_INPUT_HELPER: join(root, 'scripts', 'connect-local.mjs'), TRAINER_INPUT_ROOT: root,
    TRAINER_INPUT_STDIN: input, TRAINER_INPUT_STDOUT: join(runtime, `${instanceId}.stdout.log`), TRAINER_INPUT_STDERR: join(runtime, `${instanceId}.stderr.log`),
  });
  if (stdout.trim() === 'PORT_IN_USE') throw new Error('PORT_IN_USE');
  const launched = JSON.parse(stdout);
  if (!Number.isSafeInteger(launched.pid) || launched.pid <= 0 || !Number.isFinite(Date.parse(launched.startedAt))) throw new Error('START_UNCERTAIN');
  const receipt = { instanceId, pid: launched.pid, startedAt: launched.startedAt };
  await writeFile(join(runtime, `${instanceId}.json`), JSON.stringify(receipt), { flag: 'wx' });
  for (let attempt = 0; attempt < 100; attempt++) {
    const out = await text(join(runtime, `${instanceId}.stdout.log`));
    const err = await text(join(runtime, `${instanceId}.stderr.log`));
    const match = out.match(urlPattern);
    if (match) {
      if (await status(receipt) !== 'listening') throw new Error('START_UNCERTAIN');
      process.stdout.write(`${match[1]}\n`); return;
    }
    if (marker(out, lines.saved) || marker(err, lines.uncertain) || /(?:^|\n)CONNECTION_SETUP_STOPPED: /.test(err)) throw new Error('START_STOPPED');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('START_UNCERTAIN');
}
try {
  if (process.platform !== 'win32' || process.argv.length !== 3 || !['start', 'status'].includes(process.argv[2])) throw new Error('INVALID_LAUNCH_REQUEST');
  if (process.argv[2] === 'status') process.stdout.write(`${await status(await latestReceipt())}\n`);
  else await start();
} catch (error) {
  if (process.argv[2] === 'status') process.stdout.write('unknown\n');
  else process.stderr.write(`LOCAL_INPUT_STOPPED: ${['PORT_IN_USE', 'INVALID_LAUNCH_REQUEST', 'START_UNCERTAIN', 'START_STOPPED'].includes(error?.message) ? error.message : 'LAUNCH_FAILED'}\n`);
  process.exitCode = 1;
}
