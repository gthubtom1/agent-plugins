import assert from 'node:assert/strict';
import test from 'node:test';
import { registerShellGuard } from '../runtime.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);
const READONLY_LOOP = 'for p in AGENTS.md dev/AGENTS.md dev/agent-plugins/AGENTS.md dev/agent-plugins/plugins/AGENTS.md dev/agent-plugins/plugins/pi/AGENTS.md dev/agent-plugins/plugins/pi/shell-guard/AGENTS.md; do if test -f "$p"; then printf "%s\\n" "$p"; fi; done';

function fixture({policy,executeFile,spawn,ui,settings={},cwd=process.cwd()}={}) {
  const handlers = new Map(), tools = new Map(), commands = new Map(), messages=[];
  const api = {
    on(name,fn){ const list=handlers.get(name)??[];list.push(fn);handlers.set(name,list); },
    getSettings(){ return {shellGuard:settings}; },
    registerTool(tool){tools.set(tool.name,tool);},registerCommand(name,cmd){commands.set(name,cmd);},
    sendMessage(message){messages.push(message);},
  };
  registerShellGuard(api,{evaluate:policy,executeFile,spawn,realpath:p=>p});
  const ctx={cwd,hasUI:Boolean(ui),ui,signal:new AbortController().signal};
  async function event(name,data={}) {let value;for(const fn of handlers.get(name)??[]){const next=await fn(data,ctx);if(next!==undefined)value=next;}return value;}
  return {api,event,tools,commands,messages,ctx,async prompt(text,source='interactive',expanded=text){await event('input',{source,text});await event('before_agent_start',{messageType:'user',prompt:expanded,systemPromptOptions:{sections:{}}});},async call(command,timeout,parentToolCallId){const data={toolName:'bash',toolCallId:'fixture',parentToolCallId,input:{command,...timeout===undefined?{}:{timeout}}};const result=await event('tool_call',data);return {result,input:data.input};}};
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

test('all confirmation cases return immediate non-terminating errors without UI',async()=>{
  const f=fixture({policy:()=>({action:'confirm',reason:'review',timeout:60}),ui:{select:()=>assert.fail('UI called')}});
  for(const parent of [undefined,'nested-parent']) {
    const got=await f.call('printf "%s\\n" "$(pwd)"',undefined,parent);
    assert.equal(got.result.block,true);
    assert.notEqual(got.result.terminate,true);
    assert.match(got.result.reason,/即时阻止/);
  }
});

test('direct, nested and independent sessions defer intact TEMP moves until Bash executes',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'shell-guard-trash-runtime-'));
  try {
    for(const [actor,parent] of [['main',undefined],['nested','parent-tool-call'],['independent',undefined]]) {
      const name=`${actor} 'cache`;
      await mkdir(path.join(root,name));
      await writeFile(path.join(root,name,'content.txt'),actor);
      const f=fixture({cwd:root,ui:{select:()=>assert.fail('UI called')}});
      const got=await f.call(`rm -rf "${name}"`,undefined,parent);
      assert.equal(got.result,undefined);
      assert.match(got.input.command,/--move-to-temp/);
      assert.equal(await readFile(path.join(root,name,'content.txt'),'utf8'),actor);
      const {stdout}=await execute('bash',['-c',got.input.command],{cwd:root,timeout:10000});
      assert.match(stdout,/Moved .*TEMP[\\/].*Recovery path: TEMP\//s);
      const batches=await readdir(path.join(root,'TEMP'));
      let found='';
      for(const batch of batches) found=await readFile(path.join(root,'TEMP',batch,name,'content.txt'),'utf8').catch(()=>found);
      assert.equal(found,actor);
    }
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('dry check and later handler block have no filesystem side effects',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'shell-guard-preflight-'));
  try {
    await writeFile(path.join(root,'keep.txt'),'untouched');
    const f=fixture({cwd:root});
    await f.commands.get('shell-guard').handler('check rm keep.txt',f.ctx);
    f.api.on('tool_call',()=>({block:true,reason:'later handler'}));
    const got=await f.call('rm keep.txt');
    assert.equal(got.result.block,true);
    assert.match(got.input.command,/--move-to-temp/);
    assert.deepEqual(await readdir(root),['keep.txt']);
    assert.equal(await readFile(path.join(root,'keep.txt'),'utf8'),'untouched');
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('invalid TEMP fails during helper execution and unsupported deletions never fall through',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'shell-guard-bad-temp-'));
  try {
    await writeFile(path.join(root,'keep.txt'),'not lost');
    await writeFile(path.join(root,'TEMP'),'not a directory');
    const f=fixture({cwd:root,settings:{allow:['.*']},ui:{select:()=>assert.fail('UI called')}});
    const got=await f.call('rm -f keep.txt');
    assert.equal(got.result,undefined);
    await assert.rejects(execute('bash',['-c',got.input.command],{cwd:root,timeout:10000}),/original rm was not run/);
    for(const command of ['rm -rf ../outside','git clean -fd','find . -delete','rm keep.txt && ls','timeout 3 rm keep.txt','rm *.txt','rm "$TARGET"','unlink keep.txt','node -e "require(\'fs\').unlinkSync(\'keep.txt\')"','rm -rf TEMP','rm -rf temp','rm -rf .git','rm -rf db','rm app.sqlite3','rm -rf C:/','rm -rf /']) {
      const denied=await f.call(command);
      assert.equal(denied.result?.block,true,command);
      assert.equal(denied.input.command,command);
    }
    assert.equal(await readFile(path.join(root,'keep.txt'),'utf8'),'not lost');
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('exact read-only loop and ordinary commands allow unchanged with finite timeout',async()=>{
  const f=fixture({ui:{select:()=>assert.fail('UI called')}});
  for(const command of [READONLY_LOOP,'ls','git status','rg -n token src/','npm run build']) {
    const got=await f.call(command);
    assert.equal(got.result,undefined,command);
    assert.equal(got.input.command,command);
    assert.ok(Number.isFinite(got.input.timeout)&&got.input.timeout>0);
  }
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
  const calls=[];let cliAttempts=0;
  const executeFile=async(exe,args,opts)=>{
    calls.push({exe,args:[...args],opts});
    if(exe===es && ++cliAttempts===1){const error=new Error('Everything IPC window not found');error.code=1;error.stderr='Everything IPC not available';throw error;}
    if(exe===gui){const error=new Error('GUI launch timeout');error.code='ETIMEDOUT';throw error;}
    return {stdout:JSON.stringify([{filename:'D:/fixture/result.txt'}])};
  };
  const f=fixture({settings:{everything:{esPath:es,guiPath:gui,autostart:true}},executeFile});
  const params={query:'result.txt',limit:7};
  const got=await f.tools.get('search_files').execute('x',params);
  assert.equal(got.details.count,1);
  assert.deepEqual(calls.map(({exe,args})=>({exe,args})),[
    {exe:es,args:['-n','7','-json','result.txt']},
    {exe:gui,args:[]},
    {exe:es,args:['-n','7','-json','result.txt']},
  ]);
  assert.equal(calls[0].opts.shell,false);assert.equal(calls[1].opts.shell,false);assert.equal(calls[2].opts.shell,false);
  assert.equal(calls[1].opts.timeout,5000);
  assert.deepEqual(calls[0].args,calls[2].args);
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
  const data=JSON.parse(f.messages[0].content);assert.equal(data.version,'0.2.3');assert.match(data.module,/runtime.mjs/);assert.match(data.boundary,/not an OS sandbox/);
});
