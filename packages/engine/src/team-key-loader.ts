import {lstatSync,openSync,fstatSync,readFileSync,closeSync,constants,realpathSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {TeamError} from './team-errors.ts';
export type TeamKeyName='TEAM_VAULT_MASTER_KEY'|'TEAM_PREVIEW_HMAC_KEY';
export function decodeTeamKey(value:string):Buffer {
 if(!/^[a-fA-F0-9]{64}$/.test(value))throw new TeamError('SECRET_INVALID');
 return Buffer.from(value,'hex');
}
/** File mode is fail-closed. Never silently fall back to an old personal key or env value. */
export function loadTeamKey(name:TeamKeyName,env:NodeJS.ProcessEnv=process.env):Buffer|undefined {
 const file=env[name+'_FILE'],inline=env[name];
 if(file&&inline)throw new TeamError('SECRET_INVALID');
 if(!file)return inline?decodeTeamKey(inline):undefined; // synthetic/dev compatibility; pilot gate below forbids it
 try {
  if(process.platform!=='linux'||!isAbsolute(file)||!file.startsWith('/run/team-secrets/'))throw Error();
  const st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size!==64||(st.mode&0o777)!==0o400||st.uid!==process.getuid?.()||realpathSync(file)!==file)throw Error();
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const opened=fstatSync(fd);if(opened.ino!==st.ino||opened.dev!==st.dev||opened.uid!==st.uid||opened.mode!==st.mode||opened.nlink!==1||opened.size!==64)throw Error();return decodeTeamKey(readFileSync(fd,'utf8'));}finally{closeSync(fd);}
 }catch{throw new TeamError('VAULT_UNCONFIGURED');}
}
export function teamKeyPair(env:NodeJS.ProcessEnv=process.env){
 if(env.TEAM_PILOT_ENABLED==='true'&&(!env.TEAM_VAULT_MASTER_KEY_FILE||!env.TEAM_PREVIEW_HMAC_KEY_FILE))throw new TeamError('VAULT_UNCONFIGURED');
 const master=loadTeamKey('TEAM_VAULT_MASTER_KEY',env),preview=loadTeamKey('TEAM_PREVIEW_HMAC_KEY',env);
 if(master&&preview&&master.equals(preview))throw new TeamError('SECRET_INVALID');
 return{master,preview};
}
/** Safe diagnostic only; not an authenticator. It is not written automatically. */
export const teamKeyFingerprint=(key:Buffer)=>createHash('sha256').update(key).digest('hex').slice(0,16);
