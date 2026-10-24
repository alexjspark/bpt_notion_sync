import {test} from 'node:test';import assert from 'node:assert/strict';
import {phase2Boundary}from '../lib/team-boundary.ts';
test('phase2 ON disables legacy APIs and redirects pages instead of tenant fallback',()=>{
 for(const p of ['/api/dashboard','/api/manual-sync','/api/settings','/api/contacts','/api/storage-test','/api/team-evil'])assert.equal(phase2Boundary(p,true),'block');
 assert.equal(phase2Boundary('/api/health',true),'allow');assert.equal(phase2Boundary('/api/team/connections',true),'allow');
 assert.equal(phase2Boundary('/',true),'redirect');assert.equal(phase2Boundary('/connections',true),'redirect');
});
test('phase2 OFF preserves original path but new endpoints are disabled',()=>{
 assert.equal(phase2Boundary('/api/manual-sync',false),'allow');assert.equal(phase2Boundary('/team',false),'block');assert.equal(phase2Boundary('/api/team/login',false),'block');
});
