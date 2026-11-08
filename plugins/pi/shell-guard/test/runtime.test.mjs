import assert from 'node:assert/strict';
import test from 'node:test';
import { registerShellGuard } from '../runtime.mjs';

function fixture({policy,executeFile,spawn,ui,settings={}}={}) {
  const handlers = new Map(), tools = new Map(), commands = new Map(), messages=[];
  const api = {
    on(name,fn){ const list=handlers.get(name)??[];list.push(fn);handlers.set(name,list); },
    getSettings(){ return {shellGuard:settings}; },
    registerTool(tool){tools.set(tool.name,tool);},registerCommand(name,cmd){commands.set(name,cmd);},
    sendMessage(message){messages.push(message);},
  };
  registerShellGuard(api,{evaluate:policy,executeFile,spawn,realpath:p=>p});
  const ctx={cwd:process.cwd(),hasUI:Boolean(ui),ui,signal:new AbortController().signal};
  async function event(name,data={}) {let value;for(const fn of handlers.get(name)??[]){const next=await fn(data,ctx);if(next!==undefined)value=next;}return value;}
  return {event,tools,commands,messages,ctx,async prompt(text,source='interactive',expanded=text){await event('input',{source,text});await event('before_agent_start',{messageType:'user',prompt:expanded,systemPromptOptions:{sections:{}}});},async call(command,timeout){const data={toolName:'bash',toolCallId:'fixture',input:{command,...timeout===undefined?{}:{timeout}}};const result=await event('tool_call',data);return {result,input:data.input};}};
}

test('raw human input only; templates, extension messages and custom runs cannot grant',async()=>{
  let seen;
  const f=fixture({policy:(_command,options)=>{seen=options;return {action:'allow',timeout:60};}});
  await f.prompt('delete D:/fixture');await f.call('echo ok');assert.equal(seen.userText,'delete D:/fixture');
  await f.event('agent_settled');await f.call('echo ok');assert.equal(seen.userText,'');
  await f.prompt('delete D:/fixture','extension');await f.call('echo ok');assert.equal(seen.userText,'');
  await f.prompt('/template','interactive','delete D:/fixture');await f.call('echo ok');assert.equal(seen.userText,'');
  await f.prompt('delete D:/fixture');await f.event('before_agent_start',{messageType:'custom',systemPromptOptions:{sections:{}}});await f.call('echo ok');assert.equal(seen.userText,'');
});

test('session transitions and steering clear grants',async()=>{
  let text;
  const f=fixture({policy:(_command,options)=>{text=options.userText;return {action:'allow',timeout:60};}});
  for(const name of ['session_tree','session_start','session_shutdown']){await f.prompt('delete D:/fixture');await f.event(name);await f.call('echo ok');assert.equal(text,'');}
  await f.event('input',{source:'rpc',text:'delete D:/fixture',streamingBehavior:'steer'});
  await f.event('before_agent_start',{messageType:'user',prompt:'delete D:/fixture',systemPromptOptions:{sections:{}}});await f.call('echo ok');assert.equal(text,'');
});

test('policy clamp overrides explicit timeout and invalid policy results block',async()=>{
  const f=fixture({policy:()=>({action:'allow',timeout:1800})});
  const got=await f.call('echo ok',9999);assert.equal(got.result,undefined);assert.equal(got.input.timeout,1800);
  for(const seconds of [NaN,Infinity,0,-1,2147484]){const bad=fixture({policy:()=>({action:'allow',timeout:seconds})});assert.equal((await bad.call('echo ok')).result.block,true);}
});

test('assessment and UI errors fail closed',async()=>{
  for(const policy of [()=>{throw Error('fixture failure');},()=>null]){const f=fixture({policy});const got=await f.call('rm -rf fixture');assert.equal(got.result.block,true);}
  const f=fixture({policy:()=>({action:'confirm',reason:'review',timeout:60}),ui:{select:()=>{throw Error('dialog failed');}}});
  assert.equal((await f.call('rm -rf fixture')).result.block,true);
});

