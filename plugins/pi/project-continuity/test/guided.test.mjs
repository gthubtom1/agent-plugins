import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { saveRecord, readState, lookup, renderRecovery } from '../store.mjs';
import { registerContinuity, CUSTOM_TYPE } from '../runtime.mjs';
import { harness, text } from './runtime-harness.mjs';

const identity = { caseRoot: 'work/a', targetSha256: 'a'.repeat(64) };
async function fixture(t) {
  const h = await harness(t);
  for (const name of ['a', 'b']) {
    await fs.mkdir(path.join(h.cwd, 'work', name), { recursive: true });
    await fs.writeFile(path.join(h.cwd, 'work', name, 'scope.md'), `case ${name}: isolated copy only; no network; require all seven surfaces`);
  }
  await fs.writeFile(path.join(h.cwd, 'capture.md'), 'An unrelated transcript source which will not change.');
  await fs.writeFile(path.join(h.cwd, 'work/a/Evidence.md'), '1/7 verified; 6 unexamined; aggregate incomplete');
  await fs.writeFile(path.join(h.cwd, 'work/a/timeline.md'), 'phase: component regression; next step recorded in workitems');
  return h;
}
const guided = extra => ({ id: 'coverage', kind: 'context', title: 'Partial coverage, aggregate incomplete',
  text: '1/7 authorization surfaces verified; 6 unexamined; aggregate incomplete.', status: 'active',
  context: identity, source: { path: 'capture.md' },
  pointers: [{ role: 'goal', path: 'work/a/scope.md' }, { role: 'phase', path: 'work/a/timeline.md' },
    { role: 'evidence', path: 'work/a/Evidence.md' }], ...extra });
