import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  initializeProject, adoptProject, resolveProject, saveRecord, readState, lookup,
  renderRecovery, regenProjections,
} from '../store.mjs';

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pc-store-regression-'));
const memoryPath = (root, ...parts) => path.join(root, '.pi', 'memory', ...parts);
const input = (id, extra = {}) => ({ kind: 'decision', id, title: id,
  status: 'accepted', source: { path: 'source.md' }, ...extra });
async function project(name) {
  const root = path.join(tmpRoot, name);
  await initializeProject(root);
  await fsp.writeFile(path.join(root, 'source.md'), 'fixture evidence');
  return root;
}
async function save(root, id, extra = {}) {
  return saveRecord(root, input(id, extra), { expectedRevision: (await readState(root)).revision });
}
const byId = (state, id) => state.records.find((r) => r.id === id);
const sign = (value) => {
  const { checksum, ...body } = value;
  return { ...body, checksum: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
};

// Moving fixtures out of the active path simulates missing files without deletion.
async function moveAside(file) {
  const moved = `${file}.held`;
  await fsp.rename(file, moved);
  return moved;
}

test('overlong decision ending in a prohibition is rejected before journal writes; original truth stays intact', async (t) => {
  const root = await project('overlong-constraint');
  const saved = await save(root, 'constraint', { text: '原始约束：只能本地测试。' });
  const before = await readState(root);
  const marker = memoryPath(root, 'project.json');
  const journal = memoryPath(root, 'changes');
  const change = path.join(journal, `${saved.changeId}.json`);
  const originalMarker = await fsp.readFile(marker, 'utf8');
  const originalChange = await fsp.readFile(change, 'utf8');
  const originalFiles = await fsp.readdir(journal);
  let writeAttempts = 0;
  t.mock.method(fsp, 'open', async () => {
    writeAttempts++;
    throw new Error('unexpected lock or journal write');
  });
  await assert.rejects(saveRecord(root, input('constraint', {
    text: '允许继续本地分析。'.repeat(500) + '严禁部署或上传任何文件。',
  }), { expectedRevision: before.revision }), (error) => {
    assert.equal(error.code, 'INPUT_TOO_LONG');
    assert.match(error.message, /input\.text exceeds 4000 characters/);
    assert.match(error.message, /shorten.*source pointer/);
    return true;
  });
  assert.equal(writeAttempts, 0);
  t.mock.restoreAll();
  assert.deepEqual(await readState(root), before);
  assert.deepEqual(await fsp.readdir(journal), originalFiles);
  assert.equal(await fsp.readFile(marker, 'utf8'), originalMarker);
  assert.equal(await fsp.readFile(change, 'utf8'), originalChange);
});

test('explicit save length limits reject overflow and preserve exact-boundary values', async () => {
  const root = await project('input-length-bounds');
  const cases = [
    ['input.title', { title: 't'.repeat(2001) }],
    ['input.text', { text: 'x'.repeat(4001) }],
    ['input.reason', { reason: 'r'.repeat(1001) }],
    ['input.reason', { reason: ' '.repeat(1001) }],
    ['input.source.excerpt', { source: { path: 'source.md', excerpt: 'e'.repeat(2001) } }],
    ['input.aliases', { aliases: Array(21).fill('duplicate') }],
    ['input.aliases[0]', { aliases: [' ' + 'a'.repeat(256)] }],
    ...['caseRoot', 'branch', 'targetSha256', 'method', 'config', 'question'].map((key) =>
      [`input.context.${key}`, { context: { [key]: 'c'.repeat(2001) } }]),
  ];
  for (const [field, extra] of cases) {
    await assert.rejects(saveRecord(root, input('bounded', extra), { expectedRevision: 0 }), (error) => {
      assert.equal(error.code, 'INPUT_TOO_LONG', field);
      assert.ok(error.message.startsWith(`${field} exceeds `), field);
      return true;
    });
  }
  assert.deepEqual(await fsp.readdir(memoryPath(root, 'changes')), []);
  assert.equal((await readState(root)).revision, 0);
  const exact = input('bounded', {
    title: '题'.repeat(2000), text: '文'.repeat(4000), reason: '因'.repeat(1000),
    source: { path: 'source.md', excerpt: '摘'.repeat(2000) },
    aliases: Array.from({ length: 20 }, (_, index) => String(index).padStart(256, 'a')),
    context: { question: '问'.repeat(2000) },
  });
  await saveRecord(root, exact, { expectedRevision: 0 });
  const stored = byId(await readState(root), 'bounded');
  for (const field of ['title', 'text', 'reason', 'aliases', 'context']) {
    assert.deepEqual(stored[field], exact[field], field);
  }
  assert.equal(stored.source.excerpt, exact.source.excerpt);
});

test('explicit uninitialized child root never borrows the ancestor marker', async () => {
  const outer = await project('explicit-root');
  const inner = path.join(outer, 'inner');
  const cwd = path.join(inner, 'src');
  await fsp.mkdir(cwd, { recursive: true });
  const resolved = await resolveProject(cwd, { root: inner });
  assert.equal(resolved.root, await fsp.realpath(inner));
  assert.equal(resolved.exists, false);
  assert.equal(resolved.markerFound, false);
  assert.equal(resolved.projectId, undefined);
});

test('nested package and Git boundaries isolate roots; marked inner subdirs recover inner identity', async () => {
  const outer = await project('nested-roots');
  for (const marker of ['package.json', '.git']) {
    const inner = path.join(outer, marker === '.git' ? 'git-child' : 'package-child');
    const cwd = path.join(inner, 'src');
    await fsp.mkdir(cwd, { recursive: true });
    await fsp.writeFile(path.join(inner, marker), '{}');
    const before = await resolveProject(cwd);
    assert.equal(before.root, inner);
    assert.equal(before.exists, false);
    const initialized = await initializeProject(inner);
    const after = await resolveProject(cwd);
    assert.equal(after.projectId, initialized.projectId);
    assert.notEqual(after.projectId, (await readState(outer)).project.projectId);
  }
});

test('concurrent fresh initialization shares one identity and preserves the first record', async () => {
  const root = path.join(tmpRoot, 'init-race');
  await fsp.mkdir(root);
  await fsp.writeFile(path.join(root, 'source.md'), 'fixture');
  const [a, b, saved] = await Promise.all([
    initializeProject(root), initializeProject(root),
    saveRecord(root, input('first'), { expectedRevision: 0 }),
  ]);
  assert.equal(a.projectId, b.projectId);
  assert.equal(a.projectId, saved.project.projectId);
  const state = await readState(root);
  assert.equal(state.corrupt, false);
  assert.equal(state.revision, 1);
  assert.equal(byId(state, 'first').status, 'accepted');
});

test('Chinese historical aliases reach the final cancellation through replacements', async () => {
  const root = await project('chinese-cancel');
  await save(root, 'elder', { title: '旧角色', aliases: ['长老', '旧称'] });
  await save(root, 'elder', { title: '修改角色', aliases: ['新称'] });
  await save(root, 'advisor', { title: '顾问角色', supersedes: 'elder' });
  await save(root, 'advisor', { title: '顾问已取消', status: 'cancelled', reason: '用户撤回' });
  for (const opts of [{ id: '长老' }, { query: '旧称' }, { id: '新称' }]) {
    const result = await lookup(root, { ...opts, history: true });
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].record.id, 'advisor');
    assert.equal(result.records[0].record.status, 'cancelled');
    assert.equal(result.records[0].record.tombstone, true);
    assert.equal(result.records[0].history.at(-1).record.status, 'cancelled');
  }
});

