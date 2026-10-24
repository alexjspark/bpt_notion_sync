import{approvedRuntime,listenService}from'../apps/team-runner/entrypoints.ts';import{createCompanyEgress}from'../packages/engine/src/team-company-egress.ts';
try{approvedRuntime();await listenService('egress',createCompanyEgress(),3128);

}catch{console.error(JSON.stringify({code:'TEAM_RUNTIME_STOPPED'}));process.exitCode=1;}
