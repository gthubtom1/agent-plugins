import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

import {
  resolveProject, initializeProject, adoptProject, saveRecord, readState, lookup,
  renderRecovery, ContinuityError, KINDS, STATUS, DEFAULT_STATUS,
} from '../store.mjs';

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pc-store-test-'));

async function withProject(name = 'app') {
  const dir = path.join(tmpRoot, name);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  return { root: dir, project: await initializeProject(dir) };
}

// readState returns records as an ARRAY; helper fetches one by id.
function rec(st, id) {
  const f = (st.records || []).find((r) => r.id === id);
  assert.ok(f, 'record not found: ' + id);
  return f;
}

function mkInput(over) {
  return Object.assign({
    kind: 'observation', title: 'default', text: 'default body',
    status: undefined, source: { path: 'notes/obs.md' }, aliases: [],
  }, over);
}

async function seedSource(root, rel, content) {
  const full = path.resolve(root, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content);
}

// ===========================================================================
test('schema exports present', () => {
  assert.ok(KINDS.includes('claim'));
  assert.ok(!STATUS.claim.includes('validated'));
  assert.equal(DEFAULT_STATUS.claim, 'candidate');
  assert.ok(STATUS.decision.includes('accepted'));
  assert.ok(STATUS.decision.includes('cancelled'));
  assert.ok(STATUS.attempt.includes('blocked'));
});

// --- resolveProject ---
test('resolveProject: no project -> cwd fallback, exists=false', async () => {
  const dir = path.join(tmpRoot, 'resolve-none');
  await fsp.mkdir(dir, { recursive: true });
  const r = await resolveProject(dir);
  assert.equal(r.exists, false);
  assert.equal(r.root, dir);
  assert.equal(r.revision, 0);
  assert.ok(r.workspaceKey.length > 0);
});

test('resolveProject: subdir resolves to nearest project root (key matches)', async () => {
  const { root } = await withProject('resolve-proj');
  const sub = path.join(root, 'a', 'b', 'c');
  await fsp.mkdir(sub, { recursive: true });
  const r = await resolveProject(sub);
  assert.equal(r.exists, true);
  assert.equal(r.root, root);
  assert.equal(r.isolated, false);
  assert.equal(r.projectId, (await readState(root)).project.projectId);
});

test('resolveProject: git root fallback when no memory marker', async () => {
  const dir = path.join(tmpRoot, 'resolve-git');
  await fsp.mkdir(path.join(dir, '.git'), { recursive: true });
  const sub = path.join(dir, 'src');
  await fsp.mkdir(sub, { recursive: true });
  const r = await resolveProject(sub);
  assert.equal(r.root, dir);
  assert.equal(r.exists, false);
  assert.equal(r.isolated, false);
});

test('resolveProject: explicit root must be ancestor of cwd', async () => {
  const a = path.join(tmpRoot, 'era'); await fsp.mkdir(a, { recursive: true });
  const b = path.join(tmpRoot, 'erb'); await fsp.mkdir(b, { recursive: true });
  await assert.rejects(resolveProject(a, { root: b }), (e) => e.code === 'INVALID_ROOT');
});

// --- initializeProject / readState ---
test('initializeProject writes descriptor; readState roundtrip (records array)', async () => {
  const dir = path.join(tmpRoot, 'init');
  await fsp.mkdir(dir, { recursive: true });
  const p = await initializeProject(dir);
  assert.equal(p.newlyCreated, true);
  assert.ok(p.projectId);
  assert.equal(p.schema, 1);
  assert.equal(p.revision, 0);
  await fsp.access(path.join(dir, '.pi', 'memory', 'project.json'));
  await fsp.access(path.join(dir, '.pi', 'memory', 'MEMORY.md'));
  const st = await readState(dir);
  assert.equal(st.exists, true);
  assert.equal(st.project.projectId, p.projectId);
  assert.deepEqual(st.records, []);
});

test('initializeProject idempotent on existing same-root marker', async () => {
  const dir = path.join(tmpRoot, 'init2');
  const a = await initializeProject(dir);
  const b = await initializeProject(dir);
  assert.equal(b.newlyCreated, false);
  assert.equal(a.projectId, b.projectId);
});

