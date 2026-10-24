import{TeamError}from'./team-errors.ts';
export async function waitForPilotKeys(load:()=>{master?:Buffer;preview?:Buffer},pause:(ms:number)=>Promise<void>,attempts=120){
 for(let n=0;n<attempts;n++){try{const keys=load();if(keys.master&&keys.preview)return;}catch(e){if(!(e instanceof TeamError)||!['VAULT_UNCONFIGURED'].includes(e.code))throw e;}if(n+1<attempts)await pause(1000);}
 throw new TeamError('VAULT_UNCONFIGURED');
}
