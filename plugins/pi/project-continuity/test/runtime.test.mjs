import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { registerContinuity, CUSTOM_TYPE } from '../runtime.mjs';
import { harness, text } from './runtime-harness.mjs';

test('registers only continuity tools and does not rewrite tools or auto-continue', async t => {
  const h = await harness(t);
  assert.deepEqual([...h.tools.keys()], ['continuity_status','continuity_search','continuity_save']);
  assert.ok(h.commands.has('continuity'));
  assert.equal(h.hooks.has('agent_end'), false);
  assert.equal(h.hooks.has('agent_before_settle'), false);
});

test('ordinary startup/prompt/read/compaction never creates a memory directory', async t => {
  const h = await harness(t);
  await h.event('session_start');
  const guide = await h.event('before_agent_start', { prompt: '你好', messageType: 'user', systemPrompt: 'base' });
  assert.match(guide.systemPrompt, /base/);
  await h.event('context', { messages: [] });
  await h.call('continuity_status', {});
  await h.event('session_before_compact');
  await h.event('session_compact');
  await h.event('agent_settled');
  await assert.rejects(fs.access(path.join(h.cwd,'.pi/memory')));
});

test('untrusted project reads/writes are inert and no prompt is injected', async t => {
  const h = await harness(t, { trusted: false });
  assert.equal(await h.event('before_agent_start', { prompt: '继续项目', systemPrompt: 'base' }), undefined);
  await assert.rejects(h.call('continuity_save', { expectedRevision: 0, record: { id:'role',kind:'decision',title:'审核员',text:'仅查日志',status:'accepted' } }), /trusted/);
  await assert.rejects(fs.access(path.join(h.cwd,'.pi/memory')));
});

test('save binds actual session provenance, restores on a fresh runtime, and replaces stale own injection', async t => {
  const h = await harness(t);
  await h.call('continuity_save', { expectedRevision: 0, record: { id:'reviewer',kind:'decision',title:'审核员',text:'审核员负责核对日志',status:'accepted',aliases:['角色A'] } });
  const status = JSON.parse(text(await h.call('continuity_status', {})));
  assert.equal(status.revision, 1);
  await h.call('continuity_save', { expectedRevision: 1, record: { id:'reviewer',kind:'decision',title:'审核员已取消',text:'取消审核员角色，不再执行旧职责',status:'cancelled',reason:'用户改变设计',aliases:['角色A'] } });
  const c = await h.event('context', { messages: [{role:'user',content:'继续项目',timestamp:0},{role:'custom',customType:CUSTOM_TYPE,content:'OLD ACTIVE ROLE',timestamp:0,display:false}] });
  assert.equal(c.messages.filter(m=>m.customType===CUSTOM_TYPE).length,1);
  assert.doesNotMatch(c.messages.at(-1).content,/OLD ACTIVE ROLE/);
  assert.match(c.messages.at(-1).content,/cancelled|取消/);
  assert.ok(c.messages.at(-1).content.length<6500);
  const newHooks=new Map();
  registerContinuity({registerTool(){},registerCommand(){},on(n,f){newHooks.set(n,f)},sendMessage(){}});
  const restored=await newHooks.get('context')({messages:[]},{...h.ctx,sessionManager:{...h.ctx.sessionManager,getSessionId:()=> 'fresh-unrelated-session'}});
  assert.match(restored.messages.at(-1).content,/cancelled|取消/);
});

test('off strips previous own context without touching user messages', async t => {
  const h=await harness(t);
  await h.commands.get('continuity').handler('off',h.ctx);
  const user={role:'user',content:'原始请求',timestamp:0};
  const c=await h.event('context',{messages:[user,{role:'custom',customType:CUSTOM_TYPE,content:'memory',timestamp:0}]});
  assert.deepEqual(c.messages,[user]);
});

test('settled captures assistant narration as candidate not verified success; no background LLM', async t=> {
  const h=await harness(t);
  await h.call('continuity_save',{expectedRevision:0,record:{id:'goal',kind:'decision',title:'目标',text:'只读核对',status:'accepted'}});
  h.entries.push({type:'message',id:'a1',message:{role:'assistant',content:[{type:'text',text:'终极版全部成功（这只是自述）'}]}});
  await h.event('agent_settled',{aborted:false});
  const found=JSON.parse(text(await h.call('continuity_search',{query:'终极版'})));
  assert.match(JSON.stringify(found),/candidate/);
  assert.doesNotMatch(JSON.stringify(found),/"status":\s*"validated"/);
});
