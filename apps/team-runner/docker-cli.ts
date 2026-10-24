import{execFile}from'node:child_process';
import type{DockerCommand}from'../../packages/engine/src/team-browser-driver.ts';
import{TeamError}from'../../packages/engine/src/team-errors.ts';
/** Runner process only. Never import this module into the web app. No shell interpolation or raw error logging. */
export function approvedDockerCli(enabled:boolean):DockerCommand{
 if(!enabled)throw new TeamError('RUNNER_UNAVAILABLE');
 return args=>new Promise(resolve=>execFile('docker',[...args],{timeout:8000,maxBuffer:128*1024,windowsHide:true},(error,stdout)=>resolve({exitCode:error?1:0,stdout:error?'':stdout})));
}