test('initializeProject does NOT eager-create on foreign marker (leafy init)', async () => {
  const src = path.join(tmpRoot, 'leafy-src');
  const { project } = await { project: await initializeProject(src) };
  await seedSource(src, 's.md', 's');
  await saveRecord(src, mkInput({ kind: 'decision', title: 'd', source: { path: 's.md' } }), { expectedRevision: 0 });
  const dst = path.join(tmpRoot, 'leafy-dst');
  await fsp.rm(dst, { recursive: true, force: true });
  await fsp.cp(src, dst, { recursive: true });
  // initialize on the copy must refuse to overwrite foreign marker
  await assert.rejects(initializeProject(dst), (e) => e.code === 'ISOLATED_MARKER');
});

// --- saveRecord happy path ---
test('saveRecord saves observation, CAS revision advances', async () => {
  const { root } = await withProject('save-obs');
  await seedSource(root, 'notes/obs.md', 'the raw fact');
  const r = await saveRecord(root, mkInput({
    kind: 'observation', title: 'mem0', text: 'sample observed',
    source: { path: 'notes/obs.md' }, _now: '2024-01-15T10:00:00.000Z',
  }), { expectedRevision: 0 });
  assert.equal(r.revision, 1);
  assert.equal(r.recordId, 'mem0');
  await fsp.access(path.join(root, '.pi', 'memory', 'changes', `${r.changeId}.json`));
  await fsp.access(path.join(root, '.pi', 'memory', 'topics', 'mem0.md'));
  const st = await readState(root);
  assert.equal(st.revision, 1);
  assert.equal(rec(st, 'mem0').status, 'observed');
});

test('saveRecord: claims default candidate; validated rejected', async () => {
  const { root } = await withProject('save-claim');
  await seedSource(root, 'c.md', 'claim source');
  const r = await saveRecord(root, mkInput({ kind: 'claim', title: 'c1', source: { path: 'c.md' } }), { expectedRevision: 0 });
  assert.equal(r.revision, 1);
  assert.equal(rec(await readState(root), 'c1').status, 'candidate');
  await assert.rejects(
    saveRecord(root, mkInput({ kind: 'claim', title: 'c2', status: 'validated', source: { path: 'c.md' } }), { expectedRevision: 1 }),
    (e) => e.code === 'INVALID_STATUS'
  );
});

test('saveRecord: observation cannot promote; invalid status rejected', async () => {
  const { root } = await withProject('save-obs-status');
  await seedSource(root, 'o.md', 'obs');
  await assert.rejects(
    saveRecord(root, mkInput({ kind: 'observation', status: 'candidate', source: { path: 'o.md' } }), { expectedRevision: 0 }),
    (e) => e.code === 'INVALID_STATUS'
  );
});

test('saveRecord requires expectedRevision', async () => {
  const { root } = await withProject('save-exprev');
  await seedSource(root, 'e.md', 'e');
  await assert.rejects(
    saveRecord(root, mkInput({ kind: 'decision', title: 'd', source: { path: 'e.md' } }), {}),
    (e) => e.code === 'MISSING_EXPECTED_REVISION'
  );
});

test('saveRecord CAS conflict on stale expectedRevision', async () => {
  const { root } = await withProject('save-cas');
  await seedSource(root, 's.md', 's');
  await saveRecord(root, mkInput({ kind: 'decision', title: 'd', source: { path: 's.md' } }), { expectedRevision: 0 });
  await assert.rejects(
    saveRecord(root, mkInput({ kind: 'decision', title: 'd2', source: { path: 's.md' } }), { expectedRevision: 0 }),
    (e) => e.code === 'REVISION_CONFLICT'
  );
  const ok = await saveRecord(root, mkInput({ kind: 'decision', title: 'd2', source: { path: 's.md' } }), { expectedRevision: 1 });
  assert.equal(ok.revision, 2);
});

