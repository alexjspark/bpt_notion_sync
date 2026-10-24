/** Defense for legacy APIs: phase2 never falls back to the original single-user tenant. */
export function phase2Boundary(path:string,enabled:boolean):'allow'|'block'|'redirect'{
 if(!enabled)return path==='/team'||path.startsWith('/api/team')?'block':'allow';
 if(path.startsWith('/api/')&&path!=='/api/health'&&!(path==='/api/team'||path.startsWith('/api/team/')))return'block';
 if(path==='/'||!path.startsWith('/team')&&!path.startsWith('/api/')&&!path.startsWith('/_next/')&&path!=='/favicon.ico')return'redirect';
 return'allow';
}
