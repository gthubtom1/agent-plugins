import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseTrashableRm, moveToTemp } from '../src/trash.mjs';

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'shell-guard-trash-')));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('one literal project-local rm target moves intact into TEMP', async () => {
  const f = await fixture();
  try {
    const cache = path.join(f.root, 'old cache');
    await mkdir(path.join(cache, 'nested'), { recursive: true });
    await writeFile(path.join(cache, 'nested', 'data.bin'), 'preserve me');
    const plan = parseTrashableRm('rm -rf "old cache"', { cwd: f.root, projectRoot: f.root });
    assert.ok(plan);
    const result = await moveToTemp(plan);
    assert.match(result.location, /^TEMP\//);
    assert.equal(await readFile(path.join(f.root, result.location, 'nested', 'data.bin'), 'utf8'), 'preserve me');
    await assert.rejects(readFile(path.join(cache, 'nested', 'data.bin')));
  } finally {
    await f.cleanup();
  }
});

test('TEMP planning rejects ambiguous, broad, outside, protected and compound rm commands', async () => {
  const f = await fixture();
  try {
    for (const command of [
      'rm -rf ../outside', 'rm -rf *.tmp', 'rm -rf "$TARGET"', 'rm -rf TEMP',
      'rm -rf a.tmp b.tmp', 'rm -rf a.tmp && echo done', 'timeout 3 rm -rf a.tmp',
      'rm -rf a.tmp a.tmp/nested', 'rm -rf .git', 'rm -rf temp', 'rm -rf TeMp/file',
      'rm --unknown a.tmp', 'rm --preserve-root a.tmp', 'rm "unclosed', 'rm a.tmp )',
      'rm -rf link/../cache', 'rm -rf "link/.. /cache"',
      'rm -rf db/child', 'rm -rf app.sqlite3/cache',
      'rm -rf db', 'rm -rf data/storage', 'rm app.db', 'rm app.sqlite', 'rm app.sqlite3',
      'rm -rf "$HOME/cache"', 'rm -rf D:\\work\\cache',
    ]) assert.equal(parseTrashableRm(command, { cwd: f.root, projectRoot: f.root }), null, command);
    assert.ok(parseTrashableRm('rm -rf ./cache', { cwd: f.root, projectRoot: f.root }));
  } finally {
    await f.cleanup();
  }
});

test('existing TEMP contents are left untouched and a missing forced target is a no-op', async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.root, 'TEMP'));
    await writeFile(path.join(f.root, 'TEMP', 'keep.txt'), 'owned');
    const cache = path.join(f.root, 'cache');
    await writeFile(cache, 'cache');
    const result = await moveToTemp(parseTrashableRm('rm -f cache', { cwd: f.root, projectRoot: f.root }));
    const batches = await readdir(path.join(f.root, 'TEMP'));
    assert.equal(batches.length, 2);
    assert.equal(await readFile(path.join(f.root, 'TEMP', 'keep.txt'), 'utf8'), 'owned');
    assert.equal(await readFile(path.join(f.root, result.location), 'utf8'), 'cache');
    const missing = parseTrashableRm('rm -f missing', { cwd: f.root, projectRoot: f.root });
    assert.deepEqual(await moveToTemp(missing), { location: null, moved: false });
    const required = parseTrashableRm('rm missing', { cwd: f.root, projectRoot: f.root });
    await assert.rejects(moveToTemp(required), /original rm was not run/);
  } finally {
    await f.cleanup();
  }
});

test('execution rechecks forged protected targets and rejects target/parent/TEMP links', async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.root, 'folder'));
    await writeFile(path.join(f.root, 'folder', 'keep.txt'), 'keep');
    for (const name of ['.git', 'TEMP', 'temp', 'db', 'app.sqlite3']) {
      await assert.rejects(moveToTemp({root:f.root,target:path.join(f.root,name),force:true}), /cannot be moved automatically/);
    }
    await symlink(path.join(f.root, 'folder'), path.join(f.root, 'alias'), 'junction');
    await assert.rejects(moveToTemp({root:f.root,target:path.join(f.root,'alias'),force:false}), /link\/junction/);
    await assert.rejects(moveToTemp({root:f.root,target:path.join(f.root,'alias','keep.txt'),force:false}), /Not a plain directory/);
    await symlink(path.join(f.root, 'folder'), path.join(f.root, 'TEMP'), 'junction');
    await assert.rejects(moveToTemp({root:f.root,target:path.join(f.root,'folder'),force:false}), /Not a plain directory/);
    assert.equal(await readFile(path.join(f.root,'folder','keep.txt'),'utf8'),'keep');
  } finally { await f.cleanup(); }
});

test('whole directory rename preserves nested database names and link contents', async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.root,'dist','db'),{recursive:true});
    await writeFile(path.join(f.root,'dist','db','keep.sqlite'),'database bytes');
    await mkdir(path.join(f.root,'reference'));
    await symlink(path.join(f.root,'reference'),path.join(f.root,'dist','link'),'junction');
    const moved=await moveToTemp(parseTrashableRm('rm -rf dist',{cwd:f.root}));
    assert.equal(await readFile(path.join(f.root,moved.location,'db','keep.sqlite'),'utf8'),'database bytes');
  } finally { await f.cleanup(); }
});