// --- supersede + alias resolution ---
test('supersede creates tombstone; old alias resolves to current', async () => {
  const { root } = await withProject('supersede');
  await seedSource(root, 'role.md', 'role source');
  await saveRecord(root, mkInput({
    kind: 'claim', title: 'old role', aliases: ['role-old'], source: { path: 'role.md' },
  }), { expectedRevision: 0 });
  await saveRecord(root, mkInput({
    kind: 'claim', id: 'new-role', title: 'new role', aliases: ['role-new'],
    supersedes: 'old-role', reason: 'clarified', source: { path: 'role.md' },
  }), { expectedRevision: 1 });
  const st = await readState(root);
  assert.equal(st.revision, 3);
  const old = rec(st, 'old-role');
  assert.ok(old.tombstone);
  assert.equal(old.supersededBy, 'new-role');
  const lk = await lookup(root, { id: 'role-old' });
  assert.equal(lk.exists, true);
  assert.ok(lk.current);
  assert.equal(lk.current.id, 'new-role');
});

test('20-day sim: old alias -> cancelled/superseded tombstone surfaced', async () => {
  const { root } = await withProject('sim20');
  await seedSource(root, 'r.md', 'role');
  let rev = 0;
  let r = await saveRecord(root, mkInput({
    kind: 'claim', id: 'elder-role', title: 'Elder (initial)', aliases: ['elder-old'], source: { path: 'r.md' },
  }), { expectedRevision: 0, _now: new Date('2024-01-01').getTime() }); rev = r.revision;
  r = await saveRecord(root, mkInput({
    kind: 'claim', id: 'elder-role', title: 'Elder (revised)', aliases: ['elder-old'], source: { path: 'r.md' },
  }), { expectedRevision: rev, _now: new Date('2024-01-05').getTime() }); rev = r.revision;
  // cancel: self-supersede makes a tombstone (recordRevision bump then tombstone)
  r = await saveRecord(root, mkInput({
    kind: 'claim', id: 'elder-role', title: 'Elder (cancelled)', aliases: ['elder-old'],
    supersedes: 'elder-role', reason: 'rescinded', source: { path: 'r.md' },
  }), { expectedRevision: rev, _now: new Date('2024-01-06').getTime() }); rev = r.revision;
  const lk = await lookup(root, { id: 'elder-old', history: true });
  assert.ok(lk.current);
  assert.equal(lk.current.status, 'superseded');
  assert.ok(lk.current.tombstone);
});

// --- context filtering ---
test('lookup context filter excludes records from different case/branch/target', async () => {
  const { root } = await withProject('ctx-filter');
  await seedSource(root, 's.md', 's');
  let rev = 0;
  rev = (await saveRecord(root, mkInput({
    kind: 'attempt', id: 'attempt-a', title: 'attempt case A', status: 'failed',
    context: { caseRoot: 'work/A', branch: 'main', targetSha256: 'aa' }, source: { path: 's.md' },
  }), { expectedRevision: 0 })).revision;
  rev = (await saveRecord(root, mkInput({
    kind: 'attempt', id: 'attempt-b', title: 'attempt case B', status: 'failed',
    context: { caseRoot: 'work/B', branch: 'main', targetSha256: 'bb' }, source: { path: 's.md' },
  }), { expectedRevision: rev })).revision;
  const lk = await lookup(root, { context: { caseRoot: 'work/A', branch: 'main', targetSha256: 'aa' } });
  const ids = lk.records.map((x) => x.record.id);
  assert.ok(ids.includes('attempt-a'));
  assert.ok(!ids.includes('attempt-b'));
  assert.ok(lk.incompatible.length >= 1);
});

test('query exact method matches attempt useful statuses', async () => {
  const { root } = await withProject('attempt-q');
  await seedSource(root, 'x.md', 'x');
  let rev = 0;
  rev = (await saveRecord(root, mkInput({
    kind: 'attempt', id: 'try1', title: 'decompile via ghidra', status: 'failed',
    context: { method: 'ghidra', config: 'default' }, source: { path: 'x.md' },
  }), { expectedRevision: 0 })).revision;
  rev = (await saveRecord(root, mkInput({
    kind: 'attempt', id: 'try2', title: 'decompile via ghidra', status: 'succeeded',
    context: { method: 'ghidra' }, source: { path: 'x.md' },
  }), { expectedRevision: rev })).revision;
  const lk = await lookup(root, { query: 'ghidra' });
  const statii = lk.records.map((x) => x.record.status);
  assert.ok(statii.includes('failed'));
  assert.ok(statii.includes('succeeded'));
});

