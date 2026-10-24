import { detectScheduleConflicts, parseFixedSlot, prepareMember, reconcileSchedules, withTrainingRecurrenceState } from '@trainer/core';
import type { Member, ScheduleEvent } from '@trainer/core';
import { getMember, getMembers, getSchedules, getSettings, query, replaceIssues, saveSchedules, upsertMember } from '@trainer/db';
import { collectAssignedMembers } from './company.ts';
import type { CompanyAdapter, NotionAdapter } from './ports.ts';

export interface SyncAdapters { company:CompanyAdapter; notion:NotionAdapter; now?:()=>string; guard?:()=>Promise<void>; }
export function calendarWithManualChanges(local:ScheduleEvent[],remote:ScheduleEvent[]):ScheduleEvent[] {
  const sameInstant=(left:string,right:string):boolean=>{
    const a=Date.parse(left);const b=Date.parse(right);
    return Number.isFinite(a)&&Number.isFinite(b)&&a===b;
  };
  const result=new Map(local.map(item=>[item.key,item]));
  for(const event of remote) {
    const known=result.get(event.key);
    const manual=event.manualOverride||Boolean(known&&(!sameInstant(event.start,known.sourceStart)||!sameInstant(event.end,known.sourceEnd)||event.status!==known.status));
    result.set(event.key,{...event,manualOverride:manual,sourceStart:known?.sourceStart??event.sourceStart,sourceEnd:known?.sourceEnd??event.sourceEnd,
      ...(known?.sourceStatus!==undefined?{sourceStatus:known.sourceStatus}:{})});
  }
  return [...result.values()];
}
export async function reconcileMemberCalendar(member:Member,adapters:SyncAdapters):Promise<import('@trainer/core').Issue[]> {
  if(!member.notionPageId?.trim()||!await adapters.notion.isMemberPageReady(member)) {
    // An initial poll can run before the first company import, or while template
    // creation is awaiting a retry. Neither state authorizes an unlinked event.
    return [{code:'MEMBER_PAGE_REQUIRED',message:'A verified, completed Notion member page is required before synchronizing its calendar relation.',companyMemberId:member.companyMemberId}];
  }
  const settings=await getSettings(member.trainerId);
  const local=await getSchedules(member.trainerId);
  const remote=await adapters.notion.readCalendar(member.trainerId);
  if([...local,...remote].some(event=>event.trainerId!==member.trainerId))throw new Error('TENANT_MISMATCH');
  // A different member may have moved a Calendar event since the last poll.
  // Use one complete merged trainer snapshot for both reconciliation and conflicts.
  const snapshot=calendarWithManualChanges(local,remote);
  const existing=snapshot.filter(event=>event.companyMemberId===member.companyMemberId);
  const result=reconcileSchedules(member,existing,{now:adapters.now?.()??new Date().toISOString(),timezone:settings.timezone,horizonMonths:settings.horizonMonths});
  const others=snapshot.filter(event=>event.companyMemberId!==member.companyMemberId);
  const previous=new Map(existing.map(event=>[event.key,event]));
  const currentTime=new Date(adapters.now?.()??new Date().toISOString()).getTime();
  let held=false;
  const safeEvents=result.events.flatMap(event=>{
    // Cancellation, history, and an actual manual Calendar edit remain valid even
    // when some unrelated members already conflict. Hold only colliding automation.
    const automatedFuture=event.status==='active'&&!event.manualOverride&&new Date(event.start).getTime()>=currentTime;
    const conflicts=automatedFuture?detectScheduleConflicts([...others,event]).filter(issue=>issue.companyMemberId===member.companyMemberId):[];
    if(!conflicts.length)return [event];
    held=true;
    const old=previous.get(event.key);
    return old?[old]:[];
  });
  // Persist remote first. If local persistence fails, a retry reuses deterministic keys and pulls manual edits back.
  await adapters.guard?.();
  await adapters.notion.writeCalendar(member.trainerId,safeEvents);
  await saveSchedules(member.trainerId,safeEvents);
  return [...result.issues,...(held?[{code:'SCHEDULE_CONFLICT',message:'Trainer schedules overlap; colliding automated occurrences are held for confirmation.',companyMemberId:member.companyMemberId}]:[])];
}
export async function syncCompany(trainerId:string,adapters:SyncAdapters):Promise<void> {
  const source=await collectAssignedMembers(adapters.company,trainerId);
  const notionMembers=new Map((await adapters.notion.readMembers(trainerId)).map(member=>[member.companyMemberId,member]));
  for(const original of source) {
    await adapters.guard?.();
    const stored=await getMember(trainerId,original.companyMemberId);
    const remoteMember=notionMembers.get(original.companyMemberId);
    const existing=remoteMember?withTrainingRecurrenceState(remoteMember,stored):stored;
    const parsed=parseFixedSlot(original.memo);
    const prepared=prepareMember({...original,fixedSlot:parsed.slot},existing);
    let member=prepared.member;
    await upsertMember(trainerId,member);
    const page=await adapters.notion.ensureMemberPage(member);
    member={...member,notionPageId:page.pageId};
    await upsertMember(trainerId,member);
    await adapters.notion.awaitTemplate(trainerId,member.companyMemberId);
    await adapters.guard?.();
    await adapters.notion.fillMemberPage(member);
    const calendarIssues=await reconcileMemberCalendar(member,adapters);
    // prepareMember already includes the memo parser's issues for this member.
    await replaceIssues(trainerId,member.companyMemberId,[...prepared.issues,...calendarIssues]);
  }
  // An absent member is never implicitly marked withdrawn: incomplete extraction could cause disappearance.
}
export async function pollNotion(trainerId:string,adapters:SyncAdapters):Promise<void> {
  const remote=await adapters.notion.readMembers(trainerId);
  for(const member of remote) {
    await adapters.guard?.();
    if(member.trainerId!==trainerId)throw new Error('TENANT_MISMATCH');
    const local=await getMember(trainerId,member.companyMemberId);
    if(!local)continue; // importing unknown real pages requires validated member/relation mapping.
    await upsertMember(trainerId,withTrainingRecurrenceState({...local,status:member.status,memo:member.memo,fixedSlot:member.fixedSlot,
      firstTrainingDate:member.firstTrainingDate,callAt:member.callAt,manualContent:member.manualContent},local));
  }
  for(const member of await getMembers(trainerId)) {
    const parsed=parseFixedSlot(member.memo);
    const calendarIssues=await reconcileMemberCalendar(member,adapters);
    const review=member.status==='확인필요'?[{code:'MEMBER_REVIEW_REQUIRED',message:'Confirm member status and activity before scheduling.',companyMemberId:member.companyMemberId}]:[];
    const unresolved=await query<{code:string;message:string}>(`SELECT code,message FROM issues
      WHERE trainer_id=$1 AND company_member_id=$2 AND code IN ('WITHDRAWAL_REVIEW','MEMBERSHIP_REVIEW','EXISTING_MEMBER_REVIEW')`,[trainerId,member.companyMemberId]);
    const sourceReviews=unresolved.rows.filter(issue=>
      !(issue.code==='WITHDRAWAL_REVIEW'&&member.status==='탈퇴')&&
      !(issue.code==='MEMBERSHIP_REVIEW'&&member.membershipActivity!=='unknown')
    ).map(issue=>({...issue,companyMemberId:member.companyMemberId}));
    await replaceIssues(trainerId,member.companyMemberId,[...sourceReviews,...parsed.issues,...review,...calendarIssues]);
  }
}
