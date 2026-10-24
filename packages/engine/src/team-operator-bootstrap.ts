import{timingSafeEqual}from'node:crypto';
const same=(a:string,b:string)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
/** A temporary loopback-only safe-input handler; no registration route is mounted in the app. */
export function createOperatorBootstrap(input:{origin:string;csrf:string;provision:(v:{login:string;password:string;label:string})=>Promise<unknown>}){
 const url=new URL(input.origin);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/'||url.search||url.hash||url.username||url.password||! /^[A-Za-z0-9_-]{43}$/.test(input.csrf))throw Error('BOOTSTRAP_SCOPE_INVALID');
 let consumed=false;
 const response=(content:string,status=200,html=false)=>new Response(content,{status,headers:{'Content-Type':html?'text/html; charset=utf-8':'text/plain','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",'X-Content-Type-Options':'nosniff'}});
 return async(req:Request)=>{
  const target=new URL(req.url);if(target.origin!==url.origin||target.pathname!=='/'||target.search||consumed)return response('BOOTSTRAP_UNAVAILABLE',409);
  if(req.method==='GET'){
   const r=response('<!doctype html><html lang="en"><title>TrainerSync local operator setup</title><h1>Initial operator only</h1><p>Creates a separate pilot service account. Company and Notion are not connected.</p><form method="post"><input type="hidden" name="csrf" value="'+input.csrf+'"><label>Service login <input name="login" required pattern="[a-z0-9][a-z0-9._-]{2,63}" autocomplete="username"></label><label>Choose password <input name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required></label><label>Label <input name="label" required maxlength="80"></label><button>Create one operator</button></form></html>',200,true);
   r.headers.set('Set-Cookie','trainersync_bootstrap='+input.csrf+'; Path=/; HttpOnly; SameSite=Strict');return r;
  }
  if(req.method!=='POST'||req.headers.get('origin')!==url.origin||!req.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))return response('BOOTSTRAP_FORBIDDEN',403);
  const cookies=(req.headers.get('cookie')??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith('trainersync_bootstrap='));if(cookies.length!==1||!same(cookies[0]!.slice('trainersync_bootstrap='.length),input.csrf))return response('BOOTSTRAP_FORBIDDEN',403);
  if(Number(req.headers.get('content-length')??0)>4096)return response('BOOTSTRAP_INVALID',413);
  const reader=req.body?.getReader();if(!reader)return response('BOOTSTRAP_INVALID',400);let size=0;const chunks:Uint8Array[]=[];for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>4096){await reader.cancel();return response('BOOTSTRAP_INVALID',413);}chunks.push(r.value);}
  const body=new URLSearchParams(Buffer.concat(chunks).toString('utf8'));if([...body.keys()].some(k=>!['csrf','login','password','label'].includes(k))||['csrf','login','password','label'].some(k=>body.getAll(k).length!==1)||!same(body.get('csrf')??'',input.csrf))return response('BOOTSTRAP_FORBIDDEN',403);
  consumed=true;try{await input.provision({login:body.get('login')!,password:body.get('password')!,label:body.get('label')!});return response('Operator account created. Close this window and sign in to the pilot service.');}catch{return response('BOOTSTRAP_REVIEW_REQUIRED. Do not retry before checking the account state.',409);}
 };
}