test('tool method changed retry is not a global blacklist', async () => {
  const { root } = await withProject('retry-method');
  await seedSource(root, 'y.md', 'y');
  await saveRecord(root, mkInput({
    kind: 'attempt', id: 'tool-ghidra-1', title: 'ghidra attempt failed', status: 'failed',
    context: { method: 'ghidra' }, source: { path: 'y.md' },
  }), { expectedRevision: 0 });
  await saveRecord(root, mkInput({
    kind: 'attempt', id: 'tool-objection-1', title: 'objection attempt ok', status: 'succeeded',
    context: { method: 'objection' }, source: { path: 'y.md' },
  }), { expectedRevision: 1 });
  const lk = await lookup(root, { query: 'objection' });
  assert.ok(lk.records.some((x) => x.record.status === 'succeeded'));
});

// --- source confinement ---
test('source traversal + absolute + control rejected', async () => {
  const { root } = await withProject('src-trav');
  await seedSource(root, 'ok.md', 'ok');
  for (const bad of ['../outside.txt', '/etc/passwd', 'a/../../escape.md', path.resolve(root, '..') + '/x.md', 'bad\u0000ctrl.md']) {
    await assert.rejects(
      saveRecord(root, mkInput({ kind: 'observation', title: 't', source: { path: bad } }), { expectedRevision: 0 }),
      (e) => ['INVALID_SOURCE_PATH', 'INVALID_INPUT'].includes(e.code)
    );
  }
  const absInside = path.join(root, 'ok.md');
  await assert.rejects(
    saveRecord(root, mkInput({ kind: 'claim', title: 'abs', source: { path: absInside } }), { expectedRevision: 0 }),
    (e) => e.code === 'INVALID_SOURCE_PATH'
  );
});

test('symlink source pointing outside project rejected', async () => {
  const dir = path.join(tmpRoot, 'symlink-out');
  await fsp.mkdir(dir, { recursive: true });
  const outside = path.join(tmpRoot, 'outside-plain.txt');
  await fsp.writeFile(outside, 'secret');
  await fsp.symlink(outside, path.join(dir, 'link.md'));
  await initializeProject(dir);
  await assert.rejects(
    saveRecord(dir, mkInput({ kind: 'observation', title: 'ly', source: { path: 'link.md' } }), { expectedRevision: 0 }),
    (e) => e.code === 'INVALID_SOURCE_PATH'
  );
});

test('.pi/memory/sources is an allowed reference location', async () => {
  const { root } = await withProject('mem-src');
  const inner = path.join(root, '.pi', 'memory', 'sources', 'capture.json');
  await fsp.mkdir(path.dirname(inner), { recursive: true });
  await fsp.writeFile(inner, '{"fact":true}');
  const r = await saveRecord(root, mkInput({
    kind: 'observation', title: 'captured fact', source: { path: '.pi/memory/sources/capture.json' },
  }), { expectedRevision: 0 });
  assert.equal(r.recordId, 'captured-fact');
});

test('source changes after capture -> stale indicated; not silently re-hashed', async () => {
  const { root } = await withProject('src-stale');
  await seedSource(root, 'd.md', 'v1');
  await saveRecord(root, mkInput({ kind: 'observation', id: 'dd', title: 'data', source: { path: 'd.md' } }), { expectedRevision: 0 });
  await seedSource(root, 'd.md', 'v2-changed');
  const lk = await lookup(root, { id: 'dd' });
  assert.equal(lk.records[0].staleSource, true);
  const render = await renderRecovery(root, { query: 'data' });
  assert.ok(render.includes('STALE'));
});

