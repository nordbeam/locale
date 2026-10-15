import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Minimal real TypeScript LSP client for navigation/completion checks. */
export async function startLsp(root, options = {}) {
  const child = spawn(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--lsp', '--stdio', ...(options.args ?? [])], {cwd:root,stdio:['pipe','pipe','pipe']});
  const exited = new Promise(resolve => child.once('exit', resolve));
  const pending = new Map();
  let sequence=0, buffer=Buffer.alloc(0), errors='';
  child.stderr.on('data', data => {errors+=data;});
  const send = message => {const body=JSON.stringify({jsonrpc:'2.0',...message});child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);};
  const request = (method, params) => new Promise((resolve,reject) => {
    const id=++sequence;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method} timed out: ${errors}`));},15000);
    pending.set(id,{resolve,reject,timer});send({id,method,params});
  });
  const notify = (method,params) => send({method,params});
  child.stdout.on('data', data => {
    buffer=Buffer.concat([buffer,data]);
    for (;;) {
      const end=buffer.indexOf('\r\n\r\n');if(end<0)return;
      const size=Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0,end).toString())?.[1]);
      if(buffer.length<end+4+size)return;
      const message=JSON.parse(buffer.subarray(end+4,end+4+size));buffer=buffer.subarray(end+4+size);
      if(message.method && message.id !== undefined) {
        send({id:message.id,result:message.method==='workspace/configuration'?message.params.items.map(()=>({})):null});
      } else if(message.id !== undefined) {
        const waiter=pending.get(message.id);if(!waiter)continue;
        clearTimeout(waiter.timer);pending.delete(message.id);
        if(message.error)waiter.reject(new Error(JSON.stringify(message.error)));else waiter.resolve(message.result);
      }
    }
  });
  const fail = error => {for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(error);}pending.clear();};
  child.on('error',fail);
  child.on('exit',code=>fail(new Error(`LSP exited ${code}: ${errors}`)));
  try {
    const initialized=await request('initialize',{processId:process.pid,clientInfo:{name:'nordbeam-i18n-check'},rootUri:pathToFileURL(root).href,
      capabilities:{workspace:{didChangeWatchedFiles:{dynamicRegistration:true}}},workspaceFolders:[{uri:pathToFileURL(root).href,name:'fixture'}]});
    notify('initialized',{});
    return {request,notify,server:initialized.serverInfo,close:async()=>{
      // Give the native server time to flush profiles and clean up after exit.
      // Killing immediately after the notification can leave an empty profile.
      const timer=setTimeout(()=>child.kill(),3000);
      try {await request('shutdown');notify('exit');await exited;}
      finally {clearTimeout(timer);if(child.exitCode===null)child.kill();}
    }};
  } catch(error) {child.kill();throw error;}
}
