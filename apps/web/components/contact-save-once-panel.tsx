'use client';
import{useCallback,useEffect,useState}from'react';
type Target={uid:string;pageId:string;name:string;pageUrl?:string;fields:string[];status?:string;savedFields?:string[];heldFields?:string[];uncertainResponse?:boolean};
type Run={status:string;targets:Target[];authorizationConsumed:boolean;report:{targets?:Target[];savedFieldCount?:number;heldFieldCount?:number;completed?:boolean}};
type Snapshot={mode:string;canQueue:boolean;run:Run|null};
export function ContactSaveOncePanel(){
 const[s,setS]=useState<Snapshot|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(false);
 const refresh=useCallback(async()=>{try{const r=await fetch('/api/contact-save-once',{cache:'no-store'});if(!r.ok)throw Error();const v=await r.json();if(v.mode!=='one_time_editing_paused')throw Error();setS(v);setError(false);}catch{setError(true);}},[]);
 useEffect(()=>{void refresh();},[refresh]);const active=s?.run&&['queued','running'].includes(s.run.status);
 useEffect(()=>{if(!active)return;const t=setInterval(()=>void refresh(),2000);return()=>clearInterval(t);},[active,refresh]);
 async function start(){if(busy||active||!s?.canQueue)return;setBusy(true);try{const r=await fetch('/api/contact-save-once',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save_approved_contacts_once'})});if(!r.ok)throw Error();await refresh();}catch{setError(true);}finally{setBusy(false);}}
 if(!s?.run)return null;const run=s.run,results=run.report.targets??run.targets;
 return <section className="section card" id="contact-save-once" aria-labelledby="contact-save-once-title">
 <h2 id="contact-save-once-title">{'\uc2b9\uc778\ub41c 2\uba85 \uc5f0\ub77d\ucc98 \uc77c\ud68c \uc800\uc7a5'}</h2>
 <p>{'\uc774\ubc88 \uc2e4\ud589 \ub3d9\uc548 \ub450 \ud68c\uc6d0\uc758 \uc804\ud654\u00b7\uc774\uba54\uc77c \ud3b8\uc9d1\uc744 \uc7a0\uc2dc \uba48\ucd98\ub2e4\ub294 \uc870\uac74\uc73c\ub85c, \uc5ec\uc804\ud788 \ube44\uc5b4 \uc788\ub294 \uce78\ub9cc \ucc44\uc6c1\ub2c8\ub2e4. \uc6d0\uc790\uc801 \ub3d9\uc2dc \uc4f0\uae30 \ubcf4\uc7a5\uc740 \uc544\ub2d9\ub2c8\ub2e4.'}</p>
 <p>{'\uc77c\ubc18 \uc790\ub3d9 \ubcf4\uc644 \ubcf4\ub958 \u00b7 \uc608\uc57d \uc2e4\ud589 OFF \u00b7 \ubcf8\ubb38\u00b7\uc0c1\ud0dc\u00b7\ub0a0\uc9dc\u00b7\uc77c\uc815 \ubcc0\uacbd \uc5c6\uc74c'}</p>
 <button type="button" className="button primary" disabled={busy||!!active||!s.canQueue} onClick={()=>void start()}>{active?'\uc800\uc7a5 \uc2e4\ud589 \uc911':run.authorizationConsumed?'\uc77c\ud68c \uc2e4\ud589 \uad8c\ud55c \uc0ac\uc6a9 \uc885\ub8cc':'\uc2b9\uc778\ub41c 2\uba85 \uc5f0\ub77d\ucc98 \ud55c \ubc88 \uc800\uc7a5'}</button>
 <p role="status">{run.status==='succeeded'?'\uc800\uc7a5 \uc644\ub8cc \u00b7 Notion \uc7ac\uc870\ud68c \uc77c\uce58 \ud655\uc778':run.status==='partial'?'\ubd80\ubd84 \uacb0\uacfc \u00b7 \ubcf4\ub958 \ud56d\ubaa9 \ud655\uc778':run.status==='needs_review'?'\uc7ac\uc870\ud68c \uacb0\uacfc \ud655\uc778 \ud544\uc694 \u00b7 \uc790\ub3d9 \uc7ac\uc2dc\ub3c4 \uc5c6\uc74c':active?'\uc77c\ud68c \uc800\uc7a5 \ucc98\ub9ac \uc911':'\uc2e4\ud589 \uc900\ube44 \uc644\ub8cc'}</p>
 <ul>{results.map(t=><li key={t.uid}><a href={'https://app.notion.com/p/'+t.pageId.replaceAll('-','')} target="_blank" rel="noreferrer">{t.name}</a>{' \u00b7 \uc804\ud654\ubc88\ud638 / \uc774\uba54\uc77c'}{t.savedFields?.length?': '+t.savedFields.map(f=>f==='phone'?'\uc804\ud654\ubc88\ud638':'\uc774\uba54\uc77c').join(', ')+' \uc800\uc7a5\u00b7\uc7ac\uc870\ud68c \ud655\uc778':''}{t.heldFields?.length?' \u00b7 '+t.heldFields.length+' \uce78 \ubcf4\ub958':''}{t.uncertainResponse?' \u00b7 \uc751\ub2f5 \ubd88\ud655\uc2e4 \ud6c4 \ud604\uc7ac\uac12 \uc77c\uce58 \uc5ec\ubd80 \ud655\uc778':''}</li>)}</ul>
 {run.report.completed&&<p>{'\uc800\uc7a5 \ud655\uc778: '}{run.report.savedFieldCount??0}{'\uce78 \u00b7 \ubcf4\ub958: '}{run.report.heldFieldCount??0}{'\uce78 \u00b7 \uc774 \uc2e4\ud589\uc740 \uc7ac\uc0ac\uc6a9\ub418\uc9c0 \uc54a\uc2b5\ub2c8\ub2e4.'}</p>}
 {error&&<p role="alert">{'\uc0c1\ud0dc \ud655\uc778 \ud544\uc694. \uacb0\uacfc\ub97c \ud655\uc778\ud558\uae30 \uc804 \ubc18\ubcf5 \ud074\ub9ad\ud558\uc9c0 \ub9c8\uc138\uc694.'}</p>}
 </section>;
}
