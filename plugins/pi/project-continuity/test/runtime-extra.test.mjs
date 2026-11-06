import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CUSTOM_TYPE } from '../runtime.mjs';
import { harness, text } from './runtime-harness.mjs';

test('existing single reverse case supplies original pointers without creating another state system', async t => {
  const h=await harness(t);
  await fs.mkdir(path.join(h.cwd,'work','case-a'),{recursive:true});
  await fs.writeFile(path.join(h.cwd,'work','case-a','scope.md'),'offline sample scope');
  const c=await h.event('context',{messages:[]});
  assert.match(c.messages.at(-1).content,/work\/case-a\/scope.md/);
  assert.match(c.messages.at(-1).content,/not verified/);
  await assert.rejects(fs.access(path.join(h.cwd,'.pi/memory')));
});

test('multiple cases are listed as ambiguous, not picked by time or merged', async t=> {
  const h=await harness(t);
  for(const name of ['case-a','case-b']){
    await fs.mkdir(path.join(h.cwd,'work',name),{recursive:true});
    await fs.writeFile(path.join(h.cwd,'work',name,'scope.md'),'scope');
  }
  const c=await h.event('context',{messages:[]});
  assert.match(c.messages.at(-1).content,/Multiple cases/);
  assert.match(c.messages.at(-1).content,/do not merge/);
});

test('same final self-report is not saved repeatedly on idle lifecycle events',async t=>{
  const h=await harness(t);
  await h.call('continuity_save',{expectedRevision:0,record:{id:'goal',kind:'decision',title:'目标',text:'只读核对',status:'accepted'}});
  h.entries.push({type:'message',id:'a1',message:{role:'assistant',content:[{type:'text',text:'阶段完成，但行为未验证'}]}});
  await h.event('agent_settled',{aborted:false});
  const a=JSON.parse(text(await h.call('continuity_status',{}))).revision;
  await h.event('agent_settled',{aborted:false});
  const b=JSON.parse(text(await h.call('continuity_status',{}))).revision;
  assert.equal(a,b);
});