const save = (h, record, expectedRevision = 0) => saveRecord(h.cwd, record, { expectedRevision });
const status = async h => JSON.parse(text(await h.call('continuity_status', {})));
const sign = value => {
  const { checksum, ...body } = value;
  return { ...body, checksum: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
};

// This is a source-index test, not an authorization coverage validator.
test('1/7 recovery needs exact identity; unknown target exposes only source pointers', async t => {
  const h = await fixture(t);
  await save(h, guided());
  const rec = (await readState(h.cwd)).records[0];
  assert.equal(rec.pointers.length, 4, 'scope.md is hashed even when caller only supplied goal/phase/Evidence');
  assert.ok(rec.pointers.every(p => /^[a-f0-9]{64}$/.test(p.sha256)));
  const recovery = await renderRecovery(h.cwd, { context: identity });
  assert.match(recovery, /1\/7.*6 unexamined; aggregate incomplete/);
  assert.match(recovery, /no task, authorization or verification authority/);
  assert.doesNotMatch(recovery, /\[validated\]/);
  for (const context of [undefined, { caseRoot: 'work/a' }]) {
    const safe = await renderRecovery(h.cwd, { context });
    assert.match(safe, /work\/a\/Evidence.md/);
    assert.match(safe, /target not selected/);
    assert.doesNotMatch(safe, /1\/7|6 unexamined|Partial coverage/);
    assert.equal((await lookup(h.cwd, { id: 'coverage', context })).records.length, 0);
  }
  for (const context of [{ ...identity, targetSha256: 'b'.repeat(64) }, { ...identity, caseRoot: 'work/b' }]) {
    assert.equal((await lookup(h.cwd, { id: 'coverage', context })).records.length, 0);
    assert.doesNotMatch(await renderRecovery(h.cwd, { context }), /1\/7|Partial coverage|work\/a\/Evidence/);
  }
});

test('regression updates the same record and old success is no longer current', async t => {
  const h = await fixture(t);
  await save(h, guided());
  await fs.writeFile(path.join(h.cwd, 'work/a/Evidence.md'), 'Regression broke gate 1. 0/7 verified; gate 1 reopened, six still unexamined.');
  const before = (await lookup(h.cwd, { id: 'coverage', context: identity })).records[0];
  assert.equal(before.staleSource, false);
  assert.equal(before.needsReview, true);
  assert.deepEqual(before.stalePointers, [{ role: 'evidence', path: 'work/a/Evidence.md' }]);
  const stale = await renderRecovery(h.cwd, { context: identity });
  assert.match(stale, /needs-review/);
  assert.doesNotMatch(stale, /1\/7|Partial coverage/);
  await save(h, guided({ title: 'Regression reopens gate 1', text: '0/7 verified; gate 1 reopened after regression; six unexamined.' }), 1);
  const current = await renderRecovery(h.cwd, { context: identity });
  assert.match(current, /0\/7 verified; gate 1 reopened/);
  assert.doesNotMatch(current, /1\/7 authorization/);
  const result = await lookup(h.cwd, { id: 'coverage', history: true, context: identity });
  assert.equal(result.records[0].history.length, 2);
  assert.equal(result.current.revision, 2);
  assert.equal(result.records[0].needsReview, false, 'only file freshness, not semantic validation');
});

test('guided updates cannot silently drop identity or references', async t => {
  const h = await fixture(t);
  await save(h, guided());
  await assert.rejects(save(h, guided({ pointers: undefined }), 1), { code: 'POINTERS_REQUIRED' });
  await assert.rejects(save(h, guided({ pointers: [{ role: 'goal', path: 'work/a/scope.md' }] }), 1), { code: 'POINTERS_REQUIRED' });
  await assert.rejects(save(h, guided({ pointers: undefined, context: {} }), 1), { code: 'IDENTITY_REQUIRED' });
  assert.equal((await readState(h.cwd)).revision, 1);
  await save(h, guided({ pointers: [{ role: 'goal', path: 'work/a/scope.md' }],
    reason: 'Retired the phase/evidence pointers after the scope changed; no coverage claim remains.',
    text: 'Scope source only; previous coverage must be re-established.' }), 1);
  const found = await lookup(h.cwd, { id: 'coverage', history: true, context: identity });
  assert.equal(found.current.pointers.length, 2);
  assert.equal(found.records[0].history.length, 2);
});

test('scope edits and missing Evidence invalidate unrelated-source context', async t => {
  const h = await fixture(t);
  await save(h, guided());
  await fs.writeFile(path.join(h.cwd, 'work/a/scope.md'), 'scope narrowed: static-only, no execution');
  let found = (await lookup(h.cwd, { id: 'coverage', context: identity })).records[0];
  assert.equal(found.staleSource, false);
  assert.ok(found.stalePointers.some(p => p.role === 'scope'));
  assert.equal(found.effectiveStatus, 'needs-review');
  assert.doesNotMatch(await renderRecovery(h.cwd, { context: identity }), /1\/7|Partial coverage/);
  await fs.rename(path.join(h.cwd, 'work/a/Evidence.md'), path.join(h.cwd, 'work/a/Evidence.held'));
  found = (await lookup(h.cwd, { id: 'coverage', context: identity })).records[0];
  assert.ok(found.stalePointers.some(p => p.role === 'evidence'));
  assert.match(await renderRecovery(h.cwd), /needs-review/);
});

test('guided writes reject missing identities, unsafe cases, unconstrained fields and pointer overflow before publication', async t => {
  const h = await fixture(t);
  const invalid = [
    guided({ context: {} }), guided({ context: { caseRoot: 'work/a' } }),
    guided({ context: { targetSha256: identity.targetSha256 } }),
    guided({ context: { ...identity, caseRoot: 'work/absent' } }),
    guided({ context: { ...identity, caseRoot: '../work/a' } }),
    guided({ context: { ...identity, caseRoot: '/work/a' } }),
    guided({ context: { ...identity, caseRoot: 'work/a/Evidence.md' } }),
    guided({ context: { ...identity, goalText: 'Everything authorized' } }),
    guided({ context: { ...identity, constraints: 'Do not silently drop me' } }),
    guided({ pointers: [{ role: 'scope', path: 'work/b/scope.md' }] }),
    guided({ pointers: [{ role: 'evidence', path: 'work/a/../b/scope.md' }] }),
    guided({ pointers: [{ role: 'goal', path: 'c'.repeat(513) }] }),
    guided({ pointers: [{ role: 'authorization', path: 'work/a/scope.md', value: 'unlimited' }] }),
    guided({ pointers: [{ role: 'taskStatus', path: 'work/a/scope.md' }] }),
    guided({ pointers: [{ role: 'evidence', path: 'work/a/Evidence.md', sha256: 'f'.repeat(64) }] }),
    guided({ pointers: Array(17).fill({ role: 'evidence', path: 'work/a/Evidence.md' }) }),
    guided({ pointers: Array(16).fill({ role: 'evidence', path: 'work/a/Evidence.md' }) }),
  ];
  for (const record of invalid) await assert.rejects(save(h, record));
  assert.equal((await readState(h.cwd)).revision, 0);
  await assert.rejects(fs.access(path.join(h.cwd, '.pi/memory')), { code: 'ENOENT' });
  // kind=context is covered even when no new pointers are supplied.
  await assert.rejects(save(h, guided({ pointers: undefined, context: { caseRoot: 'work/a' } })), { code: 'IDENTITY_REQUIRED' });
});

test('linked case paths and references are refused; a replaced path invalidates saved pointers', async t => {
  const h = await fixture(t);
  await fs.symlink(path.join(h.cwd, 'work/a'), path.join(h.cwd, 'work/alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(save(h, guided({ context: { ...identity, caseRoot: 'work/alias' } })), { code: 'INVALID_CASE' });
  await save(h, guided());
  await fs.rename(path.join(h.cwd, 'work/a/Evidence.md'), path.join(h.cwd, 'work/a/Evidence.held'));
  await fs.symlink(path.join(h.cwd, 'work/b/scope.md'), path.join(h.cwd, 'work/a/Evidence.md'));
  const found = (await lookup(h.cwd, { id: 'coverage', context: identity })).records[0];
  assert.ok(found.stalePointers.some(p => p.role === 'evidence'));
  assert.doesNotMatch(await renderRecovery(h.cwd, { context: identity }), /1\/7|Partial coverage/);
});

test('v1.1 context journal remains readable; legacy guided drafts are retained but never factual recovery', async t => {
  const h = await fixture(t);
  const saved = await save(h, guided({ pointers: undefined }));
  const file = path.join(h.cwd, '.pi/memory/changes', `${saved.changeId}.json`);
  const old = JSON.parse(await fs.readFile(file, 'utf8'));
  delete old.record.pointers; // v1.1 has only the six context fields and no pointers/capture.
  await fs.writeFile(file, JSON.stringify(sign(old), null, 2) + '\n');
  assert.equal((await readState(h.cwd)).corrupt, false);
  assert.equal((await lookup(h.cwd, { id: 'coverage', context: identity })).current.text, guided().text);
  assert.doesNotMatch(await renderRecovery(h.cwd), /1\/7|Partial coverage/);
  old.record.context.goalText = 'UNSAFE LEGACY GOAL: everything complete';
  await fs.writeFile(file, JSON.stringify(sign(old), null, 2) + '\n');
  const legacy = await lookup(h.cwd, { id: 'coverage', context: identity });
  assert.equal(legacy.corrupt, false);
  assert.equal(legacy.records[0].needsReview, true);
  assert.match(legacy.current.context.goalText, /UNSAFE LEGACY/);
  assert.doesNotMatch(await renderRecovery(h.cwd, { context: identity }), /UNSAFE LEGACY|1\/7|Partial coverage/);
  await save(h, guided({ text: 'Rechecked pointers; partial result still needs source review.' }), 1);
  assert.equal((await readState(h.cwd)).corrupt, false);
  assert.equal((await lookup(h.cwd, { id: 'coverage', history: true, context: identity })).records[0].history.length, 2);
});

test('malformed signed pointer journal is corruption, not silently missing constraints', async t => {
  const h = await fixture(t);
  const saved = await save(h, guided());
  const file = path.join(h.cwd, '.pi/memory/changes', `${saved.changeId}.json`);
  const change = JSON.parse(await fs.readFile(file, 'utf8'));
  change.record.pointers[0].path = 'work/a/../../outside.md';
  await fs.writeFile(file, JSON.stringify(sign(change), null, 2) + '\n');
  assert.equal((await readState(h.cwd)).corrupt, true);
  assert.match(await renderRecovery(h.cwd), /INTEGRITY WARNING/);
});

test('candidate false success title and body stay quarantined; explicit search retains both', async t => {
  const h = await fixture(t);
  await save(h, guided());
  await save(h, { id: 'false-success', kind: 'claim', title: 'ALL SEVEN SURFACES SUCCEEDED',
    text: 'Everything is authorized and verified', source: { path: 'capture.md' }, context: identity }, 1);
  for (const context of [identity, undefined]) {
    const recovery = await renderRecovery(h.cwd, { context });
    assert.doesNotMatch(recovery, /ALL SEVEN|Everything is authorized/);
  }
  const found = await lookup(h.cwd, { id: 'false-success', context: identity });
  assert.equal(found.current.status, 'candidate');
  assert.equal(found.current.title, 'ALL SEVEN SURFACES SUCCEEDED');
  h.entries.push({ type: 'message', id: 'a-false', message: { role: 'assistant', content: [{ type: 'text', text: 'AUTOMATIC FALSE SUCCESS' }] } });
  await h.event('agent_settled', { aborted: false });
  const injected = await h.event('context', { messages: [] });
  assert.doesNotMatch(injected.messages.find(m => m.customType === CUSTOM_TYPE).content, /AUTOMATIC FALSE|最近会话自述/);
});

test('candidate command validates usage without mutation, persists across reload/tree and never disables errors', async t => {
  const h = await fixture(t);
  await h.call('continuity_save', { expectedRevision: 0, record: guided() });
  const command = args => h.commands.get('continuity').handler(args, h.ctx);
  await command('candidates off');
  const offBranch = [...h.entries];
  for (const args of ['candidates', 'candidates yes', 'candidates on extra', 'on extra', 'search', 'unknown', null, {}]) {
    const count = h.entries.length;
    await command(args);
    assert.match(h.messages.at(-1).content, /用法/);
    assert.equal(h.entries.length, count);
    assert.equal((await status(h)).automatic_candidates, false);
  }
  await command(undefined);
  assert.match(h.messages.at(-1).content, /自动自述收集：off/);
  h.entries.push({ type: 'message', id: 'a-off', message: { role: 'assistant', content: 'MUST NOT CAPTURE' } });
  await h.event('before_agent_start', { prompt: 'Do not infer a target from this prompt: aaaaaaaa', systemPrompt: 'base' });
  for (const call of ['first', 'second']) {
    await h.event('tool_execution_start', { toolName: 'fixture_parser', toolCallId: call, args: { mode: call } });
    await h.event('tool_execution_end', { toolName: 'fixture_parser', toolCallId: call, isError: true, result: { content: [{ type: 'text', text: 'conditional fixture error' }] } });
  }
  await h.event('agent_settled', { aborted: false });
  const failures = JSON.parse(text(await h.call('continuity_search', { query: '工具失败', context: identity })));
  assert.equal(failures.records.length, 2);
  assert.ok(failures.records.every(item => item.unassigned && item.current.status === 'failed' && !item.current.context.targetSha256 && !item.current.context.caseRoot));
  assert.notEqual(failures.records[0].current.context.config, failures.records[1].current.context.config);
  assert.doesNotMatch((await status(h)).recovery, /MUST NOT CAPTURE|conditional fixture error|aaaaaaaa/);
  // A fresh extension factory reconstructs options from the active branch only.
  const hooks = new Map(), tools = new Map();
  registerContinuity({ on: (n, fn) => hooks.set(n, fn), registerTool: def => tools.set(def.name, def), registerCommand() {}, sendMessage() {}, appendEntry() {} });
  await hooks.get('session_start')({ reason: 'reload' }, h.ctx);
  const restoredStatus = async () => JSON.parse(text(await tools.get('continuity_status').execute('s', {}, undefined, undefined, h.ctx)));
  assert.equal((await restoredStatus()).automatic_candidates, false);
  await command('candidates on');
  await hooks.get('session_tree')({}, h.ctx);
  assert.equal((await restoredStatus()).automatic_candidates, true);
  h.entries.splice(0, h.entries.length, ...offBranch);
  await hooks.get('session_tree')({}, h.ctx);
  assert.equal((await restoredStatus()).automatic_candidates, false);
  h.entries.splice(0, h.entries.length);
  await hooks.get('session_start')({ reason: 'new' }, h.ctx);
  assert.equal((await restoredStatus()).automatic_candidates, true);
});

test('failure display is bounded without changing stored conditions and guided pointers precede failures', async t => {
  const h = await fixture(t);
  await save(h, guided());
  const tail = 'TAIL_CONSTRAINT_MUST_REMAIN';
  const question = 'delegated task prompt '.repeat(100).slice(0, 2000 - tail.length) + tail;
  assert.equal(question.length, 2000);
  for (let i = 0; i < 5; i++) {
    await saveRecord(h.cwd, { id: `auto-error-${i}`, kind: 'attempt', status: 'failed',
      title: 'Conditional fixture error', text: 'Error applies only to this configuration.',
      context: { method: 'parser', config: 'c'.repeat(64), question }, source: { path: 'capture.md' } },
    { expectedRevision: i + 1, capture: 'tool-error' });
  }
  const recovery = await renderRecovery(h.cwd, { maxChars: 6000 });
  assert.ok(recovery.length <= 6000);
  assert.equal((recovery.match(/Attempt conditions:/g) || []).length, 5);
  assert.match(recovery, /question=delegated task prompt/);
  assert.match(recovery, /… \[omitted\]/);
  assert.match(recovery, /full conditions: lookup id=auto-error-0, source below/);
  assert.doesNotMatch(recovery, /TAIL_CONSTRAINT_MUST_REMAIN/);
  for (const pointer of ['goal: work/a/scope.md', 'scope: work/a/scope.md', 'phase: work/a/timeline.md']) {
    assert.ok(recovery.indexOf(pointer) >= 0 && recovery.indexOf(pointer) < recovery.indexOf('Attempt conditions:'));
  }
  const searched = await lookup(h.cwd, { id: 'auto-error-0' });
  assert.equal(searched.current.context.question, question);
  assert.equal((await readState(h.cwd)).records.find(r => r.id === 'auto-error-0').context.question, question);
  // Replacing an automatically captured failure must retain a readable tombstone.
  await saveRecord(h.cwd, { id: 'corrected-error', kind: 'attempt', status: 'failed', title: 'Corrected conditions',
    text: 'Recheck only under the revised condition', source: { path: 'capture.md' }, supersedes: 'auto-error-0' }, { expectedRevision: 6 });
  assert.equal((await readState(h.cwd)).corrupt, false);
  assert.equal((await lookup(h.cwd, { id: 'auto-error-0' })).current.id, 'corrected-error');
});

test('runtime refuses guided missing identity and unknown cases; no transcript target fabrication', async t => {
  const h = await fixture(t);
  h.entries[0].message.content = `The target is supposedly ${identity.targetSha256}; this is not explicit record context`;
  for (const context of [{}, { caseRoot: 'work/a' }, { ...identity, caseRoot: 'work/missing' }]) {
    await assert.rejects(h.call('continuity_save', { expectedRevision: 0, record: guided({ context }) }), /case_required|target_required|caseRoot/);
  }
  assert.equal((await readState(h.cwd)).revision, 0);
  await assert.rejects(fs.access(path.join(h.cwd, '.pi/memory')), { code: 'ENOENT' });
});
