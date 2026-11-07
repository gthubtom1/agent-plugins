import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { saveRecord, readState, lookup, renderRecovery } from '../store.mjs';
import { harness, text } from './runtime-harness.mjs';

async function setup(t, kind = 'context', runtime = false) {
  const h = await harness(t);
  await fs.mkdir(path.join(h.cwd, 'work/a'), { recursive: true });
  await fs.writeFile(path.join(h.cwd, 'work/a/scope.md'), 'Isolated copy only.');
  await fs.writeFile(path.join(h.cwd, 'work/a/Evidence.md'), 'Partial coverage; not complete.');
  await fs.writeFile(path.join(h.cwd, 'current.md'), 'Current cancellation/retirement instruction.');
  const record = { id: 'scoped-rule', kind, status: kind === 'decision' ? 'accepted' : 'active',
    title: 'Old scoped rule', text: 'OLD ACTIVE FACT', source: { path: 'current.md' },
    context: { caseRoot: 'work/a', targetSha256: 'a'.repeat(64) },
    pointers: [{ role: 'evidence', path: 'work/a/Evidence.md' }] };
  if (runtime) await h.call('continuity_save', { expectedRevision: 0, record });
  else await saveRecord(h.cwd, record, { expectedRevision: 0 });
  const original = (await readState(h.cwd)).records[0];
  const tombstone = { id: original.id, kind, status: kind === 'decision' ? 'cancelled' : 'retired',
    title: 'Closed scoped record', text: 'Withdrawn; no active facts remain.',
    context: original.context, source: { path: 'current.md' } };
  return { h, original, tombstone };
}

for (const kind of ['decision', 'context']) {
  for (const missing of ['scope', 'case']) {
    test(`allows scoped ${kind} tombstone after ${missing} removal without reading old references`, async t => {
      const { h, original, tombstone } = await setup(t, kind);
      const from = path.join(h.cwd, missing === 'scope' ? 'work/a/scope.md' : 'work/a');
      await fs.rename(from, `${from}.held`);
      if (missing === 'scope') await fs.writeFile(path.join(h.cwd, 'work/a/Evidence.md'), 'Changed source must not be rehashed for a tombstone.');
      // Retaining pointers requires their original hashes; omitting them is also allowed.
      if (kind === 'decision') tombstone.pointers = original.pointers;
      let caseReads = 0;
      const lstat = fs.lstat;
      t.mock.method(fs, 'lstat', async (file, ...args) => {
        if (String(file).startsWith(path.join(h.cwd, 'work/a'))) caseReads++;
        return lstat(file, ...args);
      });
      await saveRecord(h.cwd, tombstone, { expectedRevision: 1 });
      assert.equal(caseReads, 0, 'closing a record must not probe its old case or pointers');
      t.mock.restoreAll();
      const current = (await readState(h.cwd)).records[0];
      assert.equal(current.status, tombstone.status);
      assert.equal(current.tombstone, true);
      assert.deepEqual(current.pointers, kind === 'decision' ? original.pointers : undefined);
      const found = await lookup(h.cwd, { id: 'Old scoped rule', context: original.context, history: true });
      assert.equal(found.current.status, tombstone.status);
      assert.equal(found.records[0].history.length, 2);
      const recovery = await renderRecovery(h.cwd, { context: original.context });
      assert.ok(recovery.includes(`[${tombstone.status}]`));
      assert.doesNotMatch(recovery, /OLD ACTIVE FACT/);
    });
  }
}

for (const kind of ['decision', 'context']) {
  test(`runtime closes missing-case ${kind} using a fresh current-branch source`, async t => {
    const { h, original, tombstone } = await setup(t, kind, true);
    await fs.rename(path.join(h.cwd, 'work/a'), path.join(h.cwd, 'work/a.held'));
    h.entries.push({ type: 'message', id: 'close-now', message: { role: 'user', content: 'Cancel or retire this exact original record now.' } });
    const readdir = fs.readdir;
    t.mock.method(fs, 'readdir', async (file, ...args) => {
      assert.notEqual(String(file), path.join(h.cwd, 'work'), 'tombstone save must not rediscover removed cases');
      return readdir(file, ...args);
    });
    const result = await h.call('continuity_save', { expectedRevision: 1, sourceEntryId: 'close-now',
      record: { ...tombstone, source: undefined, pointers: original.pointers } });
    assert.equal(JSON.parse(text(result)).saved.revision, 2);
    t.mock.restoreAll();
    const current = (await readState(h.cwd)).records[0];
    assert.equal(current.status, tombstone.status);
    assert.match(current.source.path, /^\.pi\/memory\/sources\/.*\.json$/);
    assert.deepEqual(current.pointers, original.pointers);
  });
}

test('missing-case tombstone exception cannot change identity, invent pointers, or weaken source/CAS checks', async t => {
  const { h, original, tombstone } = await setup(t);
  await fs.rename(path.join(h.cwd, 'work/a'), path.join(h.cwd, 'work/a.held'));
  const pointer = original.pointers[0];
  const invalid = [
    { id: 'nonexistent' },
    { context: {} },
    { context: { caseRoot: 'work/a' } },
    { context: { ...original.context, caseRoot: 'work/b' } },
    { context: { ...original.context, caseRoot: 'work/../work/a' } },
    { context: { ...original.context, targetSha256: 'b'.repeat(64) } },
    { context: { ...original.context, branch: 'foreign-branch' } },
    { kind: 'decision', status: 'cancelled' },
    { supersedes: original.id },
    { pointers: [{ role: pointer.role, path: pointer.path }] },
    { pointers: [{ ...pointer, sha256: 'f'.repeat(64) }] },
    { pointers: [{ ...pointer, path: 'work/a/new-proof.md' }] },
    { pointers: [{ ...pointer, role: 'authorization' }] },
    { source: { path: '../outside.md' } },
    { source: { path: 'missing-current.md' } },
    { source: { path: 'current.md', sha256: 'f'.repeat(64) } },
  ];
  for (const extra of invalid) {
    await assert.rejects(saveRecord(h.cwd, { ...tombstone, ...extra }, { expectedRevision: 1 }));
    assert.equal((await readState(h.cwd)).revision, 1);
  }
  await assert.rejects(saveRecord(h.cwd, tombstone, { expectedRevision: 0 }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(saveRecord(h.cwd, { ...tombstone, status: 'active', pointers: original.pointers }, { expectedRevision: 1 }), { code: 'INVALID_CASE' });
  await saveRecord(h.cwd, tombstone, { expectedRevision: 1 });
  assert.equal((await readState(h.cwd)).corrupt, false);
});

test('a cancellation after case removal remains terminal if the case later returns', async t => {
  const { h, original, tombstone } = await setup(t, 'decision');
  await fs.rename(path.join(h.cwd, 'work/a'), path.join(h.cwd, 'work/a.held'));
  await saveRecord(h.cwd, tombstone, { expectedRevision: 1 });
  await fs.rename(path.join(h.cwd, 'work/a.held'), path.join(h.cwd, 'work/a'));
  await assert.rejects(saveRecord(h.cwd, { ...tombstone, status: 'accepted', pointers: original.pointers }, { expectedRevision: 2 }), { code: 'CANCELLED_TERMINAL' });
  assert.equal((await readState(h.cwd)).records[0].status, 'cancelled');
});
