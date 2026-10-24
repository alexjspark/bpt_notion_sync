export const TEAM_COOKIE='trainer_team_session';
export function readTeamCookie(raw:string|undefined|null):string|undefined{
 if(typeof raw!=='string'||raw.length>8192)return undefined;
 const matches=raw.split(';').map(v=>v.trim()).filter(v=>v.startsWith(TEAM_COOKIE+'='));
 if(matches.length!==1)return undefined;const token=matches[0]!.slice(TEAM_COOKIE.length+1);
 return /^[A-Za-z0-9_-]{43}$/.test(token)?token:undefined;
}
