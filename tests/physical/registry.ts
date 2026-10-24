import{requireUuid}from'../../packages/engine/src/team-errors.ts';
import{physicalNames,physicalLabels}from'./config.ts';
export type ResourceKind='container'|'network'|'volume';
export interface Resource{kind:ResourceKind;name:string;managed:string;id?:string;state:'reserved'|'created'|'uncertain'|'removed'}
export interface ObservedResource{kind:ResourceKind;name:string;id:string;labels:Record<string,string>;running?:boolean}
export interface PhysicalJournal{version:1;runId:string;resources:Resource[]}
export function newJournal(runId:string):PhysicalJournal{return{version:1,runId:requireUuid(runId),resources:[]};}
export function reserveResource(j:PhysicalJournal,input:Omit<Resource,'id'|'state'>):void{
 const n=physicalNames(j.runId),service=input.kind==='container'?[n.web,n.db,n.ingress,n.gateway,n.worker,n.egress].includes(input.name):input.kind==='network'&&input.name===n.network,generated=(input.kind==='container'?/^ts-team-browser-[a-f0-9]{32}$/:input.kind==='network'?/^ts-team-net-[a-f0-9]{32}$/:/^ts-team-profile-[a-f0-9]{32}$/).test(input.name);
 if(!service&&!generated||!/^\w[\w.-]{0,100}$/.test(input.name)||!input.managed)throw Error('PHYSICAL_RESOURCE_SCOPE_INVALID');
 const found=j.resources.find(v=>v.kind===input.kind&&v.name===input.name);if(found){if(found.managed!==input.managed||found.state==='removed')throw Error('PHYSICAL_RESOURCE_REUSE_REJECTED');return;}
 j.resources.push({...input,state:'reserved'});
}
function observedMatches(j:PhysicalJournal,r:Resource,o:ObservedResource){
 const labels=physicalLabels(j.runId,r.managed);
 if(o.kind!==r.kind||o.name!==r.name||Object.entries(labels).some(([k,v])=>o.labels[k]!==v)||!o.id||r.kind==='container'&&!/^[a-f0-9]{64}$/.test(o.id)||r.kind==='network'&&!/^[a-f0-9]{64}$/.test(o.id)||r.kind==='volume'&&o.id!==o.name)throw Error('PHYSICAL_OWNERSHIP_MISMATCH');
 if(r.id&&r.id!==o.id)throw Error('PHYSICAL_ID_CHANGED');
}
export function recordResource(j:PhysicalJournal,o:ObservedResource):void{
 const r=j.resources.find(v=>v.kind===o.kind&&v.name===o.name);if(!r)throw Error('PHYSICAL_RESOURCE_NOT_RESERVED');observedMatches(j,r,o);r.id=o.id;r.state='created';
}
export function uncertainResource(j:PhysicalJournal,kind:ResourceKind,name:string){const r=j.resources.find(v=>v.kind===kind&&v.name===name);if(!r)throw Error('PHYSICAL_RESOURCE_NOT_RESERVED');r.state='uncertain';}
export function cleanupPlan(j:PhysicalJournal,observed:ObservedResource[]):string[][]{
 const commands:string[][]=[];for(const r of j.resources.filter(v=>v.state!=='removed')){
  const o=observed.find(v=>v.kind===r.kind&&v.name===r.name);
  if(!o){if(r.state==='reserved'||r.state==='uncertain')continue;throw Error('PHYSICAL_RESOURCE_MISSING_RECONCILE');}
  observedMatches(j,r,o);if(!r.id)throw Error('PHYSICAL_RECORD_ID_BEFORE_CLEANUP');
 }
 for(const kind of['container','network','volume']as const)for(const r of j.resources.filter(v=>v.kind===kind&&v.state!=='removed'&&v.id)){
  const o=observed.find(v=>v.kind===kind&&v.id===r.id);if(!o)continue;
  if(kind==='container'){if(o.running)commands.push(['stop','--time','10',r.id!]);commands.push(['rm',r.id!]);}
  if(kind==='network')commands.push(['network','rm',r.id!]);if(kind==='volume')commands.push(['volume','rm',r.name]);
 }return commands;
}

export function markResourceAbsent(j:PhysicalJournal,kind:ResourceKind,name:string,confirmedAbsent:boolean){if(!confirmedAbsent)throw Error('PHYSICAL_ABSENCE_UNVERIFIED');const r=j.resources.find(v=>v.kind===kind&&v.name===name);if(!r)throw Error('PHYSICAL_RESOURCE_NOT_RESERVED');r.state='removed';}