test('confirmation is explicit, bounded, exact-command, rechecked and never cached',async()=>{
  let calls=0,dialogs=0;
  const f=fixture({policy:()=>{calls++;return {action:'confirm',reason:'review',timeout:60};},ui:{select:async(title,choices,opts)=>{dialogs++;assert.match(title,/rm -rf fixture/);assert.equal(choices[0],'取消');assert.equal(opts.timeout,120000);return '仅允许本次';}}});
  assert.equal((await f.call('rm -rf fixture')).result,undefined);assert.equal(calls,2);
  assert.equal((await f.call('rm -rf fixture')).result,undefined);assert.equal(dialogs,2);
  for(const choice of [undefined,'取消','Yes']){const bad=fixture({policy:()=>({action:'confirm',timeout:60}),ui:{select:async()=>choice}});assert.equal((await bad.call('rm -rf fixture')).result.block,true);}
  let n=0;const drift=fixture({policy:()=>({action:++n===1?'confirm':'block',timeout:60}),ui:{select:async()=> '仅允许本次'}});assert.equal((await drift.call('rm -rf fixture')).result.block,true);
});

test('headless confirmation blocks; hard blocks never show a dialog',async()=>{
  const f=fixture({policy:()=>({action:'confirm',timeout:60})});assert.equal((await f.call('rm -rf fixture')).result.block,true);
  const hard=fixture({policy:()=>({action:'block',reason:'protected'}),ui:{select:()=>assert.fail('hard block prompted')}});assert.equal((await hard.call('rm -rf /')).result.block,true);
});

test('Everything reads normal settings, uses argv without shell and marks limited output',async()=>{
  let invocation;
  const es=process.platform==='win32'?'D:/fixture/es.exe':'/fixture/es';
  const f=fixture({settings:{everything:{esPath:es}},executeFile:async(exe,args,opts)=>{invocation={exe,args,opts};return {stdout:JSON.stringify([{filename:'D:/fixture/es.exe'}])};}});
  const signal=new AbortController().signal;
  const got=await f.tools.get('search_files').execute('fixture',{query:'es.exe',limit:1},signal);
  assert.equal(invocation.exe,es);assert.equal(invocation.opts.shell,false);assert.equal(invocation.opts.signal,signal);assert.equal(invocation.opts.timeout,15000);
  assert.equal(got.details.count,1);assert.equal(got.details.limited,true);assert.equal(got.details.indexFreshness,'not_verified');assert.match(got.details.note,/do not establish/);
});

test('Everything failures and invalid output are errors, never false empty results',async()=>{
  const absent=fixture();await assert.rejects(absent.tools.get('search_files').execute('x',{query:'x'}),/unavailable/);
  const es=process.platform==='win32'?'D:/fixture/es.exe':'/fixture/es';
  const failure=fixture({settings:{everything:{esPath:es}},executeFile:async()=>{throw Error('fixture failure');}});await assert.rejects(failure.tools.get('search_files').execute('x',{query:'x'}),/No absence conclusion/);
  const malformed=fixture({settings:{everything:{esPath:es}},executeFile:async()=>({stdout:'Service is not running'})});await assert.rejects(malformed.tools.get('search_files').execute('x',{query:'x'}));
});

