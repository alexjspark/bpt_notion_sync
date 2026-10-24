import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {query} from '@trainer/db';
import {actorTransaction} from './team-connections.ts';
import {hashTeamPassword,type TeamActor} from './team-auth.ts';
import {transaction} from '@trainer/db';
import {TeamError,requireUuid} from './team-errors.ts';
let accepts=0;
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
export function inviteRecipient(email:unknown):string {
 if(typeof email!=='string'||email.length>254||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new TeamError('INVALID_INPUT',400);
 return hash(email.trim().toLowerCase());
}
export class TeamInvites {
 async canIssue(actor:TeamActor){return actorTransaction(actor,async c=>(await c.query("SELECT 1 FROM team_users WHERE id=$1 AND tenant_id=$2 AND role='operator'",[actor.userId,actor.tenantId])).rowCount===1);}
 async issue(actor:TeamActor,input:{email:unknown;login:unknown;label:unknown}) {
  const emailHash=inviteRecipient(input.email),login=String(input.login??'').toLowerCase(),label=String(input.label??'');
  if(!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(login)||!label.trim()||label.length>80)throw new TeamError('INVALID_INPUT',400);
  const token=randomBytes(32).toString('base64url'),id=randomUUID();
  return actorTransaction(actor,async c=>{
   const allowed=await c.query("SELECT 1 FROM team_users WHERE id=$1 AND tenant_id=$2 AND role='operator'",[actor.userId,actor.tenantId]);
   if(!allowed.rowCount)throw new TeamError('FORBIDDEN',403);
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['team-invite-issuer:'+actor.userId]);
   if((await c.query("SELECT 1 FROM team_invites WHERE issued_by=$1 AND login<>$2 AND revoked_at IS NULL AND (consumed_at IS NOT NULL OR expires_at>now())",[actor.userId,login])).rowCount)throw new TeamError('CONFLICT');
   // One pilot colleague only. Issuance invalidates previous unconsumed invitations for this login; no real account is created yet.
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['team-invite:'+login]);
   if((await c.query('SELECT 1 FROM team_users WHERE login=$1',[login])).rowCount)throw new TeamError('CONFLICT');
   await c.query('UPDATE team_invites SET revoked_at=now() WHERE login=$1 AND consumed_at IS NULL AND revoked_at IS NULL',[login]);
   const r=await c.query("INSERT INTO team_invites(id,token_hash,email_hash,login,label,issued_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '24 hours') RETURNING expires_at",[id,hash(token),emailHash,login,label,actor.userId]);
   return{id,token,login,expiresAt:new Date(r.rows[0].expires_at).toISOString()};
  });
 }
 async revoke(actor:TeamActor,id:string){
  requireUuid(id);await actorTransaction(actor,async c=>{
   if(!(await c.query("SELECT 1 FROM team_users WHERE id=$1 AND tenant_id=$2 AND role='operator'",[actor.userId,actor.tenantId])).rowCount)throw new TeamError('FORBIDDEN',403);
   await c.query('UPDATE team_invites SET revoked_at=now() WHERE id=$1 AND issued_by=$2 AND consumed_at IS NULL',[id,actor.userId]);
  });return{revoked:true};
 }
 async accept(input:{token:unknown;email:unknown;password:unknown}){
  if(typeof input.token!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(input.token)||typeof input.password!=='string')throw new TeamError('INVITE_INVALID',400);
  const emailHash=inviteRecipient(input.email),tokenHash=hash(input.token);
  // Cheap bearer check precedes scrypt. At most two expensive accept operations per process.
  if(!(await query("SELECT 1 FROM team_invites WHERE token_hash=$1 AND email_hash=$2 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now()",[tokenHash,emailHash])).rowCount)throw new TeamError('INVITE_INVALID',400);
  if(accepts>=2)throw new TeamError('LOGIN_THROTTLED',429);accepts++;
  try{const passwordHash=await hashTeamPassword(input.password);
  return transaction(async c=>{
   const r=(await c.query("SELECT i.* FROM team_invites i JOIN team_users u ON u.id=i.issued_by JOIN team_tenants t ON t.id=u.tenant_id WHERE i.token_hash=$1 AND i.email_hash=$2 AND i.consumed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>clock_timestamp() AND u.active AND t.active AND u.role='operator' FOR UPDATE OF i FOR SHARE OF u,t",[tokenHash,emailHash])).rows[0];
   if(!r)throw new TeamError('INVITE_INVALID',400);
   const tenantId=randomUUID(),userId=randomUUID();
   await c.query('INSERT INTO team_tenants(id,label) VALUES($1,$2)',[tenantId,r.label]);
   await c.query('INSERT INTO team_users(id,tenant_id,login,password_hash) VALUES($1,$2,$3,$4)',[userId,tenantId,r.login,passwordHash]);
   await c.query('UPDATE team_invites SET consumed_at=now() WHERE id=$1',[r.id]);
   return{accepted:true,login:r.login};
  });}finally{accepts--;}
 }
}
