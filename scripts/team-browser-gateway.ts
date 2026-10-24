import{approvedRuntime,listenService}from'../apps/team-runner/entrypoints.ts';
import{createTeamBrowserGateway,productionGatewayAuthorizer}from'../packages/engine/src/team-browser-gateway.ts';import{TeamError}from'../packages/engine/src/team-errors.ts';
try{approvedRuntime();const origin=process.env.TEAM_PUBLIC_ORIGIN;if(!origin)throw new TeamError('NOT_READY');
await listenService('gateway',createTeamBrowserGateway({origin,authorize:productionGatewayAuthorizer()}),4315);

}catch{console.error(JSON.stringify({code:'TEAM_RUNTIME_STOPPED'}));process.exitCode=1;}