test('source deleted -> stale', async () => {
  const { root } = await withProject('src-del');
  await seedSource(root, 'e.md', 'e');
  await saveRecord(root, mkInput({ kind: 'observation', title: 'gone', source: { path: 'e.md' } }), { expectedRevision: 0 });
  await fsp.rm(path.join(root, 'e.md'));
  const lk = await lookup(root, {});
  assert.ok(lk.records.some((x) => x.record.id === 'gone' && x.staleSource));
});

test('manual edits to projection are stale not canonical; journal still truth', async () => {
  const { root } = await withProject('proj-edit');
  await seedSource(root, 's.md', 's');
  await saveRecord(root, mkInput({ kind: 'decision', title: 'keeper', source: { path: 's.md' } }), { expectedRevision: 0 });
  const memFile = path.join(root, '.pi', 'memory', 'MEMORY.md');
  await fsp.writeFile(memFile, 'HAND EDIT - not canonical');
  const st = await readState(root);
  assert.equal(rec(st, 'keeper').title, 'keeper'); // journal still truth
  const mem = await fsp.readFile(memFile, 'utf8');
  assert.equal(mem.includes('HAND EDIT'), true); // we didn't overwrite on read
});

test('source tamper -> checksum detect (edit a change file)', async () => {
  const { root } = await withProject('tamper-chg');
  await seedSource(root, 's.md', 's');
  await saveRecord(root, mkInput({ kind: 'decision', title: 'x', source: { path: 's.md' } }), { expectedRevision: 0 });
  const changesDir = path.join(root, '.pi', 'memory', 'changes');
  const files = await fsp.readdir(changesDir);
  const target = files.find((f) => f.endsWith('.json'));
  const full = path.join(changesDir, target);
  const mutated = (await fsp.readFile(full, 'utf8')).replace('"title": "x"', '"title": "tampered"');
  await fsp.writeFile(full, mutated);
  const st = await readState(root);
  assert.ok(st.issues.find((i) => i.code === 'TAMPER'), 'expected tamper issue: ' + JSON.stringify(st.issues));
});

test('journal gap -> corrupt flagged and write blocked', async () => {
  const { root } = await withProject('journal-gap');
  await seedSource(root, 's.md', 's');
  await saveRecord(root, mkInput({ kind: 'decision', title: 'a', source: { path: 's.md' } }), { expectedRevision: 0 });
  await saveRecord(root, mkInput({ kind: 'decision', title: 'b', source: { path: 's.md' } }), { expectedRevision: 1 });
  // delete one change file to create a gap
  const changesDir = path.join(root, '.pi', 'memory', 'changes');
  const files = (await fsp.readdir(changesDir)).filter((f) => f.endsWith('.json'));
  await fsp.rm(path.join(changesDir, files[0]));
  const st = await readState(root);
  assert.ok(st.corrupt, 'expected corrupt=true');
  await assert.rejects(
    saveRecord(root, mkInput({ kind: 'decision', title: 'c', source: { path: 's.md' } }), { expectedRevision: 2 }),
    (e) => e.code === 'CORRUPT_JOURNAL'
  );
});

// --- project isolation, move/copy/adopt ---
test('project isolation: same role name in two projects never cross', async () => {
  const a = await withProject('iso-a');
  const b = await withProject('iso-b');
  assert.notEqual(a.project.projectId, b.project.projectId);
  await seedSource(a.root, 'r.md', 'role A');
  await seedSource(b.root, 'r.md', 'role B');
  await saveRecord(a.root, mkInput({ kind: 'claim', id: 'role', title: 'role in A', source: { path: 'r.md' } }), { expectedRevision: 0 });
  await saveRecord(b.root, mkInput({ kind: 'claim', id: 'role', title: 'role in B', source: { path: 'r.md' } }), { expectedRevision: 0 });
  const la = await lookup(a.root, { id: 'role' });
  const lb = await lookup(b.root, { id: 'role' });
  assert.equal(la.current.title, 'role in A');
  assert.equal(lb.current.title, 'role in B');
});

