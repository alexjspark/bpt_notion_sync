import test from'node:test';import assert from'node:assert/strict';import{mkdtempSync,writeFileSync,mkdirSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join,resolve,sep}from'node:path';import{spawnSync}from'node:child_process';import{inspectStagedChanges}from'../scripts/check-commit-safety.mjs';
test('staged safety reads index, rejects private paths and encoded identifiers without printing values',()=>{
 const dir=mkdtempSync(join(tmpdir(),'trainer-git-safety-'));
 try{
  const git=(args:string[])=>{const r=spawnSync('git',args,{cwd:dir,encoding:'utf8'});assert.equal(r.status,0,'synthetic git command failed');};
  git(['init','-q']);mkdirSync(join(dir,'src'));writeFileSync(join(dir,'src','safe.ts'),'export const synthetic=true;\n');git(['add','--','src/safe.ts']);assert.equal(inspectStagedChanges({cwd:dir}).passed,true);
  mkdirSync(join(dir,'local-config'));writeFileSync(join(dir,'local-config','test.json'),'{}');git(['add','--','local-config/test.json']);assert.equal(inspectStagedChanges({cwd:dir}).passed,false);
  const marker='SYNTHETIC_PRIVATE_IDENTIFIER',escaped=[...marker].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('');
  writeFileSync(join(dir,'src','safe.ts'),escaped);git(['add','--','src/safe.ts']);
  const report=inspectStagedChanges({cwd:dir,forbiddenValues:[marker]});assert.ok(report.problems.some(p=>p.reason==='KNOWN_PRIVATE_BINDING'));assert.equal(JSON.stringify(report).includes(marker),false);
 }finally{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));assert.ok(dir.includes('trainer-git-safety-'));rmSync(dir,{recursive:true,force:true});}
});
