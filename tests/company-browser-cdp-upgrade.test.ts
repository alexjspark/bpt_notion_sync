import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {connect} from 'node:net';
import type {Socket} from 'node:net';
import type {IncomingHttpHeaders} from 'node:http';
import {companyCdpUpgradeRequest} from '../scripts/company-browser-cdp-upgrade.mjs';

test('internal CDP handshake is parsed by an actual HTTP server with fixed Host and safe headers', async () => {
  const server=createServer();const sockets=new Set<Socket>();
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));
  try{
    const received=new Promise<{url:string|undefined;headers:IncomingHttpHeaders}>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('SYNTHETIC_UPGRADE_TIMEOUT')),1000);
      server.once('upgrade',(request,socket)=>{clearTimeout(timer);resolve({url:request.url,headers:request.headers});socket.end();});
    });
    const address=server.address();if(!address||typeof address==='string')throw new Error('SYNTHETIC_ADDRESS_INVALID');
    const socket=connect(address.port,'127.0.0.1');
    await new Promise<void>((resolve,reject)=>{socket.once('connect',()=>resolve());socket.once('error',reject);});
    socket.write(companyCdpUpgradeRequest('/devtools/browser/synthetic-123',{
      upgrade:'websocket',connection:'Upgrade','sec-websocket-key':'c3ludGhldGljLXZhbHVl','sec-websocket-version':'13',
      host:'other.invalid',cookie:'SYNTHETIC_COOKIE',authorization:'SYNTHETIC_AUTH',
    }));
    const result=await received;
    assert.equal(result.url,'/devtools/browser/synthetic-123');
    assert.equal(result.headers.host,'127.0.0.1:9223');
    assert.equal(result.headers.upgrade,'websocket');
    assert.equal(result.headers.cookie,undefined);
    assert.equal(result.headers.authorization,undefined);
    socket.destroy();
  }finally{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('internal upgrade rejects other targets and header injection',()=>{
  for(const path of ['/json/list','https://other.invalid/','/devtools/browser/id\r\nX: y'])
    assert.throws(()=>companyCdpUpgradeRequest(path,{}),/COMPANY_CDP_TARGET_INVALID/);
  assert.throws(()=>companyCdpUpgradeRequest('/devtools/browser/synthetic',{upgrade:'websocket\r\nX: y'}),/COMPANY_CDP_HEADER_INVALID/);
});