test('replacement context is checked after following an old id or query', async () => {
  const root = await project('replacement-context');
  await save(root, 'old', { aliases: ['历史别名'], context: { caseRoot: 'A' } });
  await save(root, 'new', { supersedes: 'old', context: { caseRoot: 'B' }, text: 'B-only fact' });
  for (const selector of [{ id: '历史别名' }, { query: '历史别名' }]) {
    const wrong = await lookup(root, { ...selector, context: { caseRoot: 'A' } });
    assert.deepEqual(wrong.records, []);
    assert.equal(wrong.current, null);
    assert.deepEqual(wrong.incompatible, [{ id: 'new', reason: 'context mismatch', mismatchedKeys: ['caseRoot'] }]);
    assert.ok(!JSON.stringify(wrong).includes('B-only fact'));
    const right = await lookup(root, { ...selector, context: { caseRoot: 'B' } });
    assert.equal(right.records[0].record.id, 'new');
  }
});

test('incompatible results are bounded metadata without unrelated facts or source excerpts', async () => {
  const root = await project('bounded-incompatible');
  for (let n = 0; n < 8; n++) {
    await save(root, `other-${n}`, { context: { caseRoot: 'elsewhere' },
      text: 'UNRELATED_FACT', reason: 'UNRELATED_REASON',
      source: { path: 'source.md', excerpt: 'UNRELATED_EXCERPT' } });
  }
  const result = await lookup(root, { context: { caseRoot: 'here' }, limit: 2 });
  assert.deepEqual(result.records, []);
  assert.equal(result.incompatible.length, 2);
  assert.ok(!JSON.stringify(result.incompatible).includes('UNRELATED'));
  assert.ok(result.incompatible.every((r) => Object.keys(r).sort().join(',') === 'id,mismatchedKeys,reason'));
});