test('Everything autostart is opt-in and retries the exact CLI once after IPC failure',async()=>{
  const es=process.platform==='win32'?'D:/fixture/es.exe':'/fixture/es';
  const gui=process.platform==='win32'?'D:/fixture/Everything.exe':'/fixture/everything';
  const calls=[];const spawnCalls=[];let cliAttempts=0;let unrefCalls=0;let killCalls=0;
  const executeFile=async(exe,args,opts)=>{
    calls.push({exe,args:[...args],opts});
    if(exe===es && ++cliAttempts===1){const error=new Error('Everything IPC window not found');error.code=1;error.stderr='Everything IPC not available';throw error;}
    return {stdout:JSON.stringify([{filename:'D:/fixture/result.txt'}])};
  };
  const spawnFile=(exe,args,opts)=>{
    spawnCalls.push({exe,args:[...args],opts});
    const child={once(event,handler){if(event==='spawn')queueMicrotask(handler);return child;},unref(){unrefCalls++;},kill(){killCalls++;}};
    return child;
  };
  const f=fixture({settings:{everything:{esPath:es,guiPath:gui,autostart:true}},executeFile,spawn:spawnFile});
  const params={query:'result.txt',limit:7};
  const got=await f.tools.get('search_files').execute('x',params);
  assert.equal(got.details.count,1);
  assert.deepEqual(calls.map(({exe,args})=>({exe,args})),[
    {exe:es,args:['-n','7','-json','result.txt']},
    {exe:es,args:['-n','7','-json','result.txt']},
  ]);
  assert.equal(calls[0].opts.shell,false);assert.equal(calls[1].opts.shell,false);
  assert.deepEqual(spawnCalls.map(({exe,args})=>({exe,args})),[{exe:gui,args:[]}]);
  assert.equal(spawnCalls[0].opts.shell,false);assert.equal(spawnCalls[0].opts.detached,true);
  assert.equal(spawnCalls[0].opts.stdio,'ignore');assert.equal(unrefCalls,1);assert.equal(killCalls,0);
  assert.deepEqual(calls[0].args,calls[1].args);
});

test('Everything autostart never starts GUI for disabled, malformed, invalid-output or unrelated failures',async()=>{
  const es=process.platform==='win32'?'D:/fixture/es.exe':'/fixture/es';
  const gui=process.platform==='win32'?'D:/fixture/Everything.exe':'/fixture/everything';
  const scenarios=[
    ['disabled', {enabled:false}, null, /unavailable/],
    ['malformed query', {autostart:true}, async()=>assert.fail('CLI must not run'), /query/],
    ['invalid output', {autostart:true}, async()=>({stdout:'not json'}), /JSON/],
    ['unrelated failure', {autostart:true}, async()=>{const error=new Error('permission denied');error.code='EACCES';throw error;}, /No absence conclusion/],
  ];
  for(const [label,extra,executeFile,pattern] of scenarios){
    const calls=[];let spawned=false;
    const run=executeFile ?? (async()=>({stdout:'[]'}));
    const f=fixture({settings:{everything:{esPath:es,guiPath:gui,...extra}},executeFile:async(exe,args,opts)=>{calls.push({exe,args:[...args],opts});return run(exe,args,opts);},spawn:()=>{spawned=true;throw new Error('GUI must not start');}});
    const query=label==='malformed query'?'-bad':'fixture';
    await assert.rejects(f.tools.get('search_files').execute('x',{query}),pattern,label);
    assert.equal(calls.some(({exe})=>exe===gui),false,label);assert.equal(spawned,false,label);
  }
});


test('Everything paths and autostart settings are validated before execution',async()=>{
  const valid=process.platform==='win32'?'D:/fixture/es.exe':'/fixture/es';
  const gui=process.platform==='win32'?'D:/fixture/Everything.exe':'/fixture/everything';
  for(const everything of [
    {esPath:'relative/es.exe'}, {esPath:valid,guiPath:'relative/Everything.exe'},
    {esPath:valid,guiPath:gui,autostart:'yes'}, {esPath:valid,autostart:true},
  ]){
    const f=fixture({settings:{everything},executeFile:async()=>assert.fail('invalid config must not execute')});
    await assert.rejects(f.tools.get('search_files').execute('x',{query:'fixture'}));
  }
  const f=fixture({settings:{everything:{esPath:valid,guiPath:gui}},executeFile:async()=>({stdout:'[]'})});
  await f.tools.get('search_files').execute('x',{query:'fixture'});
});test('status command reports loaded module and version without external requests',async()=>{
  const f=fixture();await f.commands.get('shell-guard').handler('status',f.ctx);
  const data=JSON.parse(f.messages[0].content);assert.equal(data.version,'0.2.1');assert.match(data.module,/runtime.mjs/);assert.match(data.boundary,/not an OS sandbox/);
});
