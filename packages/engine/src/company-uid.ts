import{auditEvent}from'./audit-log.ts';
import{NotionReviewRequiredError,object,array}from'./live-notion-client.ts';
export type CompanyUidPropertyType='rich_text'|'number';
export function companyUidValue(uid:string,type:CompanyUidPropertyType):Record<string,unknown>{
 if(typeof uid!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(uid))throw new NotionReviewRequiredError('COMPANY_UID_INVALID');
 if(type==='rich_text')return{rich_text:[{type:'text',text:{content:uid}}]};
 if(type==='number'&&/^(0|[1-9]\d*)$/.test(uid)&&Number.isSafeInteger(Number(uid))&&String(Number(uid))===uid)return{number:Number(uid)};
 throw new NotionReviewRequiredError('COMPANY_UID_REPRESENTATION_UNSAFE');
}
export function planCompanyUidFill(uid:string,property:Record<string,unknown>):{decision:'fill'|'noop'|'held';reasonCode?:string;body?:Record<string,unknown>}{
 const type=property.type;if(type!=='rich_text'&&type!=='number')return{decision:'held',reasonCode:'UID_SCHEMA_UNSUPPORTED'};
 let wanted:Record<string,unknown>;try{wanted=companyUidValue(uid,type);}catch{return{decision:'held',reasonCode:'UID_REPRESENTATION_UNSAFE'};}
 if(type==='number'){
  if(property.number===null)return{decision:'fill',body:wanted};
  if(typeof property.number!=='number'||!Number.isSafeInteger(property.number))return{decision:'held',reasonCode:'UID_EXISTING_VALUE_INVALID'};
  return String(property.number)===uid?{decision:'noop'}:{decision:'held',reasonCode:'UID_CONFLICT'};
 }
 if(!Array.isArray(property.rich_text))return{decision:'held',reasonCode:'UID_EXISTING_VALUE_INVALID'};
 let current:string;try{current=array(property.rich_text).map(raw=>{const r=object(raw);return typeof r.plain_text==='string'?r.plain_text:String(object(r.text).content);}).join('');}catch{return{decision:'held',reasonCode:'UID_EXISTING_VALUE_INVALID'};}
 if(!current&&property.rich_text.length===0)return{decision:'fill',body:wanted};
 return current===uid?{decision:'noop'}:{decision:'held',reasonCode:'UID_CONFLICT'};
}
/** At most one minimal property request; uncertain outcomes reconcile by reading, never replaying. Caller owns scope/consent. */
export async function fillCompanyUidOnce(input:{uid:string;propertyId:string;read:()=>Promise<Record<string,unknown>>;write:(body:Record<string,unknown>)=>Promise<void>;consume:()=>Promise<void>}){
 const current=await input.read(),plan=planCompanyUidFill(input.uid,current);
 await auditEvent({stage:'plan',outcome:plan.decision==='held'?'held':plan.decision==='noop'?'skipped':'succeeded',fields:['companyUid'],reasonCode:plan.reasonCode,provider:'notion',operation:'transform'});
 if(plan.decision!=='fill')return{decision:plan.decision,reasonCode:plan.reasonCode,verified:plan.decision==='noop',uncertain:false};
 await input.consume();let uncertain=false;try{await input.write({properties:{[input.propertyId]:plan.body}});}catch{uncertain=true;}
 const after=await input.read(),verified=planCompanyUidFill(input.uid,after).decision==='noop';
 await auditEvent({stage:'readback',outcome:verified?uncertain?'uncertain':'succeeded':'held',fields:['companyUid'],provider:'notion',operation:'reconcile',readbackMatch:verified,reasonCode:verified?undefined:'UID_READBACK_MISMATCH'});
 return{decision:verified?'saved' as const:'held' as const,verified,uncertain,reasonCode:verified?undefined:'UID_READBACK_MISMATCH'};
}
