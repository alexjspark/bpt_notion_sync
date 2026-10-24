import test from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_NEW_MEMBER_STATUS, NEW_MEMBER_STATUS, normalizeMember, normalizeMemberStatus, prepareMember } from '../src/index.js';
import type { Member, MemberStatus } from '../src/index.js';

const fixture:Member={trainerId:'status-trainer',companyMemberId:'status-member',name:'Synthetic member',status:NEW_MEMBER_STATUS,notionPageId:'synthetic-page',registrationDate:null,assignmentDate:null,assignmentEvidence:'existing',membershipActivity:'active',memo:'',fixedSlot:null,firstTrainingDate:null,callAt:null,survey:[],manualContent:'Synthetic manual note'};

test('신규 is canonical and only exact historical 카톡전 is normalized on read',()=>{
  assert.equal(NEW_MEMBER_STATUS,'신규');assert.equal(normalizeMemberStatus(LEGACY_NEW_MEMBER_STATUS),'신규');
  for(const status of ['신규','통화','진행','졸업','탈퇴','탈퇴 요청','유예','확인필요'] satisfies MemberStatus[])assert.equal(normalizeMemberStatus(status),status);
  for(const value of ['카톡전 ',' 카톡전','탈퇴요청','Unknown status'])assert.equal(normalizeMemberStatus(value),value);
});

test('legacy saved members display canonically without mutating saved data or other fields',()=>{
  const legacy={...fixture,status:LEGACY_NEW_MEMBER_STATUS} as unknown as Member;
  const normalized=normalizeMember(legacy);
  assert.equal(normalized.status,NEW_MEMBER_STATUS);assert.equal(legacy.status,LEGACY_NEW_MEMBER_STATUS);
  assert.deepEqual({...normalized,status:legacy.status},legacy);
});

test('company refresh keeps existing workflow statuses and translates only the legacy alias',()=>{
  const incoming={...fixture,status:'신규' as const,assignmentEvidence:'new' as const};
  for(const status of ['신규','통화','진행','졸업','탈퇴','탈퇴 요청','유예','확인필요'] satisfies MemberStatus[]){
    const result=prepareMember(incoming,{...fixture,status});assert.equal(result.member.status,status);assert.equal(result.member.manualContent,fixture.manualContent);
  }
  const result=prepareMember(incoming,{...fixture,status:LEGACY_NEW_MEMBER_STATUS} as unknown as Member);
  assert.equal(result.member.status,NEW_MEMBER_STATUS);
});