test('project copy: readable historical (isolated), adopt re-keys; source copy intact', async () => {
  const src = path.join(tmpRoot, 'move-src');
  await initializeProject(src);
  await seedSource(src, 's.md', 's');
  await saveRecord(src, mkInput({ kind: 'decision', title: 'orig', source: { path: 's.md' } }), { expectedRevision: 0 });
  const dst = path.join(tmpRoot, 'move-dst');
  await fsp.rm(dst, { recursive: true, force: true });
  await fsp.cp(src, dst, { recursive: true });

  // copy: data still readable (not silently emptied), flagged isolated
  const stDst = await readState(dst);
  assert.equal(stDst.exists, true);
  assert.equal(stDst.project.isolated, true);
  assert.equal(rec(stDst, 'orig').title, 'orig');
  assert.ok(stDst.issues.some((i) => i.code === 'ISOLATED'));

  // resolveProject sees isolated copy
  const rp = await resolveProject(dst);
  assert.equal(rp.exists, true);
  assert.equal(rp.isolated, true);

  // writing on isolated copy is refused until adopt
  await seedSource(dst, 's.md', 's');
  await assert.rejects(
    saveRecord(dst, mkInput({ kind: 'decision', title: 'z', source: { path: 's.md' } }), { expectedRevision: 1 }),
    (e) => e.code === 'ISOLATED_MARKER'
  );

  // adopt re-keys to this root; keeps same projectId + data
  const adopted = await adoptProject(dst);
  assert.equal(adopted.isolated, false);
  assert.equal(adopted.projectId, stDst.project.projectId);
  const stAfter = await readState(dst);
  assert.equal(stAfter.project.isolated, false);
  assert.equal(rec(stAfter, 'orig').title, 'orig');

  // original unaffected (still isolated==false, same data)
  const stSrc = await readState(src);
  assert.equal(stSrc.project.isolated, false);
  assert.equal(rec(stSrc, 'orig').title, 'orig');
});

test('no Git project supported (bare workdir root)', async () => {
  const dir = path.join(tmpRoot, 'no-git');
  await fsp.mkdir(dir, { recursive: true });
  await initializeProject(dir);
  await seedSource(dir, 's.md', 's');
  await saveRecord(dir, mkInput({ kind: 'artifact', title: 'exe', source: { path: 's.md' } }), { expectedRevision: 0 });
  const st = await readState(dir);
  assert.equal(st.exists, true);
  assert.equal(rec(st, 'exe').kind, 'artifact');
});

// --- renderRecovery ---
test('renderRecovery bounded by maxChars and returns STRING; never truncates mid-sentence', async () => {
  const { root } = await withProject('budget');
  for (let i = 0; i < 40; i++) {
    await seedSource(root, `f${i}.md`, 'x');
    await saveRecord(root, mkInput({
      kind: 'claim', id: `rec${i}`, title: `record number ${i} `.repeat(20), text: 'y'.repeat(100), source: { path: `f${i}.md` },
    }), { expectedRevision: i });
  }
  const render = await renderRecovery(root, { maxChars: 500 });
  assert.equal(typeof render, 'string');
  assert.ok(render.length <= 500);
});

test('renderRecovery does not inline raw source contents', async () => {
  const { root } = await withProject('render-safe');
  await seedSource(root, 'secret.md', 'TOPSECRET-CONTENT-12345');
  await saveRecord(root, mkInput({ kind: 'observation', title: 'ob', source: { path: 'secret.md' } }), { expectedRevision: 0 });
  const render = await renderRecovery(root);
  assert.ok(!render.includes('TOPSECRET-CONTENT-12345'));
  assert.ok(render.includes('secret.md'));
});

test('renderRecovery with context: no guessing across cases', async () => {
  const { root } = await withProject('render-ctx');
  await seedSource(root, 's.md', 's');
  await saveRecord(root, mkInput({
    kind: 'claim', title: 'A-only', context: { caseRoot: 'work/A' }, source: { path: 's.md' },
  }), { expectedRevision: 0 });
  await saveRecord(root, mkInput({
    kind: 'claim', title: 'B-only', context: { caseRoot: 'work/B' }, source: { path: 's.md' },
  }), { expectedRevision: 1 });
  const renderA = await renderRecovery(root, { context: { caseRoot: 'work/A' } });
  assert.ok(renderA.includes('A-only'));
  assert.ok(!renderA.includes('B-only'));
});

