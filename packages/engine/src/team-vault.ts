import { createCipheriv,createDecipheriv,randomBytes } from 'node:crypto';
import { TeamError,requireUuid } from './team-errors.ts';
export interface SecretScope{tenantId:string;connectionId:string;revision:number;purpose:'notion'|'pilot'}
export interface SecretEnvelope{version:1;keyId:string;nonce:string;tag:string;ciphertext:string}
export class TeamVault {
 private readonly key?:Buffer;
 constructor(key?:Buffer,private readonly keyId='operator-v1'){
  if(key!==undefined&&key.length!==32)throw new TeamError('SECRET_INVALID',400);
  this.key=key?Buffer.from(key):undefined;
 }
 get ready(){return !!this.key;}
 private aad(scope:SecretScope):Buffer{
  if(!['notion','pilot'].includes(scope.purpose)||!Number.isSafeInteger(scope.revision)||scope.revision<1)throw new TeamError('SECRET_INVALID',400);
  return Buffer.from(JSON.stringify([1,this.keyId,requireUuid(scope.tenantId),requireUuid(scope.connectionId),scope.revision,scope.purpose]));
 }
 seal(scope:SecretScope,token:string):SecretEnvelope{
  if(!this.key)throw new TeamError('VAULT_UNCONFIGURED');
  if(typeof token!=='string'||token.length<8||token.length>(scope.purpose==='pilot'?60000:4096)||/[\r\n\0]/.test(token))throw new TeamError('SECRET_INVALID',400);
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,nonce);cipher.setAAD(this.aad(scope));
  const encrypted=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);
  return{version:1,keyId:this.keyId,nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:encrypted.toString('base64')};
 }
 open(scope:SecretScope,e:SecretEnvelope):string{
  if(!this.key)throw new TeamError('VAULT_UNCONFIGURED');
  try{
   if(e.version!==1||e.keyId!==this.keyId||Buffer.from(e.nonce,'base64').length!==12||Buffer.from(e.tag,'base64').length!==16||e.ciphertext.length>(scope.purpose==='pilot'?90000:6000))throw Error();
   const cipher=createDecipheriv('aes-256-gcm',this.key,Buffer.from(e.nonce,'base64'));cipher.setAAD(this.aad(scope));cipher.setAuthTag(Buffer.from(e.tag,'base64'));
   return Buffer.concat([cipher.update(Buffer.from(e.ciphertext,'base64')),cipher.final()]).toString('utf8');
  }catch{throw new TeamError('SECRET_INVALID');}
 }
}
