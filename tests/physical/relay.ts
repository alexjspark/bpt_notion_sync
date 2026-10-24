import type{Duplex,Readable,Writable}from'node:stream';import type{EventEmitter}from'node:events';
export type RelayChild=EventEmitter&{stdin:Writable;stdout:Readable;kill():unknown};
/** Preserve buffered stdout after child exit. Only stream errors/cancellation destroy output. */
export function wirePhysicalRelay(socket:Duplex,child:RelayChild,events:{socketClosed():void;childClosed():void;failed():void}){
 let failed=false;const abort=()=>{if(failed)return;failed=true;socket.destroy();child.stdin.destroy();child.stdout.destroy();child.kill();events.failed();};
 socket.pipe(child.stdin);child.stdout.pipe(socket);
 socket.on('error',abort);child.stdin.on('error',abort);child.stdout.on('error',abort);child.on('error',abort);
 socket.on('close',()=>{child.stdin.end();child.stdout.resume();events.socketClosed();});
 child.on('close',code=>{if(code!==0)abort();events.childClosed();});
 return abort;
}
export function physicalInnerRelay(host:string,port:number){
 if(!['127.0.0.1','trainer-sync-team-test-db'].includes(host)||![4316,5432].includes(port)||host==='127.0.0.1'&&port!==4316||host==='trainer-sync-team-test-db'&&port!==5432)throw Error('PHYSICAL_RELAY_TARGET_REJECTED');
 return "const net=require('node:net'),s=net.connect({host:"+JSON.stringify(host)+",port:"+port+",allowHalfOpen:true});let ended=false;const deadline=setTimeout(()=>abort(),900000);function abort(){if(ended)return;ended=true;s.destroy();process.stdin.destroy();process.exitCode=1;clearTimeout(deadline);process.stdout.end()}function finish(){if(ended)return;ended=true;clearTimeout(deadline);s.end();process.stdout.end(()=>{process.stdin.destroy();process.exitCode=0})}s.setTimeout(300000,abort);s.on('connect',()=>{process.stdin.pipe(s);s.pipe(process.stdout,{end:false})});s.on('end',finish);s.on('close',()=>{if(!ended)finish()});s.on('error',abort);process.stdin.on('error',abort);process.stdout.on('error',()=>{ended=true;s.destroy();process.stdin.destroy();clearTimeout(deadline);process.exitCode=1})";
}
