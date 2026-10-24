import{mkdir,readFile,writeFile,rename,realpath,lstat}from'node:fs/promises';import{resolve,sep}from'node:path';
import{requireUuid}from'../../packages/engine/src/team-errors.ts';import{newJournal,type PhysicalJournal}from'./registry.ts';
export interface JournalStore{load():Promise<PhysicalJournal>;save(journal:PhysicalJournal):Promise<void>}
export function physicalJournalStore(workspace:string,runId:string):JournalStore{
 runId=requireUuid(runId);const root=resolve(workspace,'.runtime','team-physical-test'),path=resolve(root,runId+'.json');
 async function checkRoot(create:boolean){
  const base=await realpath(workspace);if(create)await mkdir(root,{recursive:true});
  const actual=await realpath(root);if(actual!==resolve(base,'.runtime','team-physical-test')||!path.startsWith(actual+sep))throw Error('PHYSICAL_JOURNAL_PATH_INVALID');
  try{if((await lstat(path)).isSymbolicLink())throw Error('PHYSICAL_JOURNAL_LINK_REJECTED');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 }
 return{
  async load(){try{await checkRoot(false);const j=JSON.parse(await readFile(path,'utf8'));if(j.version!==1||j.runId!==runId||!Array.isArray(j.resources))throw Error('PHYSICAL_JOURNAL_INVALID');return j;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return newJournal(runId);throw e;}},
  async save(j){if(j.version!==1||j.runId!==runId)throw Error('PHYSICAL_JOURNAL_INVALID');await checkRoot(true);await writeFile(path+'.tmp',JSON.stringify(j,null,2),{mode:0o600,flag:'wx'});await rename(path+'.tmp',path);}
 };
}
