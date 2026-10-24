import { spawnSync } from 'node:child_process';
function run(args) { const r=spawnSync('docker', ['compose',...args], {stdio:'inherit'}); if(r.status !== 0) throw new Error(`Docker compose command failed (exit ${r.status ?? 'unknown'}).`); }
let connectedPreviewStarted=false;
try {
  run(['up','-d','--build','--wait','web','worker']);
  run(['--profile','test','build','tester']);
  run(['--profile','test','up','-d','--wait','test-postgres']);
  run(['--profile','test','run','--rm','--no-deps','tester','npm','run','check']);
  run(['--profile','test','run','--rm','--no-deps','tester','npm','run','test:e2e']);
  run(['-f','compose.yaml','-f','compose.preview-test.yaml','--profile','test','up','-d','--no-build','--wait','preview-test-web']);
  connectedPreviewStarted=true;
  run(['-f','compose.yaml','-f','compose.preview-test.yaml','--profile','test','run','--rm','--no-deps','-e','BASE_URL=http://preview-test-web:3000','tester','npm','run','test:e2e:connected']);
} catch(error) {
  console.error(error instanceof Error ? error.message : 'Verification failed.');
  process.exitCode=1;
} finally {
  if(connectedPreviewStarted)spawnSync('docker',['compose','-f','compose.yaml','-f','compose.preview-test.yaml','--profile','test','stop','preview-test-web'],{stdio:'inherit'});
  spawnSync('docker',['compose','--profile','test','stop','test-postgres'], {stdio:'inherit'});
}
