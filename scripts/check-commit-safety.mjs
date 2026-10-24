import{spawnSync}from'node:child_process';import{readFileSync}from'node:fs';import{resolve,relative}from'node:path';import{fileURLToPath}from'node:url';
const DOCS=new Set(['docs/MILESTONE-1.md','docs/COLLEAGUE-TENANT-PLAN.md','docs/PORTABLE-CONFIG.md','docs/LOCAL-COMMIT-PREPARATION.md','docs/PHASE2-IMPLEMENTATION.md']);
export function inspectStagedChanges({cwd=process.cwd(),forbiddenValues=[]}={}){
 const git=args=>{const r=spawnSync('git',args,{cwd,encoding:'utf8',maxBuffer:12*1024*1024});if(r.status!==0)throw Error('GIT_INDEX_READ_FAILED');return r.stdout;};
 const paths=git(['diff','--cached','--name-only','--diff-filter=ACMR','-z']).split('\0').filter(Boolean),problems=[];
 const privatePath=/(^|\/)(local-config|private|secrets|backups|test-results|playwright-report|\.runtime|node_modules|\.next|profiles?|browser-profile)(\/|$)/i;
 for(const path of paths){
  const mode=git(['ls-files','--stage','--',path]).split(' ')[0],text=git(['show',':'+path]);
  if(mode==='120000'||mode==='160000')problems.push({path,reason:'LINK_OR_EMBEDDED_REPOSITORY'});
  if(privatePath.test(path)||path.startsWith('docs/')&&!DOCS.has(path)||/(^|\/)\.env(?:\.|$)/.test(path)&&path!=='.env.example'||/\.(png|jpe?g|gif|webp|pdf|dump|sqlite|log|zip|pfx|pem|key|tsbuildinfo)$/i.test(path))problems.push({path,reason:'PRIVATE_OR_GENERATED_PATH'});
  if(text.includes('\0')||Buffer.byteLength(text)>1500000)problems.push({path,reason:'BINARY_OR_OVERSIZED'});
  const decoded=text.replace(/\\u([0-9a-f]{4})/gi,(_,n)=>String.fromCharCode(parseInt(n,16)));
  const compact=decoded.replaceAll('-','').toLowerCase();
  if(forbiddenValues.some(v=>typeof v==='string'&&v.length>=5&&(decoded.includes(v)||/^[a-f0-9-]{32,36}$/i.test(v)&&compact.includes(v.replaceAll('-','').toLowerCase()))))problems.push({path,reason:'KNOWN_PRIVATE_BINDING'});
  if(/(?:ntn_|secret_)[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{25,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text))problems.push({path,reason:'CREDENTIAL_PATTERN'});
 }
 return{passed:problems.length===0,stagedFiles:paths.length,problems};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 let forbiddenValues=[];
 if(process.argv[2]){
  const p=resolve(process.argv[2]),rel=relative(resolve('local-config'),p);
  if(rel.startsWith('..')||rel.includes(':')||!p.endsWith('portable-binding-migration-20261024.json'))throw Error('PRIVATE_BINDING_MANIFEST_PATH_REJECTED');
  const v=JSON.parse(readFileSync(p,'utf8'));
  forbiddenValues=[v.databaseId,v.dataSourceId,...v.contactSaveApproval.targets.flatMap(t=>[t.uid,t.pageId,t.name]),v.isolatedTestFixture.pageId,v.isolatedTestFixture.testId];
 }
 const result=inspectStagedChanges({forbiddenValues});console.log(JSON.stringify(result));process.exitCode=result.passed?0:1;
}