test('failed attempt only applies under matching method, config and question; recovery states conditions', async () => {
  const root = await project('conditional-attempt');
  const context = { caseRoot: 'A', branch: 'main', targetSha256: 'sample-v1',
    method: 'parser', config: 'budget=10', question: 'decode header' };
  await save(root, 'attempt', { kind: 'attempt', status: 'failed', context, title: 'header timeout' });
  assert.equal((await lookup(root, { id: 'attempt', context })).current.status, 'failed');
  for (const key of Object.keys(context)) {
    const changed = { ...context, [key]: 'different' };
    assert.deepEqual((await lookup(root, { id: 'attempt', context: changed })).records, []);
    assert.ok(!(await renderRecovery(root, { context: changed })).includes('header timeout'));
  }
  const recovery = await renderRecovery(root);
  assert.match(recovery, /Attempt conditions:.*method=parser.*config=budget=10.*question=decode header/);
});

test('recovery reserves complete omission notice and prioritizes cancellation and constraint pointers', async () => {
  const root = await project('budget-priority');
  await save(root, 'constraint', { title: 'Bounded constraint', text: 'Critical constraint begins ' + 'x'.repeat(1600) + ' ends here.' });
  for (let i = 0; i < 5; i++) await save(root, `fact-${i}`, { kind: 'claim', status: 'candidate', title: 'irrelevant detail '.repeat(60) });
  await save(root, 'cancelled', { status: 'cancelled', title: '角色已取消', text: 'Old rule must not be used.' });
  const recovery = await renderRecovery(root, { maxChars: 500 });
  assert.ok(recovery.length <= 500);
  assert.match(recovery, /\[cancelled\] \(cancelled\)/);
  assert.match(recovery, /\[accepted\] \(constraint\)/);
  assert.ok(recovery.indexOf('(cancelled)') < recovery.indexOf('(constraint)'));
  assert.ok(recovery.endsWith('[continuity] Details/records omitted; use lookup before relying on this summary.'));
  assert.ok(!recovery.includes('Critical constraint begins'), 'omit the whole constraint, never half of it');
  for (const maxChars of [1, 8, 10, 31, 78, 100, 200, 499, 501]) {
    const rendered = await renderRecovery(root, { maxChars });
    assert.ok(rendered.length <= maxChars, `${rendered.length} > ${maxChars}`);
    assert.ok(rendered === '!' || /(?:\[omitted\]|Omitted; use lookup\.|summary\.)$/.test(rendered));
  }
  const absent = await renderRecovery(path.join(tmpRoot, 'absent'), { maxChars: 10 });
  assert.ok(absent.length <= 10);
});

