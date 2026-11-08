import assert from 'node:assert/strict';
import test from 'node:test';
import { registerShellGuard } from '../runtime.mjs';

function fixture({policy,executeFile,ui,settings={}}={}) {
  const handlers = new Map(), tools = new Map(), commands = new Map(), messages=[];
  const api = {
    on(name,fn){ const list=handlers.get(name)??[];list.push(fn);handlers.set(name,list); },
    getSettings(){ return {shellGuard:settings}; },
    registerTool(tool){tools.set(tool.name,tool);},registerCommand(name,cmd){commands.set(name,cmd);},
    sendMessage(message){messages.push(message);},
  };
  registerShellGuard(api,{evaluate:policy,executeFile,realpath:p=>p});
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

test('status command reports loaded module and version without external requests',async()=>{
  const f=fixture();await f.commands.get('shell-guard').handler('status',f.ctx);
  const data=JSON.parse(f.messages[0].content);assert.equal(data.version,'0.2.0');assert.match(data.module,/runtime.mjs/);assert.match(data.boundary,/not an OS sandbox/);
});
