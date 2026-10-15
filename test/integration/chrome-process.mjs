import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';

// This owns only its child process and newly created profile. It never connects
// to a resident browser, reads a user profile, or changes the MCP configuration.
export async function launchChrome() {
  const executable = process.env.CHROME_BINARY ?? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].find(existsSync);
  if (!executable) throw new Error('No local Chrome/Chromium executable found. Set CHROME_BINARY to an installed browser.');
  const profile = await mkdtemp(join(tmpdir(), 'nordbeam-locale-chrome-'));
  const flags = ['--headless', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--window-size=1280,900', '--lang=en-US', 'about:blank'];
  const child = spawn(executable, flags, {stdio:['ignore','ignore','pipe']});
  const exited = new Promise(resolve => {child.once('exit', resolve); child.once('error', resolve);});
  let socket, sequence = 0;
  const pending = new Map(), listeners = new Set();
  async function close() {
    socket?.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      let timer;
      await Promise.race([exited, new Promise(resolve => {timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},3000);})]);
      clearTimeout(timer);
      await exited;
    }
    await rm(profile, {recursive:true, force:true, maxRetries:3, retryDelay:100});
  }
  try {
    const endpoint = await new Promise((resolve,reject) => {
      let output = '';
      const timer = setTimeout(()=>reject(new Error('Chrome startup exceeded 15 seconds')),15000);
      const fail = error => {clearTimeout(timer);reject(error);};
      child.once('error',fail);
      child.once('exit',(code,signal)=>fail(new Error(`Chrome exited before ready: ${code}/${signal}`)));
      child.stderr.on('data',chunk=>{
        output=(output+chunk).slice(-32000);
        const match=output.match(/DevTools listening on (ws:\/\/\S+)/);
        if(match){clearTimeout(timer);resolve(match[1]);}
      });
    });
    socket = new WebSocket(endpoint);
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const callback = pending.get(message.id);
        if(callback){pending.delete(message.id);clearTimeout(callback.timer);
          message.error ? callback.reject(new Error(JSON.stringify(message.error))) : callback.resolve(message.result);}
      } else for(const listener of listeners) listener(message);
    });
    socket.addEventListener('close',()=>{
      for(const callback of pending.values()){clearTimeout(callback.timer);callback.reject(new Error('Chrome connection closed'));}
      pending.clear();
    });
    await Promise.race([once(socket,'open'),new Promise((_,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Chrome WebSocket connection exceeded 10 seconds')),10000);
      socket.addEventListener('open',()=>clearTimeout(timer),{once:true});
    })]);
    function send(method, params={}, sessionId) {
      const id=++sequence;
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method} exceeded 30 seconds`));},30000);
        pending.set(id,{resolve,reject,timer});
        socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
      });
    }
    const version=await send('Browser.getVersion');
    const {targetInfos}=await send('Target.getTargets');
    const target=targetInfos.find(target=>target.type==='page' && target.url==='about:blank');
    if(!target)throw new Error('Fresh Chrome did not create the requested page');
    const {sessionId}=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
    const page=(method,params)=>send(method,params,sessionId);
    const on=(method,callback)=>{const listener=event=>{if(event.sessionId===sessionId && event.method===method)callback(event.params);};listeners.add(listener);return ()=>listeners.delete(listener);};
    const event=method=>new Promise((resolve,reject)=>{
      const off=on(method,params=>{clearTimeout(timer);off();resolve(params);});
      const timer=setTimeout(()=>{off();reject(new Error(`${method} event exceeded 15 seconds`));},15000);
    });
    async function evaluate(expression) {
      try {
        const result=await page('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,objectGroup:'benchmark'});
        if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      } finally {await page('Runtime.releaseObjectGroup',{objectGroup:'benchmark'});}
    }
    async function heap() {
      await page('Runtime.discardConsoleEntries');
      await page('HeapProfiler.collectGarbage');
      return page('Runtime.getHeapUsage');
    }
    async function snapshot(file) {
      const chunks=[],off=on('HeapProfiler.addHeapSnapshotChunk',({chunk})=>chunks.push(chunk));
      try {await page('HeapProfiler.takeHeapSnapshot',{});} finally {off();}
      await writeFile(file,chunks.join(''));
    }
    await page('Page.enable');await page('Runtime.enable');await page('Network.enable');
    await page('Network.setCacheDisabled',{cacheDisabled:true});
    return {version,flags:flags.map(flag=>flag.startsWith('--user-data-dir=')?'--user-data-dir=<fresh temporary directory>':flag),
      page,event,on,evaluate,heap,snapshot,close};
  } catch(error) {await close();throw error;}
}