test('malformed or schema-invalid project marker is corrupt and never overwritten by initialize/adopt/save', async () => {
  for (const [index, content] of ['{', '{}', 'null', '[]', '{"projectId":"id"}'].entries()) {
    const root = await project(`bad-marker-${index}`);
    const marker = memoryPath(root, 'project.json');
    await fsp.writeFile(marker, content);
    const state = await readState(root);
    assert.equal(state.corrupt, true);
    assert.deepEqual(state.records, []);
    assert.ok((await resolveProject(root)).issues.some((i) => i.code === 'CORRUPT_PROJECT_FILE'));
    for (const op of [() => initializeProject(root), () => adoptProject(root),
      () => saveRecord(root, input('new'), { expectedRevision: 0 })]) {
      await assert.rejects(op, { code: 'CORRUPT_PROJECT_FILE' });
    }
    assert.equal(await fsp.readFile(marker, 'utf8'), content);
    assert.match(await renderRecovery(root), /INTEGRITY WARNING/);
    assert.equal((await lookup(root)).corrupt, true);
  }
});

test('corrupt cancellation never revives an older accepted record or regenerates partial projections', async () => {
  const root = await project('corrupt-cancel');
  await save(root, 'role');
  const cancelled = await save(root, 'role', { status: 'cancelled' });
  const projection = await fsp.readFile(memoryPath(root, 'MEMORY.md'), 'utf8');
  await fsp.writeFile(memoryPath(root, 'changes', `${cancelled.changeId}.json`), '{invalid');
  const state = await readState(root);
  assert.equal(state.corrupt, true);
  assert.deepEqual(state.records, []);
  const result = await lookup(root, { id: 'role', history: true });
  assert.equal(result.current, null);
  assert.deepEqual(result.records, []);
  const recovery = await renderRecovery(root);
  assert.match(recovery, /current facts withheld/);
  assert.ok(!recovery.includes('[accepted]'));
  await assert.rejects(regenProjections(root), { code: 'CORRUPT_JOURNAL' });
  await assert.rejects(saveRecord(root, input('other'), { expectedRevision: 2 }), { code: 'CORRUPT_JOURNAL' });
  assert.equal(await fsp.readFile(memoryPath(root, 'MEMORY.md'), 'utf8'), projection);
  for (const maxChars of [1, 9, 44, 96]) {
    const warning = await renderRecovery(root, { maxChars });
    assert.ok(warning.length <= maxChars);
    assert.ok(warning === '!' || warning === '[CORRUPT]' || warning.endsWith('.'));
  }
});

test('missing committed journal tail and valid-checksum malformed changes fail closed', async () => {
  const root = await project('journal-tail');
  await save(root, 'role');
  const cancellation = await save(root, 'role', { status: 'cancelled' });
  const tail = memoryPath(root, 'changes', `${cancellation.changeId}.json`);
  const held = await moveAside(tail);
  let state = await readState(root);
  assert.equal(state.corrupt, true);
  assert.deepEqual(state.records, []);
  await fsp.rename(held, tail);
  const change = JSON.parse(await fsp.readFile(tail, 'utf8'));
  change.record = null;
  await fsp.writeFile(tail, JSON.stringify(sign(change)));
  state = await readState(root);
  assert.equal(state.corrupt, true);
  assert.deepEqual(state.records, []);
});

test('supersession publishes atomically: injected failure before publication leaves only the prior truth', async (t) => {
  const root = await project('transaction-before');
  await save(root, 'old');
  const rename = fsp.rename;
  let observed = false;
  t.mock.method(fsp, 'rename', async (from, to) => {
    if (path.dirname(to) === memoryPath(root, 'changes') && to.endsWith('.json')) {
      observed = true;
      const state = await readState(root);
      assert.equal(state.corrupt, false);
      assert.equal(state.revision, 1);
      assert.equal(byId(state, 'old').status, 'accepted');
      assert.equal(byId(state, 'new'), undefined);
      throw new Error('injected pre-publication crash');
    }
    return rename(from, to);
  });
  await assert.rejects(saveRecord(root, input('new', { supersedes: 'old' }), { expectedRevision: 1 }), /injected pre-publication crash/);
  assert.equal(observed, true);
  t.mock.restoreAll();
  const after = await readState(root);
  assert.equal(after.revision, 1);
  assert.equal(after.records.length, 1);
  assert.equal(after.corrupt, false);
  await save(root, 'new', { supersedes: 'old' });
  assert.equal((await lookup(root, { id: 'old' })).current.id, 'new');
});

