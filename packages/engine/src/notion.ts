import { createHash } from 'node:crypto';
import { applyTemplateMappings, normalizeMember } from '@trainer/core';
import type { Member, ScheduleEvent, TemplateBlock, TemplateMapping } from '@trainer/core';
import { query, transaction } from '@trainer/db';
import type { NotionAdapter } from './ports.ts';
import { assertMockMode, ExternalAdapterDisabledError, RetryableError } from './ports.ts';

export const MOCK_TEMPLATE: TemplateBlock[] = [
  {id:'welcome',text:'$$$님 안내',ownership:'template'},
  {id:'coach',text:'담당 트레이너: @@',ownership:'template'},
  {id:'history-parent',text:'기록',ownership:'template',children:[{id:'growth-title',text:'000님 성장 히스토리',ownership:'template'}]},
  {id:'manual-note',text:'사용자가 직접 작성한 $$$와 @@ 메모',ownership:'manual'},
];
export const MOCK_TEMPLATE_MAPPINGS: TemplateMapping[] = [
  {blockId:'welcome',token:'$$$',contextKey:'memberName',expectedText:'$$$님 안내'},
  {blockId:'coach',token:'@@',contextKey:'trainerName',expectedText:'담당 트레이너: @@'},
  {blockId:'growth-title',token:'000',contextKey:'memberName',expectedText:'000님 성장 히스토리'},
];

export class UnverifiedNotionAdapter implements NotionAdapter {
  async ensureMemberPage(): Promise<never> { throw new ExternalAdapterDisabledError(); }
  async awaitTemplate(): Promise<never> { throw new ExternalAdapterDisabledError(); }
  async fillMemberPage(): Promise<never> { throw new ExternalAdapterDisabledError(); }
  async readMembers(): Promise<never> { throw new ExternalAdapterDisabledError(); }
  async isMemberPageReady(): Promise<never> { throw new ExternalAdapterDisabledError(); }
  async readCalendar(): Promise<never> { throw new ExternalAdapterDisabledError(); }
  async writeCalendar(): Promise<never> { throw new ExternalAdapterDisabledError(); }
}