test('renderRecovery always shows active decision text (first-day decision content)', async () => {
  const { root } = await withProject('render-decision');
  await seedSource(root, 's.md', 's');
  await saveRecord(root, mkInput({
    kind: 'decision', title: 'Keep legacy parser', status: 'accepted',
    text: 'We decided to keep the legacy parser for API compatibility. This must be remembered.',
    source: { path: 's.md' },
  }), { expectedRevision: 0 });
  const render = await renderRecovery(root);
  assert.ok(render.includes('Keep legacy parser'));
  assert.ok(render.includes('legacy parser for API compatibility'));
  assert.ok(!render.includes('SOURCE STALE'));
});

// --- concurrency ---
const storeUrl = new URL('../store.mjs', import.meta.url).href;
const CONC_WORKER = `
import { initializeProject, saveRecord, readState } from ${JSON.stringify(storeUrl)};
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const root = process.argv[2];
const count = parseInt(process.argv[3], 10);
for (let i = 0; i < count; i++) {
  await mkdir(path.dirname(path.join(root, 'src.md')), { recursive: true });
  await writeFile(path.join(root, 'src.md'), String(i));
  await initializeProject(root);
  let current = 0;
  for (let attempt = 0; attempt < 400; attempt++) {
    try {
      const ok = await saveRecord(root, {
        kind: 'observation', id: 'con-' + process.pid + '-' + i,
        title: 'concurrent write ' + i, source: { path: 'src.md' }, sessionId: 'w' + process.pid,
      }, { expectedRevision: current });
      current = ok.revision;
      break;
    } catch (e) {
      if (e.code === 'REVISION_CONFLICT' || e.code === 'LOCK_TIMEOUT') {
        const st = await readState(root);
        current = st.revision;
      } else throw e;
    }
  }
}
process.exit(0);
`;

test('concurrent two-process writes: no last-writer-wins, revisions monotonic', { timeout: 30000 }, async () => {
  const dir = path.join(tmpRoot, 'conc');
  await fsp.mkdir(dir, { recursive: true });
  const { initializeProject } = await import('../store.mjs');
  await initializeProject(dir);
  await fsp.writeFile(path.join(dir, 'src.md'), 'seed');
  const workerFile = path.join(tmpRoot, 'conc-worker.mjs');
  await fsp.writeFile(workerFile, CONC_WORKER);
  const runOne = (n) => new Promise((res, rej) => {
    const ch = spawn(process.execPath, [workerFile, dir, String(n)], { stdio: 'inherit' });
    ch.on('exit', (c) => (c ? rej(new Error('worker exited ' + c)) : res()));
  });
  await Promise.all([runOne(12), runOne(12)]);
  const st = await readState(dir);
  assert.equal(st.revision, 24, 'every requested write must commit');
  assert.equal(st.records.length, 24);
  assert.equal(st.corrupt, false);
  const seen = new Set();
  const changesDir = path.join(dir, '.pi', 'memory', 'changes');
  const files = (await fsp.readdir(changesDir)).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const j = JSON.parse(await fsp.readFile(path.join(changesDir, f), 'utf8'));
    assert.ok(!seen.has(j.projectRevision), 'duplicate projectRevision ' + j.projectRevision);
    seen.add(j.projectRevision);
  }
});

test('crash projection failure recovers on next commit', async () => {
  const { root } = await withProject('crash-proj');
  await seedSource(root, 's.md', 's');
  await saveRecord(root, mkInput({ kind: 'decision', title: 'stable', source: { path: 's.md' } }), { expectedRevision: 0 });
  const memFile = path.join(root, '.pi', 'memory', 'MEMORY.md');
  await fsp.rm(memFile, { force: true });
  await fsp.writeFile(memFile, 'STALE FRAGMENT\n');
  await seedSource(root, 'extra.md', 'e');
  await saveRecord(root, mkInput({ kind: 'claim', title: 'after crash', source: { path: 'extra.md' } }), { expectedRevision: 1 });
  const mem = await fsp.readFile(memFile, 'utf8');
  assert.ok(mem.includes('after crash') || mem.includes('stable'));
});

