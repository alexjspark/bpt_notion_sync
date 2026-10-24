import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function shutdownProcess(code: number) {
  const moduleUrl = new URL('../scripts/company-browser-shutdown.mjs', import.meta.url).href;
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createBrowserShutdown } from ${JSON.stringify(moduleUrl)};
    const shutdown = createBrowserShutdown({ closeServer() {}, sockets: new Set(), children: [], graceMs: 30_000 });
    shutdown.stop(${code});
    // No referenced handles remain, reproducing the early natural exit.
  `], { encoding: 'utf8', timeout: 5000 });
}

test('failed browser startup exits nonzero even before an unreferenced grace timer', () => {
  const result = shutdownProcess(1);
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('normal browser shutdown exits zero without waiting for the grace timer', () => {
  const result = shutdownProcess(0);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
});

function orderedShutdown(hung:boolean){const url=new URL('../scripts/company-browser-shutdown.mjs',import.meta.url).href;return spawnSync(process.execPath,['--input-type=module','-e',`
 import{EventEmitter}from'node:events';import{createBrowserShutdown}from ${JSON.stringify(url)};
 const order=[],browser=new EventEmitter();browser.exitCode=null;browser.signalCode=null;browser.kill=s=>{order.push('browser:'+s);if(!${hung})setTimeout(()=>{order.push('browser:exit');browser.exitCode=0;browser.emit('exit');},10);return true;};
 const child=name=>({kill:s=>{order.push(name+':'+s);return true;}});
 const shutdown=createBrowserShutdown({closeServer(){order.push('server:close')},sockets:new Set(),children:[child('display'),child('vnc'),browser],getBrowser:()=>browser,browserGraceMs:${hung?15:200},graceMs:1000,onDiagnostic:code=>order.push(code)});
 shutdown.stop(0);shutdown.stop(1);setTimeout(()=>console.log(JSON.stringify(order)),60);
 `],{encoding:'utf8',timeout:5000});}
test('Chromium exits before display teardown and repeated stop keeps first result',()=>{const r=orderedShutdown(false);assert.equal(r.status,0);assert.deepEqual(JSON.parse(r.stdout),['server:close','browser:SIGTERM','browser:exit','vnc:SIGTERM','display:SIGTERM']);});
test('hung Chromium shutdown is bounded and emits only a fixed diagnostic',()=>{const r=orderedShutdown(true);assert.equal(r.status,0);assert.deepEqual(JSON.parse(r.stdout),['server:close','browser:SIGTERM','BROWSER_SHUTDOWN_FORCED','browser:SIGKILL','vnc:SIGTERM','display:SIGTERM']);});