test('supersession survives crash after publication before marker/projections, then accepts effective CAS revision', async (t) => {
  const root = await project('transaction-after');
  await save(root, 'old');
  const rename = fsp.rename;
  let observed = false;
  t.mock.method(fsp, 'rename', async (from, to) => {
    if (to === memoryPath(root, 'project.json')) {
      observed = true;
      const state = await readState(root);
      assert.equal(state.corrupt, false);
      assert.equal(state.revision, 3);
      assert.equal(byId(state, 'old').status, 'superseded');
      assert.equal(byId(state, 'new').status, 'accepted');
      throw new Error('injected post-publication crash');
    }
    return rename(from, to);
  });
  await assert.rejects(saveRecord(root, input('new', { supersedes: 'old' }), { expectedRevision: 1 }), /injected post-publication crash/);
  assert.equal(observed, true);
  t.mock.restoreAll();
  assert.equal((await resolveProject(root)).revision, 3);
  await assert.rejects(saveRecord(root, input('conflict'), { expectedRevision: 1 }), { code: 'REVISION_CONFLICT' });
  await saveRecord(root, input('new', { status: 'cancelled' }), { expectedRevision: 3 });
  const state = await readState(root);
  assert.equal(state.corrupt, false);
  assert.equal(state.revision, 4);
  const found = await lookup(root, { id: 'old', history: true });
  assert.equal(found.current.status, 'cancelled');
  assert.deepEqual(found.records[0].history.map((h) => h.recordRevision), [1, 2]);
});

test('legacy separate-event supersession journals remain readable and can append after adoption', async () => {
  const root = await project('legacy-source');
  await save(root, 'old', { aliases: ['旧别名'] });
  const saved = await save(root, 'new', { supersedes: 'old' });
  const file = memoryPath(root, 'changes', `${saved.changeId}.json`);
  const transaction = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(transaction.transaction.length, 2);
  await moveAside(file);
  for (const change of transaction.transaction) {
    await fsp.writeFile(memoryPath(root, 'changes', `${change.changeId}.json`), JSON.stringify(change, null, 2) + '\n');
  }
  assert.equal((await readState(root)).corrupt, false);
  const copy = path.join(tmpRoot, 'legacy-copy');
  await fsp.cp(root, copy, { recursive: true });
  const before = await readState(copy);
  assert.equal(before.project.isolated, true);
  await adoptProject(copy);
  await save(copy, 'new', { status: 'cancelled' });
  assert.equal((await lookup(copy, { id: '旧别名' })).current.status, 'cancelled');
  assert.equal((await lookup(root, { id: '旧别名' })).current.status, 'accepted');
  assert.equal((await readState(copy)).project.projectId, before.project.projectId);
});

