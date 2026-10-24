import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { query, transaction } from '@trainer/db';
import { TeamError, uuid } from './team-errors.ts';
export interface TeamActor { readonly userId:string; readonly tenantId:string; readonly authVersion:number }
const actors = new WeakSet<object>();
export function assertActor(actor:TeamActor):void { if(!actors.has(actor)) throw new TeamError('AUTH_REQUIRED',401); }
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const derive=(password:string,salt:Buffer)=>new Promise<Buffer>((resolve,reject)=>scrypt(password,salt,32,{N:16384,r:8,p:1,maxmem:33554432},(e,key)=>e?reject(e):resolve(key)));
export async function hashTeamPassword(password:string):Promise<string> {
 if(typeof password!=='string'||password.length<12||password.length>128) throw new TeamError('INVALID_INPUT',400);
 const salt=randomBytes(16),key=await derive(password,salt);return ['scrypt-v1',salt.toString('hex'),key.toString('hex')].join('$');
}
export async function verifyTeamPassword(password:string,stored:string):Promise<boolean>{
 const parts=stored.split('$'),valid=parts.length===3&&parts[0]==='scrypt-v1'&&/^[a-f0-9]{32}$/.test(parts[1])&&/^[a-f0-9]{64}$/.test(parts[2]);
 const key=await derive(typeof password==='string'&&password.length<=128?password:'invalid',Buffer.from(valid?parts[1]:'0'.repeat(32),'hex'));
 return valid&&timingSafeEqual(key,Buffer.from(parts[2],'hex'));
}
/** Administrative library boundary only. No public registration or automatic real-user provisioning. */
export async function provisionTeamUser(input:{login:string;password:string;label:string}):Promise<{userId:string;tenantId:string}>{
 if(!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(input.login)||!input.label||input.label.length>80)throw new TeamError('INVALID_INPUT',400);
 const passwordHash=await hashTeamPassword(input.password),tenantId=randomUUID(),userId=randomUUID();
 await transaction(async c=>{await c.query('INSERT INTO team_tenants(id,label) VALUES($1,$2)',[tenantId,input.label]);await c.query('INSERT INTO team_users(id,tenant_id,login,password_hash) VALUES($1,$2,$3,$4)',[userId,tenantId,input.login,passwordHash]);});
 return{userId,tenantId};
}
export class TeamAuth {
 async login(login:unknown,password:unknown):Promise<{token:string;expiresAt:string}>{
  if(typeof login!=='string'||typeof password!=='string'||login.length>64||password.length>128)throw new TeamError('LOGIN_FAILED',401);
  const normalized=login.toLowerCase(),key=digest(normalized);
  return transaction(async c=>{
   await c.query('INSERT INTO team_login_attempts(login_hash) VALUES($1) ON CONFLICT DO NOTHING',[key]);
   const attempt=(await c.query('SELECT * FROM team_login_attempts WHERE login_hash=$1 FOR UPDATE',[key])).rows[0];
   if(attempt.blocked_until&&new Date(attempt.blocked_until).getTime()>Date.now())throw new TeamError('LOGIN_THROTTLED',429);
   const row=(await c.query('SELECT u.*,t.active AS tenant_active FROM team_users u JOIN team_tenants t ON t.id=u.tenant_id WHERE login=$1',[normalized])).rows[0];
   const matches=await verifyTeamPassword(password,row?.password_hash??'invalid');
   if(!row||!row.active||!row.tenant_active||!matches){
    const failures=new Date(attempt.window_at).getTime()<Date.now()-900000?1:attempt.failures+1;
    await c.query("UPDATE team_login_attempts SET failures=$2,window_at=CASE WHEN window_at<now()-interval '15 minutes' THEN now() ELSE window_at END,blocked_until=CASE WHEN $2>=5 THEN now()+interval '15 minutes' ELSE NULL END WHERE login_hash=$1",[key,failures]);
    return{token:'',expiresAt:''};
   }
   await c.query('DELETE FROM team_login_attempts WHERE login_hash=$1',[key]);
   const token=randomBytes(32).toString('base64url'),expiresAt=new Date(Date.now()+8*3600000).toISOString();
   await c.query('INSERT INTO team_sessions(token_hash,user_id,tenant_id,auth_version,expires_at) VALUES($1,$2,$3,$4,$5)',[digest(token),row.id,row.tenant_id,row.auth_version,expiresAt]);
   return{token,expiresAt};
  }).then(result=>{if(!result.token)throw new TeamError('LOGIN_FAILED',401);return result;});
 }
 async resolve(token:string|undefined):Promise<TeamActor>{
  if(!token||!/^[A-Za-z0-9_-]{43}$/.test(token))throw new TeamError('AUTH_REQUIRED',401);
  const r=await query("SELECT u.id,u.tenant_id,u.auth_version FROM team_sessions s JOIN team_users u ON(u.id=s.user_id AND u.tenant_id=s.tenant_id) JOIN team_tenants t ON t.id=u.tenant_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND s.auth_version=u.auth_version AND u.active AND t.active",[digest(token)]);
  if(!r.rows[0]||!uuid(r.rows[0].tenant_id))throw new TeamError('AUTH_REQUIRED',401);
  const actor=Object.freeze({userId:r.rows[0].id,tenantId:r.rows[0].tenant_id,authVersion:r.rows[0].auth_version});actors.add(actor);return actor;
 }
 async logout(token:string|undefined):Promise<void>{if(token&&/^[A-Za-z0-9_-]{43}$/.test(token))await query('UPDATE team_sessions SET revoked_at=now() WHERE token_hash=$1',[digest(token)]);}
}
