'use client';
import { useEffect,useState,type FormEvent } from 'react';
type State={id:string;revision:number;companyStatus:string;notionStatus:string;vaultReady:boolean;companyProviderReady:boolean;previewProviderReady:boolean;destination:{databaseId:string;dataSourceId:string;templateId:string}|null;session:{id:string;status:string;expiresAt:string;browserUrl?:string|null}|null;browserOperation?:{action:string;status:string;reasonCode:string|null}|null};
type Run={id:string;status:string;reasonCode:string|null;result:Record<string,number>|null};
export default function TeamPage(){
 const [state,setState]=useState<State|null>(null),[authenticated,setAuthenticated]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[run,setRun]=useState<Run|null>(null);
 async function api(path:string,value?:unknown){const r=await fetch('/api/team/'+path,{method:value===undefined?'GET':'POST',headers:value===undefined?{}:{'Content-Type':'application/json'},body:value===undefined?undefined:JSON.stringify(value),cache:'no-store'});const v=await r.json();if(!r.ok){if(r.status===401)setAuthenticated(false);throw Error(v.code??'REQUEST_FAILED');}return v;}
 async function refresh(){try{setState(await api('connections'));setAuthenticated(true);}catch(e){if((e as Error).message!=='AUTH_REQUIRED')setMessage((e as Error).message);}}
 useEffect(()=>{void refresh();},[]);
 useEffect(()=>{if(!authenticated||!state?.session)return;const timer=setInterval(()=>{void refresh();},3000);return()=>clearInterval(timer);},[authenticated,state?.session?.id]);
 useEffect(()=>{if(!run||!['queued','running'].includes(run.status))return;const timer=setInterval(()=>{void api('runs/'+run.id).then(setRun).catch(e=>setMessage(e.message));},1500);return()=>clearInterval(timer);},[run?.id,run?.status]);
 async function perform(fn:()=>Promise<void>){setBusy(true);setMessage('');try{await fn();}catch(e){setMessage((e as Error).message);}finally{setBusy(false);}}
 async function login(e:FormEvent<HTMLFormElement>){e.preventDefault();const form=e.currentTarget,d=new FormData(form);await perform(async()=>{await api('login',{login:d.get('login'),password:d.get('password')});form.reset();await refresh();});}
 async function notion(e:FormEvent<HTMLFormElement>){e.preventDefault();const form=e.currentTarget,d=new FormData(form);await perform(async()=>{try{await api('connections/notion',{revision:state!.revision,token:d.get('token'),destination:{databaseId:d.get('databaseId'),dataSourceId:d.get('dataSourceId'),templateId:d.get('templateId')}});await refresh();setMessage('연결 대상 읽기 검증 및 암호화 보관 완료');}finally{(form.elements.namedItem('token') as HTMLInputElement).value='';}});}
 return <main style={{maxWidth:880,margin:'32px auto',padding:24}}>
  <h1>비즈니스PT · 동료별 연결 준비</h1>
  <p>2단계 로컬 개발 기능입니다. 실제 동료 로그인·서버 공개는 아직 검증하지 않았습니다. 예약 실행과 회원 쓰기는 OFF입니다.</p>
  <p>1차 기능의 일반 메모·설문·템플릿·캘린더 전체 흐름은 아직 미완성입니다.</p>
  {message&&<p role="status">{message}</p>}
  {!authenticated?<form onSubmit={login}><h2>서비스 로그인</h2><p>관리자가 발급한 본인 서비스 계정을 사용합니다. 공개 회원가입은 제공하지 않습니다.</p><label>로그인 ID <input name="login" required autoComplete="username"/></label><br/><label>비밀번호 <input name="password" type="password" required autoComplete="current-password" maxLength={128}/></label><br/><button disabled={busy}>로그인</button></form>:state&&<>
   <button disabled={busy} onClick={()=>perform(async()=>{await api('logout',{});setAuthenticated(false);setState(null);setRun(null);})}>로그아웃</button>
   <h2>회사 admin 전용 세션</h2><p>상태: {state.companyStatus} / 세션: {state.session?.status??'없음'}</p>
   <p>개인 Chrome의 회사 로그인은 서버로 전달되지 않습니다. 본인 전용 원격 회사 브라우저에서 직접 로그인해야 합니다.</p>
   {!state.companyProviderReady&&<p>브라우저 runner·로그인 게이트웨이·worker가 비활성 또는 준비되지 않았습니다.</p>}
   {state.browserOperation&&<p>브라우저 작업: {state.browserOperation.action} / {state.browserOperation.status}{state.browserOperation.reasonCode?' / '+state.browserOperation.reasonCode:''}</p>}
   {state.browserOperation?.status==='manual_review'&&<p>자동 정리 확인에 실패해 운영자 확인이 필요합니다. 기존 세션이 정리되기 전 새 브라우저를 배정하지 않습니다.</p>}
   <button disabled={busy||!state.companyProviderReady||!!state.session} onClick={()=>perform(async()=>{setState(await api('company/start',{revision:state.revision}));})}>본인 회사 로그인 세션 준비</button>
   {state.session?.browserUrl&&<p><a href={state.session.browserUrl} target="_blank" rel="noopener noreferrer">본인 전용 회사 로그인 화면 열기</a></p>}
   <button disabled={busy||!state.session||!['login_required','verified'].includes(state.session.status)||!state.companyProviderReady} onClick={()=>perform(async()=>{setState(await api('company/confirm',{revision:state.revision,sessionId:state.session!.id}));})}>본인 계정 로그인 확인</button>
   <button disabled={busy||!state.session} onClick={()=>perform(async()=>{setState(await api('company/revoke',{revision:state.revision,sessionId:state.session!.id}));})}>세션 취소·연결 해제</button>
   <h2>본인 Notion 연결</h2><p>상태: {state.notionStatus} / 연결 버전: {state.revision}</p>
   {!state.vaultReady&&<p>운영자 보관용 master 미설정으로 키 입력·저장이 차단돼 있습니다. 기존 개인 키를 재사용하지 않습니다.</p>}
   <form onSubmit={notion}><fieldset disabled={busy||!state.vaultReady}>
    <label>본인 연결 키 <input name="token" type="password" required autoComplete="off" maxLength={4096}/></label><br/>
    <label>회원 DB ID <input name="databaseId" required defaultValue={state.destination?.databaseId??''}/></label><br/>
    <label>Data source ID <input name="dataSourceId" required defaultValue={state.destination?.dataSourceId??''}/></label><br/>
    <label>템플릿 ID <input name="templateId" required defaultValue={state.destination?.templateId??''}/></label><br/>
    <p>본인 회원 전용 DB·템플릿만 연결하세요. 키는 다시 반환하지 않고 대상의 읽기 접근·소속·템플릿을 검증합니다.</p><button>읽기 검증 후 암호화 보관</button>
   </fieldset></form>
   <button disabled={busy||state.notionStatus==='not_connected'} onClick={()=>perform(async()=>{setState(await api('connections/notion/disconnect',{revision:state.revision}));})}>Notion 연결 해제</button>
   <h2>읽기 전용 미리보기</h2>
   {!state.previewProviderReady&&<p>다중 tenant 실행기가 비활성 또는 준비되지 않았습니다. 실제 계정 검증은 아직 하지 않았습니다.</p>}
   <button disabled={busy||!state.previewProviderReady||state.companyStatus!=='verified'||state.notionStatus!=='verified'||!!run&&['queued','running'].includes(run.status)} onClick={()=>perform(async()=>setRun(await api('preview',{requestId:crypto.randomUUID()})))}>미리보기 실행</button>
   {run&&<section aria-live="polite">{['queued','running'].includes(run.status)&&<button disabled={busy} onClick={()=>perform(async()=>setRun(await api('runs/'+run.id+'/cancel',{})))}>미리보기 취소</button>}<p>작업: {run.id} / {run.status}</p>{run.reasonCode&&<p>보류/실패 사유: {run.reasonCode}</p>}{run.result&&<pre>{JSON.stringify(run.result,null,2)}</pre>}</section>}
  </>}
 </main>;
}
