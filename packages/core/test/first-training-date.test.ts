import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFirstTrainingDate as resolve } from '../src/first-training-date.ts';

test('application date anchors current or following year independently of execution time',()=>{
  assert.equal(resolve({applicationDate:'2026-10-23',month:11,day:17,weekday:2}).date,'2026-11-17');
  assert.equal(resolve({applicationDate:'2020-12-20',month:1,day:5}).date,'2021-01-05');
  assert.equal(resolve({applicationDate:'2020-01-05',month:1,day:5}).date,'2020-01-05');
  assert.deepEqual(resolve({applicationDate:'2020-12-20',month:1,day:5}),resolve({applicationDate:'2020-12-20',month:1,day:5}));
});
test('two calendar months includes the boundary and clamps month ends',()=>{
  assert.equal(resolve({applicationDate:'2026-10-23',month:12,day:23}).status,'resolved');
  assert.deepEqual(resolve({applicationDate:'2026-10-23',month:12,day:24}),{status:'review',date:null,reason:'outside_application_window'});
  assert.equal(resolve({applicationDate:'2023-12-31',month:2,day:29}).date,'2024-02-29');
  assert.equal(resolve({applicationDate:'2024-12-31',month:2,day:28}).date,'2025-02-28');
  assert.equal(resolve({applicationDate:'2024-01-31',month:3,day:31}).status,'resolved');
  assert.equal(resolve({applicationDate:'2024-01-31',month:4,day:1}).status,'review');
});
test('leap dates do not search ahead for a more convenient year',()=>{
  assert.equal(resolve({applicationDate:'2024-01-01',month:2,day:29}).date,'2024-02-29');
  assert.deepEqual(resolve({applicationDate:'2025-01-01',month:2,day:29}),{status:'review',date:null,reason:'training_date_invalid'});
  assert.equal(resolve({applicationDate:'2024-03-01',month:2,day:29}).status,'review');
  for(const patch of [{month:2,day:30},{month:4,day:31},{month:0,day:1},{month:12,day:0}])assert.equal(resolve({applicationDate:'2026-01-01',...patch}).status,'review');
});
test('explicit years are honored and never shifted to pass validation',()=>{
  assert.equal(resolve({applicationDate:'2026-10-23',month:11,day:17,explicitYear:2026}).status,'resolved');
  for(const explicitYear of [2025,2027])assert.deepEqual(resolve({applicationDate:'2026-10-23',month:11,day:17,explicitYear}),{status:'review',date:null,reason:'outside_application_window'});
});
test('missing/invalid application dates and weekday conflicts hold without guessing',()=>{
  assert.deepEqual(resolve({applicationDate:null,month:11,day:17}),{status:'review',date:null,reason:'application_date_required'});
  for(const applicationDate of ['2026-02-30','2026-1-1','2026-10-23T10:00:00Z'])assert.deepEqual(resolve({applicationDate,month:11,day:17}),{status:'review',date:null,reason:'application_date_invalid'});
  for(const weekday of [1,0,8])assert.deepEqual(resolve({applicationDate:'2026-10-23',month:11,day:17,weekday}),{status:'review',date:null,reason:'weekday_conflict'});
});
