import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, '.runtime', 'local-input-probe');
const responseText = 'TRAINER_SYNC_SYNTHETIC_LIFETIME_PROBE';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const childSource = `import { createServer } from 'node:http';
const server=createServer((request,response)=>{
  const address=server.address();
  if(request.method!=='GET'||request.url!=='/'||request.headers.host!=='127.0.0.1:'+address.port){response.writeHead(404);response.end('NOT_FOUND');return;}
  response.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Connection':'close'});
  response.end('${responseText}');
});
server.on('error',()=>{process.stderr.write('PROBE_SERVER_ERROR\\n');process.exitCode=1;});
server.listen(0,'127.0.0.1',()=>process.stdout.write(JSON.stringify({port:server.address().port})+'\\n'));
setTimeout(()=>{server.closeAllConnections();server.close();},45000);
`;
async function powershell(command, env = {}) {
  return execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, ...env }, windowsHide: true, timeout: 15000, maxBuffer: 8192,
  });
}
function validReceipt(item) {
  return item && Object.keys(item).sort().join(',') === 'pid,port,startedAt'
    && Number.isSafeInteger(item.pid) && item.pid > 0 && Number.isSafeInteger(item.port) && item.port > 0 && item.port <= 65535
    && typeof item.startedAt === 'string' && Number.isFinite(Date.parse(item.startedAt));
}
async function start() {
  await mkdir(runtime, { recursive: true });
  const id = randomUUID();
  const child = join(runtime, `${id}.mjs`), input = join(runtime, `${id}.stdin`), output = join(runtime, `${id}.stdout.log`);
  await writeFile(child, childSource, { flag: 'wx' });
  await writeFile(input, '', { flag: 'wx' });
  const { stdout } = await powershell(`$ErrorActionPreference='Stop'
$p=Start-Process -FilePath $env:TRAINER_PROBE_NODE -ArgumentList ('"'+$env:TRAINER_PROBE_CHILD+'"') -WorkingDirectory $env:TRAINER_PROBE_ROOT -WindowStyle Hidden -RedirectStandardInput $env:TRAINER_PROBE_STDIN -RedirectStandardOutput $env:TRAINER_PROBE_STDOUT -RedirectStandardError $env:TRAINER_PROBE_STDERR -PassThru
@{pid=$p.Id;startedAt=$p.StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress`, {
    TRAINER_PROBE_NODE: process.execPath, TRAINER_PROBE_CHILD: child, TRAINER_PROBE_ROOT: root, TRAINER_PROBE_STDIN: input,
    TRAINER_PROBE_STDOUT: output, TRAINER_PROBE_STDERR: join(runtime, `${id}.stderr.log`),
  });
  const launched = JSON.parse(stdout);
  for (let attempt = 0; attempt < 50; attempt++) {
    let port;
    try { port = JSON.parse((await readFile(output, 'utf8')).trim()).port; } catch { /* Read only this synthetic launch log. */ }
    const receipt = { pid: launched.pid, port, startedAt: launched.startedAt };
    if (validReceipt(receipt)) {
      await writeFile(join(runtime, `${id}.json`), JSON.stringify(receipt), { flag: 'wx' });
      process.stdout.write('PROBE_STARTED\n'); return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('PROBE_START_UNCERTAIN');
}
async function check() {
  const receipts = [];
  for (const name of await readdir(runtime)) {
    if (!name.endsWith('.json') || !uuid.test(name.slice(0, -5))) continue;
    const receipt = JSON.parse(await readFile(join(runtime, name), 'utf8'));
    if (!validReceipt(receipt)) throw new Error('PROBE_RECEIPT_INVALID');
    receipts.push(receipt);
  }
  const receipt = receipts.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
  if (!receipt || Date.now() - Date.parse(receipt.startedAt) >= 45000) throw new Error('PROBE_EXPIRED_OR_MISSING');
  const { stdout } = await powershell(`$ErrorActionPreference='Stop'
$p=Get-Process -Id ([int]$env:TRAINER_PROBE_PID) -ErrorAction SilentlyContinue
$owned=$null -ne $p -and $p.StartTime.ToUniversalTime().ToString('o') -eq $env:TRAINER_PROBE_STARTED
if($owned){$owned=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $_.LocalPort -eq [int]$env:TRAINER_PROBE_PORT -and $_.OwningProcess -eq $p.Id }).Count -gt 0}
if($owned){[Console]::Out.Write('owned')}`, {
    TRAINER_PROBE_PID: String(receipt.pid), TRAINER_PROBE_PORT: String(receipt.port), TRAINER_PROBE_STARTED: receipt.startedAt,
  });
  if (stdout !== 'owned') throw new Error('PROBE_NOT_LISTENING');
  const response = await fetch(`http://127.0.0.1:${receipt.port}/`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
  if (response.status !== 200 || await response.text() !== responseText) throw new Error('PROBE_RESPONSE_INVALID');
  process.stdout.write('PROBE_SURVIVED_SYNTHETIC_GET_OK\n');
}
try {
  if (process.platform !== 'win32' || process.argv.length !== 3 || !['start', 'check'].includes(process.argv[2])) throw new Error('PROBE_INVALID_REQUEST');
  if (process.argv[2] === 'start') await start(); else await check();
} catch (error) {
  const codes = new Set(['PROBE_START_UNCERTAIN', 'PROBE_RECEIPT_INVALID', 'PROBE_EXPIRED_OR_MISSING', 'PROBE_NOT_LISTENING', 'PROBE_RESPONSE_INVALID', 'PROBE_INVALID_REQUEST']);
  process.stderr.write(`${codes.has(error?.message) ? error.message : 'PROBE_FAILED'}\n`); process.exitCode = 1;
}
