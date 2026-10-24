import type{DockerCommand}from'../../packages/engine/src/team-browser-driver.ts';
import type{JournalStore}from'./journal-file.ts';
import{reserveResource,recordResource,uncertainResource,markResourceAbsent,type ResourceKind,type ObservedResource}from'./registry.ts';
import{physicalLabels}from'./config.ts';
function creationFor(args:readonly string[]){
 if(args[0]==='create'){
  const name=args[args.indexOf('--name')+1],managed=args.find(x=>x.startsWith('trainer-sync.managed='))?.split('=')[1];
  return name&&managed?{kind:'container' as const,name,managed}:null;
 }
 if((args[0]==='network'||args[0]==='volume')&&args[1]==='create'){
  const managed=args.find(x=>x.startsWith('trainer-sync.managed='))?.split('=')[1];
  return managed?{kind:args[0] as 'network'|'volume',name:args.at(-1)!,managed}:null;
 }return null;
}
export function guardedPhysicalDocker(runId:string,store:JournalStore,execute:DockerCommand):DockerCommand{
 async function observe(kind:ResourceKind,name:string):Promise<ObservedResource>{
  const label=kind==='container'?'.Config.Labels':'.Labels',id=kind==='volume'?'.Name':'.Id';
  const format='{"id":{{json '+id+'}},"name":{{json .Name}},"run":{{json (index '+label+' "trainer-sync.test-run")}},"managed":{{json (index '+label+' "trainer-sync.managed")}},"purpose":{{json (index '+label+' "trainer-sync.test-purpose")}}}';
  const args=kind==='container'?['inspect','--type','container','--format',format,name]:[kind,'inspect','--format',format,name];
  const r=await execute(args);if(r.exitCode!==0)throw Error('PHYSICAL_RESOURCE_INSPECT_REQUIRED');
  let v;try{v=JSON.parse(r.stdout);}catch{throw Error('PHYSICAL_RESOURCE_INSPECT_REQUIRED');}
  return{kind,name:String(v.name).replace(/^\//,''),id:v.id,labels:{'trainer-sync.test-run':v.run,'trainer-sync.managed':v.managed,'trainer-sync.test-purpose':v.purpose}};
 }
 async function exists(kind:ResourceKind,name:string){
  const filter='name=^'+name+'$';
  const args=kind==='container'?['container','ls','-a','--filter',filter,'--format','{{.Names}}']:[kind,'ls','--filter',filter,'--format','{{.Name}}'];
  const r=await execute(args);if(r.exitCode!==0)throw Error('PHYSICAL_RESOURCE_INSPECT_REQUIRED');
  const found=r.stdout.trim();if(found&&found!==name)throw Error('PHYSICAL_RESOURCE_INSPECT_REQUIRED');return found===name;
 }
 async function owned(kind:ResourceKind,name:string){
  const j=await store.load();if(j.runId!==runId)throw Error('PHYSICAL_RUN_MISMATCH');
  const r=j.resources.find(v=>v.kind===kind&&(v.name===name||v.id===name));if(!r)throw Error('PHYSICAL_RESOURCE_NOT_RESERVED');
  recordResource(j,await observe(kind,r.name));await store.save(j);
 }
 return async input=>{
  if(input.some(v=>['--force','-f','-v'].includes(v)||/prune/.test(v))||['run','pull','build'].includes(input[0]??''))throw Error('PHYSICAL_COMMAND_REJECTED');
  const creation=creationFor(input);let args=[...input];
  if(creation){
   const j=await store.load();if(j.runId!==runId)throw Error('PHYSICAL_RUN_MISMATCH');
   reserveResource(j,creation);await store.save(j);
   if(await exists(creation.kind,creation.name)){
    recordResource(j,await observe(creation.kind,creation.name));await store.save(j);
    return{exitCode:0,stdout:j.resources.find(r=>r.kind===creation.kind&&r.name===creation.name)!.id!};
   }
   if(j.resources.find(r=>r.kind===creation.kind&&r.name===creation.name)!.id)throw Error('PHYSICAL_ID_CHANGED');
   const extra=Object.entries(physicalLabels(runId,creation.managed)).filter(([k])=>k!=='trainer-sync.managed').flatMap(([k,v])=>['--label',k+'='+v]);
   if(creation.kind==='container')extra.push('--env','TEAM_TEST_RUN_ID='+runId,'--env','TEAM_PHYSICAL_TEST_ONLY=true');
   args=[...args.slice(0,-1),...extra,args.at(-1)!];
   let result;
   try{result=await execute(args);}catch{uncertainResource(j,creation.kind,creation.name);await store.save(j);throw Error('PHYSICAL_CREATE_OUTCOME_UNCERTAIN');}
   try{recordResource(j,await observe(creation.kind,creation.name));await store.save(j);}catch{uncertainResource(j,creation.kind,creation.name);await store.save(j);throw Error('PHYSICAL_CREATE_OUTCOME_UNCERTAIN');}
   return result;
  }
  if(input.some(v=>/\.Env\b|\.Args\b|password|cookie|secret/i.test(v)))throw Error('PHYSICAL_COMMAND_REJECTED');
  if(['start','stop','rm'].includes(args[0]??''))await owned('container',args.at(-1)!);
  else if(args[0]==='network'&&args[1]==='connect'){await owned('network',args.at(-2)!);await owned('container',args.at(-1)!);}
  else if(args[0]==='network'&&args[1]==='rm')await owned('network',args.at(-1)!);
  else if(args[0]==='volume'&&args[1]==='rm')await owned('volume',args.at(-1)!);
  else if(!(args[0]==='inspect'||['network','container','volume'].includes(args[0]??'')&&['ls','inspect'].includes(args[1]??'')))throw Error('PHYSICAL_COMMAND_REJECTED');
  const result=await execute(args);
  if(args[0]==='rm'||(args[0]==='network'||args[0]==='volume')&&args[1]==='rm'){
   const kind:ResourceKind=args[0]==='rm'?'container':args[0] as 'network'|'volume',j=await store.load();
   const r=j.resources.find(v=>v.kind===kind&&(v.name===args.at(-1)||v.id===args.at(-1)));
   if(r&&!await exists(kind,r.name)){markResourceAbsent(j,kind,r.name,true);await store.save(j);}
  }return result;
 };
}
