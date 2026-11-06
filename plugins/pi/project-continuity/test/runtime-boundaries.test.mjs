import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CUSTOM_TYPE } from '../runtime.mjs';
import { harness, text } from './runtime-harness.mjs';

const decision = (id, text = '仅做离线检查') => ({ id, kind: 'decision', title: id, text, status: 'accepted' });

test('guidance uses its own structured section without replacing other host instructions', async t => {
  const h = await harness(t);
  const event = { messageType: 'user', prompt: '继续', systemPrompt: 'base', systemPromptOptions: { sections: { custom: 'preserve' } } };
  assert.equal(await h.event('before_agent_start', event), undefined);
  assert.equal(event.systemPromptOptions.sections.custom, 'preserve');
  assert.match(event.systemPromptOptions.sections.project_continuity, /continuity_save/);
  await h.commands.get('continuity').handler('off', h.ctx);
  await h.event('before_agent_start', event);
  assert.equal(event.systemPromptOptions.sections.project_continuity, undefined);
});

test('external Git branch changes are detected within the same session', async t => {
  const h = await harness(t);
  execFileSync('git', ['init', '-b', 'main', h.cwd], { stdio: 'ignore' });
  await h.call('continuity_save', { expectedRevision: 0, record: decision('main-only', 'Only applies to main') });
  const before = await h.event('context', { messages: [] });
  assert.match(before.messages.at(-1).content, /main-only/);
  execFileSync('git', ['-C', h.cwd, 'symbolic-ref', 'HEAD', 'refs/heads/experiment'], { stdio: 'ignore' });
  const after = await h.event('context', { messages: [] });
  assert.doesNotMatch(after.messages.at(-1).content, /Only applies to main/);
  const search = JSON.parse(text(await h.call('continuity_search', { id: 'main-only' })));
  assert.equal(search.records.length, 0);
});

test('old command snapshots cannot reinject an accepted role after cancellation', async t => {
  const h = await harness(t);
  await h.call('continuity_save', { expectedRevision: 0, record: decision('reviewer') });
  await h.commands.get('continuity').handler('status', h.ctx);
  const old = { role: 'custom', ...h.messages.at(-1), timestamp: 0 };
  await h.call('continuity_save', { expectedRevision: 1, record: { ...decision('reviewer', '角色已取消'), status: 'cancelled' } });
  const next = await h.event('context', { messages: [old, { role: 'user', content: '继续', timestamp: 0 }] });
  assert.equal(next.messages.filter(m => m.customType === 'project-continuity-status').length, 0);
  assert.match(next.messages.find(m => m.customType === CUSTOM_TYPE).content, /cancelled/);
});

test('moved project remains readable and explicit adopt permits further saves', async t => {
  const h = await harness(t);
  await h.call('continuity_save', { expectedRevision: 0, record: decision('portable') });
  const moved = await fs.mkdtemp(path.join(path.dirname(h.cwd), 'continuity-moved-'));
  t.after(() => fs.rm(moved, { recursive: true, force: true }));
  await fs.cp(path.join(h.cwd, '.pi'), path.join(moved, '.pi'), { recursive: true });
  h.ctx.cwd = moved;
  const found = JSON.parse(text(await h.call('continuity_search', { id: 'portable' })));
  assert.equal(found.records.length, 1);
  await assert.rejects(h.call('continuity_save', { expectedRevision: 1, record: decision('next') }), /isolat|adopt|workspace/i);
  await h.commands.get('continuity').handler('adopt', h.ctx);
  await h.call('continuity_save', { expectedRevision: 1, record: decision('next') });
  assert.equal(JSON.parse(text(await h.call('continuity_status', {}))).revision, 2);
});

test('ambiguous reverse cases require scope for technical records and skip automatic narration', async t => {
  const h = await harness(t);
  for (const name of ['a', 'b']) {
    await fs.mkdir(path.join(h.cwd, 'work', name), { recursive: true });
    await fs.writeFile(path.join(h.cwd, 'work', name, 'scope.md'), name);
  }
  await h.call('continuity_save', { expectedRevision: 0, record: decision('project-goal') });
  const record = { id: 'candidate', kind: 'claim', title: 'candidate', text: '未验证' };
  await assert.rejects(h.call('continuity_save', { expectedRevision: 1, record }), /case_required/);
  h.entries.push({ type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: '两个案例都成功了（未验证）' }] } });
  await h.event('agent_settled', { aborted: false });
  assert.equal(JSON.parse(text(await h.call('continuity_status', {}))).revision, 1);
  await h.call('continuity_save', { expectedRevision: 1, record: { ...record, context: { caseRoot: 'work/a' } } });
  assert.equal(JSON.parse(text(await h.call('continuity_search', { id: 'candidate', context: { caseRoot: 'work/a' } }))).records.length, 1);
});

test('automatic tool failures retain method and argument identity without guessing root cause', async t => {
  const h = await harness(t);
  await h.call('continuity_save', { expectedRevision: 0, record: decision('goal') });
  await h.event('before_agent_start', { prompt: '解析样本', systemPrompt: 'base' });
  await h.event('tool_execution_end', { toolName: 'analyze', toolCallId: 'c1', args: { target: 'a.bin', timeout: 5 }, isError: true, result: { content: [{ type: 'text', text: 'timeout' }] } });
  await h.event('agent_settled', { aborted: false });
  const search = JSON.parse(text(await h.call('continuity_search', { query: '工具失败' })));
  const record = search.records[0].current;
  assert.equal(record.status, 'failed');
  assert.equal(record.context.method, 'analyze');
  assert.match(record.context.config, /^[a-f0-9]{64}$/);
  assert.equal(record.context.question, '解析样本');
});

test('large history replies remain complete JSON with current cancelled status', async t => {
  const h = await harness(t);
  for (let revision = 0; revision < 8; revision++) {
    await h.call('continuity_save', { expectedRevision: revision, record: { ...decision('long', '内容。'.repeat(1300)), status: revision === 7 ? 'cancelled' : 'accepted' } });
  }
  const reply = text(await h.call('continuity_search', { id: 'long', history: true }));
  const data = JSON.parse(reply);
  assert.ok(reply.length <= 22000);
  assert.equal(data.current.status, 'cancelled');
  assert.equal(data.limited, true);
});
