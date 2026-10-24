import{readFileSync,lstatSync,openSync,fstatSync,closeSync,constants,realpathSync}from'node:fs';
let windowsDatabase:string|undefined;
export function validatePilotDatabase(value:string,host:string,port:string){
 try{const u=new URL(value);if(u.protocol!=='postgresql:'||u.hostname!==host||u.port!==port||u.pathname!=='/trainer_sync_pilot'||u.username!=='trainer_pilot'||!u.password||u.search||u.hash||/[\r\n\0]/.test(value))throw Error();return value;}catch{throw Error('PILOT_DATABASE_SCOPE_INVALID');}
}
/** Trusted Windows runner/bootstrap only; no HTTP route calls this function. */
export function installWindowsPilotDatabase(value:string,port:number){if(process.platform!=='win32'||!Number.isInteger(port)||port<1024||port>65535)throw Error('PILOT_DATABASE_SCOPE_INVALID');windowsDatabase=validatePilotDatabase(value,'127.0.0.1',String(port));}
export function readPrivateRuntimeFile(path:string,maxBytes=4096):string{
 try{if(process.platform!=='linux'||!path.startsWith('/run/team-secrets/')||realpathSync(path)!==path)throw Error();const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.uid!==process.getuid?.()||(st.mode&0o777)!==0o400||st.size<1||st.size>maxBytes)throw Error();const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const f=fstatSync(fd);if(f.ino!==st.ino||f.dev!==st.dev||f.mode!==st.mode||f.uid!==st.uid||f.size!==st.size||f.nlink!==1)throw Error();return readFileSync(fd,'utf8');}finally{closeSync(fd);}}catch{throw Error('PILOT_DATABASE_UNCONFIGURED');}
}
export function databaseConnectionString(env:NodeJS.ProcessEnv=process.env){
 if(env.TEAM_PILOT_ENABLED==='true'){
  if(windowsDatabase)return windowsDatabase;
  if(env.DATABASE_URL||env.DATABASE_URL_FILE!=='/run/team-secrets/database-url')throw Error('PILOT_DATABASE_UNCONFIGURED');
  return validatePilotDatabase(readPrivateRuntimeFile(env.DATABASE_URL_FILE),'trainer-sync-pilot-db','5432');
 }
 if(env.DATABASE_URL_FILE){if(env.DATABASE_URL)throw Error('PILOT_DATABASE_UNCONFIGURED');return readPrivateRuntimeFile(env.DATABASE_URL_FILE);}
 if(!env.DATABASE_URL)throw Error('DATABASE_UNCONFIGURED');return env.DATABASE_URL;
}

export function pilotDatabaseUrl(password:Buffer,host:'trainer-sync-pilot-db'|'127.0.0.1',port:number){if(password.length<16||password.length>128||/[\r\n\0]/.test(password.toString('utf8'))||!Number.isInteger(port)||port<1024||port>65535)throw Error('PILOT_DATABASE_SCOPE_INVALID');return'postgresql://trainer_pilot:'+encodeURIComponent(password.toString('utf8'))+'@'+host+':'+port+'/trainer_sync_pilot';}