test('same-record CAS racing writes have exactly one winner and no lost update', async () => {
  const root = await project('cas-race');
  await save(root, 'shared');
  const results = await Promise.allSettled([
    saveRecord(root, input('shared', { status: 'cancelled' }), { expectedRevision: 1 }),
    saveRecord(root, input('shared', { title: 'revised' }), { expectedRevision: 1 }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  const state = await readState(root);
  assert.equal(state.revision, 2);
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].revision, 2);
  assert.equal(state.corrupt, false);
});

test('old lock owned by a live PID is never stolen', { timeout: 10000 }, async () => {
  const root = await project('live-lock');
  const file = memoryPath(root, '.lock');
  const fixture = JSON.stringify({ pid: process.pid, token: 'fixture-lock', createdAt: 1 });
  await fsp.writeFile(file, fixture);
  await fsp.utimes(file, new Date(0), new Date(0));
  await assert.rejects(saveRecord(root, input('blocked'), { expectedRevision: 0 }), { code: 'LOCK_TIMEOUT' });
  assert.equal(await fsp.readFile(file, 'utf8'), fixture);
  assert.equal((await readState(root)).revision, 0);
});

test('linked state roots and linked change files cannot expose another store as current truth', async () => {
  const foreign = await project('foreign-state');
  const saved = await save(foreign, 'foreign-fact');
  const linked = path.join(tmpRoot, 'linked-root');
  await fsp.mkdir(linked);
  await fsp.symlink(path.join(foreign, '.pi'), path.join(linked, '.pi'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await readState(linked)).corrupt, true);
  assert.deepEqual((await lookup(linked)).records, []);
  await assert.rejects(initializeProject(linked), { code: 'STATE_ESCAPE' });
  await assert.rejects(resolveProject(linked), { code: 'STATE_ESCAPE' });
  const root = await project('linked-change');
  const own = await save(root, 'own');
  const ownFile = memoryPath(root, 'changes', `${own.changeId}.json`);
  await moveAside(ownFile);
  await fsp.symlink(memoryPath(foreign, 'changes', `${saved.changeId}.json`), ownFile);
  const state = await readState(root);
  assert.equal(state.corrupt, true);
  assert.deepEqual(state.records, []);
  assert.ok(state.issues.some((i) => i.code === 'STATE_ESCAPE'));
});

test('every journal publication exposes a complete supersession, including a subsequent replacement chain', async (t) => {
  const root = await project('publication-visibility');
  await save(root, 'old', { aliases: ['original'] });
  const rename = fsp.rename;
  let publications = 0;
  t.mock.method(fsp, 'rename', async (from, to) => {
    await rename(from, to);
    if (path.dirname(to) === memoryPath(root, 'changes') && to.endsWith('.json')) {
      publications++;
      const state = await readState(root);
      assert.equal(state.corrupt, false);
      const replacement = byId(state, 'final') || byId(state, 'new');
      assert.ok(replacement);
      assert.equal(byId(state, 'old').tombstone, true);
      if (replacement.id === 'final') assert.equal(byId(state, 'new').tombstone, true);
      const found = await lookup(root, { id: 'original', history: true });
      assert.equal(found.current.id, replacement.id);
      assert.equal(found.records[0].history.at(-1).record.id, replacement.id);
    }
  });
  await save(root, 'new', { supersedes: 'old' });
  await save(root, 'final', { supersedes: 'new' });
  assert.equal(publications, 2);
  t.mock.restoreAll();
  await assert.rejects(save(root, 'old'), { code: 'TARGET_SUPERSEDED' });
  await assert.rejects(save(root, 'fork', { supersedes: 'old' }), { code: 'TARGET_SUPERSEDED' });
  assert.equal((await readState(root)).revision, 5);
});

test('adopting a corrupt copied journal preserves marker identity and every original record file', async () => {
  const root = await project('adopt-corrupt-source');
  const saved = await save(root, 'old');
  const copy = path.join(tmpRoot, 'adopt-corrupt-copy');
  await fsp.cp(root, copy, { recursive: true });
  const marker = memoryPath(copy, 'project.json');
  const original = await fsp.readFile(marker, 'utf8');
  const changeFile = memoryPath(copy, 'changes', `${saved.changeId}.json`);
  await fsp.writeFile(changeFile, '{broken');
  await assert.rejects(adoptProject(copy), { code: 'CORRUPT_JOURNAL' });
  assert.equal(await fsp.readFile(marker, 'utf8'), original);
  assert.equal(await fsp.readFile(changeFile, 'utf8'), '{broken');
  assert.equal((await readState(root)).corrupt, false);
});

test('hard-linked project marker is rejected before reading or overwriting it', async () => {
  const root = await project('hardlinked-marker');
  const marker = memoryPath(root, 'project.json');
  const held = await moveAside(marker);
  await fsp.link(held, marker);
  assert.equal((await readState(root)).corrupt, true);
  await assert.rejects(initializeProject(root), { code: 'STATE_ESCAPE' });
});