/** Durable local mock. It never imports a Notion SDK, token or network client. */
export class MockNotionAdapter implements NotionAdapter {
  constructor(private readonly options: {templateDelayMs?: number; afterCreate?: () => Promise<void>} = {}) {}
  async ensureMemberPage(member: Member): Promise<{pageId:string}> {
    assertMockMode();
    const pageId = `mock-${createHash('sha256').update(`${member.trainerId}\0${member.companyMemberId}`).digest('hex').slice(0,24)}`;
    await query(`INSERT INTO mock_notion_pages(trainer_id,company_member_id,page_id,stage,ready_at,body,member_data)
      VALUES($1,$2,$3,'template_pending',now()+$4::int*interval '1 millisecond',$5::jsonb,$6::jsonb)
      ON CONFLICT(trainer_id,company_member_id) DO NOTHING`, [member.trainerId, member.companyMemberId, pageId, this.options.templateDelayMs ?? 20, JSON.stringify(MOCK_TEMPLATE), JSON.stringify(member)]);
    await this.options.afterCreate?.();
    return {pageId};
  }
  async awaitTemplate(trainerId:string, memberId:string):Promise<void> {
    assertMockMode();
    for(let attempt=0;attempt<5;attempt++){
      await query(`UPDATE mock_notion_pages SET stage='template_ready',updated_at=now()
        WHERE trainer_id=$1 AND company_member_id=$2 AND stage='template_pending' AND ready_at<=now()`, [trainerId,memberId]);
      const result = await query<{stage:string}>(`SELECT stage FROM mock_notion_pages WHERE trainer_id=$1 AND company_member_id=$2`,[trainerId,memberId]);
      if (!result.rows[0]) throw new Error('Mock page missing');
      if (result.rows[0].stage !== 'template_pending')return;
      if(attempt<4)await new Promise(resolve=>setTimeout(resolve,20));
    }
    throw new RetryableError('Mock template is still applying', this.options.templateDelayMs ?? 20);
  }
  async fillMemberPage(member:Member):Promise<void> {
    assertMockMode();
    await transaction(async client => {
      const result = await client.query(`SELECT * FROM mock_notion_pages WHERE trainer_id=$1 AND company_member_id=$2 FOR UPDATE`,[member.trainerId,member.companyMemberId]);
      const row = result.rows[0];
      if (!row || row.stage === 'template_pending') throw new RetryableError('Template must finish before personalization',20);
      if (row.stage === 'complete') {
        // Repeated company imports only refresh source-managed survey, never a user's edits.
        const preserved = {...row.member_data,survey:member.survey,registrationDate:member.registrationDate,assignmentDate:member.assignmentDate};
        const body={...(Array.isArray(row.body)?{blocks:row.body}:row.body),specialVideos:structuredClone(member.survey)};
        await client.query(`UPDATE mock_notion_pages SET member_data=$3::jsonb,body=$4::jsonb,updated_at=now() WHERE trainer_id=$1 AND company_member_id=$2`,[member.trainerId,member.companyMemberId,JSON.stringify(preserved),JSON.stringify(body)]);
        return;
      }
      const personalized = applyTemplateMappings(row.body as TemplateBlock[],MOCK_TEMPLATE_MAPPINGS,{memberName:member.name,trainerName:'합성 트레이너'});
      if (personalized.issues.length) throw new Error(`Template mappings need review: ${personalized.issues.map(x=>x.code).join(',')}`);
      const body = {blocks:personalized.blocks,specialVideos:structuredClone(member.survey),manualContent:row.manual_content || member.manualContent};
      await client.query(`UPDATE mock_notion_pages SET stage='complete',body=$3::jsonb,member_data=$4::jsonb,updated_at=now()
        WHERE trainer_id=$1 AND company_member_id=$2`,[member.trainerId,member.companyMemberId,JSON.stringify(body),JSON.stringify(member)]);
    });
  }
  async readMembers(trainerId:string):Promise<Member[]> {
    assertMockMode();
    const result = await query<{member_data:Member}>(`SELECT member_data FROM mock_notion_pages WHERE trainer_id=$1 AND stage='complete' ORDER BY company_member_id`,[trainerId]);
    return result.rows.map(row=>normalizeMember(row.member_data));
  }
  async isMemberPageReady(member:Member):Promise<boolean> {
    assertMockMode();
    if(!member.notionPageId?.trim())return false;
    const result=await query(`SELECT 1 FROM mock_notion_pages
      WHERE trainer_id=$1 AND company_member_id=$2 AND page_id=$3 AND stage='complete'`,[member.trainerId,member.companyMemberId,member.notionPageId]);
    return Boolean(result.rowCount);
  }
  async readCalendar(trainerId:string):Promise<ScheduleEvent[]> {
    assertMockMode();
    const result = await query<{data:ScheduleEvent}>(`SELECT data FROM mock_notion_events WHERE trainer_id=$1 ORDER BY event_key`,[trainerId]);
    return result.rows.map(row=>row.data);
  }
  async writeCalendar(trainerId:string, events:ScheduleEvent[]):Promise<void> {
    assertMockMode();
    await transaction(async client=>{
      for (const event of events) {
        if(event.trainerId!==trainerId) throw new Error('TENANT_MISMATCH');
        const relation=await client.query(`SELECT 1 FROM mock_notion_pages p JOIN members m
          ON m.trainer_id=p.trainer_id AND m.company_member_id=p.company_member_id
          WHERE p.trainer_id=$1 AND p.company_member_id=$2 AND p.stage='complete'
          AND m.data->>'notionPageId'=p.page_id`,[trainerId,event.companyMemberId]);
        if(!relation.rowCount)throw new Error('MEMBER_PAGE_REQUIRED: calendar relation is not ready');
        await client.query(`INSERT INTO mock_notion_events(trainer_id,event_key,company_member_id,data) VALUES($1,$2,$3,$4::jsonb)
          ON CONFLICT(trainer_id,event_key) DO UPDATE SET data=excluded.data,updated_at=now()`,[trainerId,event.key,event.companyMemberId,JSON.stringify(event)]);
      }
    });
  }
}
