// Dedicated company browser only. No credentials, contacts, storage, screenshots or provider bodies are read.
import {readFile,writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
const endpoint='http://company-browser:9222';
const origin='https://admin.biz-pt.com';
let stage='connect';
try{
 const previous=JSON.parse(await readFile('/run/previous-snapshot.json','utf8'));
 const browser=await chromium.connectOverCDP(endpoint,{timeout:12000});
 const page=browser.contexts().flatMap(c=>c.pages()).find(p=>{try{return new URL(p.url()).origin===origin;}catch{return false;}});
 if(!page)throw new Error('COMPANY_PAGE_MISSING');
 const inspect=async(kind)=>{
   const member=kind==='members';
   await page.goto(origin+(member?'/manage/members':'/manage/self-withdrawals'),{waitUntil:'domcontentloaded',timeout:15000});
   await page.waitForFunction(()=>document.querySelectorAll('table').length>=2||document.querySelector('input[type=password]'),{timeout:12000});
   if(member) await page.waitForFunction(label=>Array.from(document.querySelectorAll('select')).some(n=>n.value==='Y'&&n.selectedOptions[0]?.textContent.trim()===label),previous.progressFilter,{timeout:10000});
   return page.evaluate(({origin,member,progressHeader,progressLabel,requestsHeading})=>{
     const auth=location.origin===origin&&!/\/(?:login|signin|sign-in|auth)(?:\/|$)/i.test(location.pathname)&&!document.querySelector('input[type=password]');
     const tables=document.querySelectorAll('table'),headers=Array.from(tables[0]?.querySelectorAll('thead th')??[],n=>n.textContent?.trim()??'');
     const rows=Array.from(tables[1]?.querySelectorAll('tbody tr')??[]);
     const records=[];let invalid=0;
     for(const row of rows){
       const cells=row.querySelectorAll('td');
       if(cells.length!==(member?15:10)){invalid++;continue;}
       const links=Array.from(row.querySelectorAll('a[href]')).flatMap(a=>{try{const u=new URL(a.getAttribute('href'),origin);return u.origin===origin&&!u.search&&!u.hash&&/^\/manage\/members\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(u.pathname)?[u.pathname.split('/').at(-1)]:[];}catch{return[];}});
       const uids=[...new Set(links)];
       const name=cells[2]?.textContent?.trim()??'';
       if(uids.length!==1||!name){invalid++;continue;}
       records.push({uid:uids[0],name,cellCount:cells.length,...(member?{activity:cells[9]?.textContent?.trim()??''}:{})});
     }
     const text=document.body.textContent??'';
     const markers=[...text.matchAll(/(?:전체|검색|총|결과)\s*[:：]?\s*[\d,]+\s*(?:명|건|개)?/g)].map(m=>m[0]);
     const count=label=>{const m=text.match(new RegExp(label+'\\s+[:：]?\\s*([\\d,]+)\\s*(?:명|건|개)?'));return m?Number(m[1].replaceAll(',','')):null;};
     const all=count('전체'),filtered=count('검색');
     const pagination=Array.from(document.querySelectorAll('button,a,[role=button]')).filter(n=>/^(next|prev|previous|다음|이전)$/i.test((n.getAttribute('aria-label')??n.textContent??'').trim()));
     const comboboxes=Array.from(document.querySelectorAll('[role=combobox]'));
     const progressSelects=Array.from(document.querySelectorAll('select')).filter(n=>Array.from(n.options).some(o=>o.value==='Y'&&o.textContent.trim()===progressLabel)&&Array.from(n.options).some(o=>o.value==='N'&&o.textContent.trim()==='탈퇴'));
     const options=Array.from(document.querySelectorAll('select option')).flatMap(n=>{const label=n.textContent?.trim();return ['Y','N','all'].includes(n.value)&&['진행','탈퇴','전체'].includes(label)?[{label,value:n.value}]:[];});
     const headingMatches=member?headers[9]===progressHeader:Array.from(document.querySelectorAll('h1,h2,h3')).some(n=>n.textContent?.trim()===requestsHeading);
     return{auth,headingMatches,tableCount:tables.length,records,invalid,markers,totals:all!==null&&filtered!==null?{all,filtered}:null,progressMarkers:progressSelects.filter(n=>n.value==='Y').length,
       pagination:{controls:pagination.length,enabled:pagination.filter(n=>!n.hasAttribute('disabled')&&n.getAttribute('aria-disabled')!=='true').length},
       nativeProgressOptions:options,stableAccountMarkerCount:document.querySelectorAll('[data-account-id],[data-user-id],[data-trainer-id],[data-manager-id]').length};
   },{origin,member,progressHeader:previous.progressHeader,progressLabel:previous.progressFilter,requestsHeading:previous.requestsHeading});
 };
 stage='members';const members=await inspect('members');
 console.log(JSON.stringify({stage:'members_checked',auth:members.auth,headingMatches:members.headingMatches,invalidRows:members.invalid,rows:members.records.length,progressMarkers:members.progressMarkers,activeY:members.records.filter(r=>r.activity==='Y').length,totals:members.totals,countMarkers:members.markers,pagination:members.pagination,stableAccountMarkerObserved:members.stableAccountMarkerCount>0}));
 if(!members.auth||!members.headingMatches||members.invalid||members.progressMarkers!==1||members.records.some(r=>r.activity!=='Y'))throw new Error('MEMBER_UI_UNVERIFIED');
 stage='requests';const requests=await inspect('requests');
 if(!requests.auth||!requests.headingMatches||requests.invalid)throw new Error('REQUEST_UI_UNVERIFIED');
 stage='stability';const again=await inspect('members');
 if(!again.auth||JSON.stringify(members.records)!==JSON.stringify(again.records))throw new Error('COMPANY_SNAPSHOT_CHANGED');
 const completeness=members.totals?.filtered===members.records.length&&members.pagination.enabled===0;
 const unique=new Set(members.records.map(r=>r.uid));if(unique.size!==members.records.length)throw new Error('DUPLICATE_UID');
 const snapshot={...previous,progressOptions:members.nativeProgressOptions.filter((o,i,a)=>a.findIndex(x=>x.label===o.label&&x.value===o.value)===i),totals:members.totals,members:members.records,requests:requests.records,
   collection:{channel:'dedicated-company-browser',collectedAt:new Date().toISOString(),twoMatchingMemberPasses:true,memberUiCountMatches:completeness,
     memberPagination:members.pagination,requestPagination:requests.pagination,requestCountMarkers:requests.markers,
     stableAccountMarkerObserved:members.stableAccountMarkerCount>0,accountBinding:'not_verified',ordinaryRuntimeReady:false}};
 await writeFile('/out/company-program-snapshot-20261023-live.json',JSON.stringify(snapshot,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({mode:'actual_company_observed_ui_read',status:'collected',members:members.records.length,requests:requests.records.length,totals:members.totals,
   twoMatchingMemberPasses:true,memberUiCountMatches:completeness,pagination:members.pagination,requestPagination:requests.pagination,
   stableAccountMarkerObserved:members.stableAccountMarkerCount>0,accountBinding:'not_verified',ordinaryRuntimeReady:false,externalWritesEnabled:false}));
 process.exit(0);
}catch(e){const allowed=['COMPANY_PAGE_MISSING','MEMBER_UI_UNVERIFIED','REQUEST_UI_UNVERIFIED','COMPANY_SNAPSHOT_CHANGED','DUPLICATE_UID'];
 console.log(JSON.stringify({mode:'actual_company_observed_ui_read',stage,status:'failed',code:allowed.includes(e?.message)?e.message:'COLLECTION_FAILED',externalWritesEnabled:false}));process.exit(1);}