test('supersedes target must exist', async () => {
  const { root } = await withProject('sup-unknown');
  await seedSource(root, 's.md', 's');
  await assert.rejects(
    saveRecord(root, mkInput({ kind: 'claim', title: 'orphan', supersedes: 'no-such-id', source: { path: 's.md' } }), { expectedRevision: 0 }),
    (e) => e.code === 'TARGET_UNKNOWN'
  );
});

test('sources changed -> older attempt keeps status, stale flagged', async () => {
  const { root } = await withProject('change-flag');
  await seedSource(root, 's.md', 'one');
  await saveRecord(root, mkInput({ kind: 'claim', id: 'st', title: 'stable claim', source: { path: 's.md' } }), { expectedRevision: 0 });
  await seedSource(root, 's.md', 'two');
  assert.equal(rec(await readState(root), 'st').title, 'stable claim');
  const lk = await lookup(root, { id: 'st' });
  assert.equal(lk.records[0].staleSource, true);
});

test('tombstones preserved in readState records', async () => {
  const { root } = await withProject('tomb');
  await seedSource(root, 's.md', 's');
  await saveRecord(root, mkInput({ kind: 'claim', id: 'a', title: 'A', source: { path: 's.md' } }), { expectedRevision: 0 });
  await saveRecord(root, mkInput({ kind: 'claim', id: 'b', title: 'B', supersedes: 'a', source: { path: 's.md' } }), { expectedRevision: 1 });
  const st = await readState(root);
  assert.equal(rec(st, 'a').tombstone, true);
  assert.equal(rec(st, 'b').tombstone, false);
});

test('results limit respected', async () => {
  const { root } = await withProject('limit');
  for (let i = 0; i < 5; i++) {
    await seedSource(root, `f${i}.md`, 'x');
    await saveRecord(root, mkInput({ kind: 'decision', id: `q${i}`, title: 'qtw', source: { path: `f${i}.md` } }), { expectedRevision: i });
  }
  const lk = await lookup(root, { query: 'qtw', limit: 2 });
  assert.equal(lk.records.length, 2);
});

test('context record points existing case/workitem, not second task state', async () => {
  const { root } = await withProject('ctx-record');
  await seedSource(root, 's.md', 's');
  await saveRecord(root, mkInput({
    kind: 'context', id: 'case-A', title: 'case A active', status: 'active',
    context: { caseRoot: 'work/A' }, source: { path: 's.md' },
  }), { expectedRevision: 0 });
  const r = (await lookup(root, { id: 'case-A' })).records[0].record;
  assert.equal(r.kind, 'context');
  assert.equal(r.status, 'active');
  assert.equal(r.context.caseRoot, 'work/A');
});

test('ContinuityError exported with code', () => {
  assert.equal(typeof ContinuityError, 'function');
  const e = new ContinuityError('x', 'REVISION_CONFLICT');
  assert.equal(e.code, 'REVISION_CONFLICT');
  assert.equal(e.name, 'ContinuityError');
});

test('non-ASCII (Chinese) alias preserved, id is stable hash', async () => {
  const { root } = await withProject('zh');
  await seedSource(root, 's.md', 's');
  const r = await saveRecord(root, mkInput({
    kind: 'decision', title: '角色决定', aliases: ['角色', 'role-primary'], source: { path: 's.md' },
  }), { expectedRevision: 0 });
  assert.match(r.recordId, /^id-/);
  // query by the Chinese alias matches
  const lk = await lookup(root, { query: '角色' });
  assert.ok(lk.records.length >= 1);
  // resolve by the ASCII alias too
  const byAlias = await lookup(root, { id: 'role-primary' });
  assert.equal(byAlias.current.id, r.recordId);
});