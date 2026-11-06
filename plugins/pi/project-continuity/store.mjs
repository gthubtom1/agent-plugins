// project-continuity/store.mjs
// Project-local continuity store. Pure Node built-ins, no DB/deps.
// Source of truth: immutable append-only JSON journal under .pi/memory/changes/.
// MEMORY.md and topics/<id>.md are projections rebuilt from the journal (can be
// discarded/rebuilt; manual edits are treated as stale, never canonical).
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const SCHEMA = 1;
const FORMAT_VERSION = 1;
const MEMORY_DIR = path.join('.pi', 'memory');
const CHANGES_DIR = 'changes';
const TOPICS_DIR = 'topics';
const SOURCES_DIR = 'sources';
const ARCHIVE_DIR = 'archive';
const PROJECT_FILE = 'project.json';
const LOCK_FILE = '.lock';
const STALE_LOCK_MS = 5000;
const MAX_SOURCE_BYTES = 5 * 1024 * 1024; // 5 MB explicit cap for source hashing

// ---------------------------------------------------------------------------
// Errors / schema
// ---------------------------------------------------------------------------
export class ContinuityError extends Error {
  constructor(message, code = 'ERR_CONTINUITY') {
    super(message);
    this.name = 'ContinuityError';
    this.code = code;
  }
}

export const KINDS = Object.freeze([
  'decision', 'observation', 'claim', 'attempt', 'artifact', 'context',
]);

export const STATUS = Object.freeze({
  claim: ['candidate'],
  decision: ['proposed', 'accepted', 'cancelled', 'superseded'],
  observation: ['observed'],
  attempt: ['failed', 'succeeded', 'blocked'],
  artifact: ['candidate', 'observed', 'failed', 'retired'],
  context: ['active', 'retired'],
});

export const DEFAULT_STATUS = Object.freeze({
  claim: 'candidate',
  decision: 'proposed',
  observation: 'observed',
  attempt: 'failed',
  artifact: 'candidate',
  context: 'active',
});

const CONTEXT_KEYS = ['caseRoot', 'branch', 'targetSha256', 'method', 'config', 'question'];
const TOMBSTONE_STATUS = ['superseded', 'cancelled', 'retired', 'rejected'];
const FATAL_ISSUES = new Set(['TAMPER', 'PARSE_ERROR', 'CORRUPT', 'SOURCE_ESCAPE', 'STATE_ESCAPE']);

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function fail(message, code) {
  throw new ContinuityError(message, code);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sha256File = (file) => new Promise((resolve, reject) => {
  const h = createHash('sha256');
  const s = fs.createReadStream(file);
  s.on('data', (d) => h.update(d));
  s.on('end', () => resolve(h.digest('hex')));
  s.on('error', reject);
});
const sha256FileBounded = (file, maxBytes) => new Promise((resolve, reject) => {
  const h = createHash('sha256');
  let size = 0;
  const s = fs.createReadStream(file);
  s.on('data', (d) => {
    size += d.length;
    if (size > maxBytes) { s.destroy(); reject(new ContinuityError('source too large', 'SOURCE_TOO_LARGE')); return; }
    h.update(d);
  });
  s.on('end', () => resolve({ hash: h.digest('hex'), size }));
  s.on('error', reject);
});

function nowVal(clock) {
  if (clock !== undefined) {
    if (clock instanceof Date) return clock.toISOString();
    if (typeof clock === 'number') return new Date(clock).toISOString();
    if (typeof clock === 'string') return new Date(clock).toISOString();
  }
  return new Date().toISOString();
}

// Stable logical id: ASCII stays as a readable slug; non-ASCII (e.g. Chinese)
// becomes a deterministic truncated hash for filenames; collisions remain possible.
function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}
function encodeId(str) {
  const s = String(str).trim();
  if (s === '') return 'item';
  const norm = s.toLowerCase().normalize('NFKC');
  // pure-ASCII -> readable slug; any non-ASCII rune (e.g. Chinese) -> stable hash
  let ascii = true;
  for (let i = 0; i < norm.length; i++) { if (norm.charCodeAt(i) > 127) { ascii = false; break; } }
  if (ascii) return slugify(norm);
  return 'id-' + createHash('sha256').update(s).digest('hex').slice(0, 24);
}

function wp(root) {
  return { memoryDir: path.join(root, MEMORY_DIR),
           changesDir: path.join(root, MEMORY_DIR, CHANGES_DIR),
           topicsDir: path.join(root, MEMORY_DIR, TOPICS_DIR),
           archiveDir: path.join(root, MEMORY_DIR, ARCHIVE_DIR),
           sourcesDir: path.join(root, MEMORY_DIR, SOURCES_DIR) };
}

// Returns parsed object; on failure returns { __enoent: true } for a missing
// file, otherwise { __error: <msg> } for parse/IO errors.
async function readJsonSafe(file) {
  let buf;
  try {
    buf = await fsp.readFile(file);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { __enoent: true };
    return { __error: String(e && e.message || e) };
  }
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return { __error: String(e && e.message || e) };
  }
}

// State files must never redirect reads/writes into another project's store.
async function guardStatePath(root, relative) {
  let current = path.resolve(root);
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let st;
    try { st = await fsp.lstat(current); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (st.isSymbolicLink() || (st.isFile() && st.nlink > 1)) {
      fail('Linked continuity state is not allowed', 'STATE_ESCAPE');
    }
  }
}

async function readProjectFile(root) {
  await guardStatePath(root, path.join(MEMORY_DIR, PROJECT_FILE));
  const pf = await readJsonSafe(path.join(root, MEMORY_DIR, PROJECT_FILE));
  if (pf?.__enoent || pf?.__error) return pf;
  if (!pf || typeof pf !== 'object' || Array.isArray(pf) ||
      pf.schema !== SCHEMA || pf.formatVersion !== FORMAT_VERSION ||
      typeof pf.projectId !== 'string' || !pf.projectId.trim() ||
      typeof pf.workspaceKey !== 'string' || !/^[a-f0-9]{32}$/.test(pf.workspaceKey) ||
      !Number.isSafeInteger(pf.revision) || pf.revision < 0) {
    return { __error: 'invalid project marker schema' };
  }
  return pf;
}

async function pathExists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function writeFileAtomic(file, data, mode = 0o644) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.tmp-${process.pid}-${randomUUID().slice(0, 8)}`);
  let fh = null;
  try {
    fh = await fsp.open(tmp, 'wx', mode);
    await fh.writeFile(data);
    await fh.sync();
    await fh.close();
    fh = null;
    await fsp.rename(tmp, file);
  } finally {
    if (fh) await fh.close().catch(() => {});
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// workspace key (actual root; case-folding only on win32)
// ---------------------------------------------------------------------------
async function realpathSafe(p) {
  try { return await fsp.realpath(p); } catch { return path.resolve(p); }
}
async function workspaceKeyFor(root) {
  const real = await realpathSafe(root);
  let norm = real.split(path.sep).join('/');
  if (process.platform === 'win32') norm = norm.toLowerCase();
  return sha256(norm).slice(0, 32);
}

async function resolveRootPath(cwd, explicitRoot) {
  const absCwd = path.resolve(cwd);
  if (explicitRoot === undefined || explicitRoot === null) return absCwd;
  const realCwd = await realpathSafe(absCwd);
  const realRoot = await realpathSafe(path.resolve(explicitRoot));
  const rel = path.relative(realRoot, realCwd);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return realRoot;
  fail('Explicit root must be an ancestor of cwd', 'INVALID_ROOT');
}

function isGitRoot(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}
function isPkgMarker(dir) {
  return fs.existsSync(path.join(dir, 'package.json')) ||
    fs.existsSync(path.join(dir, 'pyproject.toml')) ||
    fs.existsSync(path.join(dir, 'go.mod')) ||
    fs.existsSync(path.join(dir, 'Cargo.toml')) ||
    fs.existsSync(path.join(dir, 'Cargo.lock')) ||
    fs.existsSync(path.join(dir, 'composer.json')) ||
    fs.existsSync(path.join(dir, 'pom.xml')) ||
    fs.existsSync(path.join(dir, 'csproj'));
}

// Nearest project marker, NOT crossing a nested independent Git/package boundary.
async function findNearestMarker(start) {
  let cur = start;
  for (;;) {
    await guardStatePath(cur, path.join(MEMORY_DIR, PROJECT_FILE));
    const file = path.join(cur, MEMORY_DIR, PROJECT_FILE);
    if (await pathExists(file)) return { root: cur, file };
    // a git/package boundary here means we must not climb into an outer repo
    if (isGitRoot(cur) || isPkgMarker(cur)) return null;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// Nearest Git root / package marker, stopping at first boundary.
async function findNearestGitOrPkg(start) {
  let cur = start;
  for (;;) {
    if (isGitRoot(cur) || isPkgMarker(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// effective revision = max projectRevision across journal (truth, read-only)
async function readEffectiveRevision(changesDir) {
  const root = path.dirname(path.dirname(path.dirname(changesDir)));
  await guardStatePath(root, path.join(MEMORY_DIR, CHANGES_DIR));
  const journal = await readJournal(changesDir);
  return journal.corrupt ? 0 : journal.maxRev;
}

// ---------------------------------------------------------------------------
// resolveProject — READ ONLY, never writes.
// ---------------------------------------------------------------------------
export async function resolveProject(cwd, { root: explicitRoot } = {}) {
  const start = path.resolve(cwd);
  const resolved = explicitRoot !== undefined && explicitRoot !== null
    ? await resolveRootPath(start, explicitRoot)
    : start;

  // effective root: explicitRoot OR nearest marker (boundary-respecting) OR
  // nearest git/package boundary OR cwd.
  const marker = explicitRoot !== undefined && explicitRoot !== null
    ? (await guardStatePath(resolved, path.join(MEMORY_DIR, PROJECT_FILE)),
       await pathExists(path.join(resolved, MEMORY_DIR, PROJECT_FILE))
         ? { root: resolved, file: path.join(resolved, MEMORY_DIR, PROJECT_FILE) } : null)
    : await findNearestMarker(resolved);
  let projectRoot = explicitRoot !== undefined && explicitRoot !== null
    ? resolved
    : (marker ? marker.root : await findNearestGitOrPkg(resolved));
  if (!projectRoot) projectRoot = resolved;

  const workspaceKey = await workspaceKeyFor(projectRoot);
  const memoryDir = path.join(projectRoot, MEMORY_DIR);
  let projectId;
  let revision = 0;
  let exists = false;
  let isolated = false;
  let markerFound = !!marker;
  let issues = [];

  if (marker) {
    const pf = await readProjectFile(marker.root);
    const storedKey = pf && pf.workspaceKey;
    if (pf && pf.__error) {
      issues.push({ code: 'CORRUPT_PROJECT_FILE', message: `unreadable ${PROJECT_FILE}` });
    } else if (!pf || pf.__enoent) {
      /* marker vanished; treat as no project */
    } else if (pf.projectId) {
      projectId = pf.projectId;
      exists = true;
      if (Number.isInteger(pf.revision)) revision = pf.revision;
      const eff = await readEffectiveRevision(path.join(marker.root, MEMORY_DIR, CHANGES_DIR));
      if (eff > revision) revision = eff;
      isolated = !(storedKey && storedKey === workspaceKey);
    }
  }

  return {
    root: projectRoot, memoryDir, exists, workspaceKey,
    markerFound, projectId: projectId || undefined,
    isolated, pendingIsolation: isolated,
    revision: exists ? revision : 0, issues,
  };
}

// ---------------------------------------------------------------------------
// initializeProject — explicit only.
// ---------------------------------------------------------------------------
async function writeProjectFile(descriptor) {
  const d = wp(descriptor.root);
  for (const dir of [CHANGES_DIR, TOPICS_DIR, SOURCES_DIR, ARCHIVE_DIR]) {
    await guardStatePath(descriptor.root, path.join(MEMORY_DIR, dir));
  }
  await fsp.mkdir(d.changesDir, { recursive: true });
  await fsp.mkdir(d.topicsDir, { recursive: true });
  await fsp.mkdir(d.sourcesDir, { recursive: true });
  await fsp.mkdir(d.archiveDir, { recursive: true });
  const file = path.join(d.memoryDir, PROJECT_FILE);
  await writeFileAtomic(file, JSON.stringify({
    schema: SCHEMA,
    formatVersion: FORMAT_VERSION,
    root: descriptor.root,
    projectId: descriptor.projectId,
    workspaceKey: descriptor.workspaceKey,
    revision: 0,
    created: nowVal(descriptor._now),
  }, null, 2) + '\n');
  await regenProjections(descriptor.root, { memoryDir: d.memoryDir });
}

async function loadProjectDescriptor(rootAbs) {
  const workspaceKey = await workspaceKeyFor(rootAbs);
  const d = wp(rootAbs);
  const file = path.join(d.memoryDir, PROJECT_FILE);
  const pf = await readProjectFile(rootAbs);
  if (pf && pf.__enoent) {
    return { state: { error: false, absent: true }, absent: true, pf: null, d, file, workspaceKey };
  }
  if (!pf || !pf.projectId) {
    return { state: { error: pf?.__error || 'invalid project marker', absent: false },
      absent: false, pf: null, d, file, workspaceKey };
  }
  let revision = Number.isInteger(pf.revision) ? pf.revision : 0;
  const eff = await readEffectiveRevision(d.changesDir);
  if (eff > revision) revision = eff;
  return {
    state: { error: false, absent: false }, absent: false, pf, d, file, workspaceKey,
    projectId: pf.projectId, revision,
  };
}

export async function initializeProject(root, opts = {}) {
  const rootAbs = path.resolve(root);
  await guardStatePath(rootAbs, MEMORY_DIR);
  const release = await acquireLock(path.join(rootAbs, MEMORY_DIR));
  try { return await initializeProjectUnlocked(rootAbs, opts); }
  finally { await release(); }
}

async function initializeProjectUnlocked(root, opts = {}) {
  const rootAbs = path.resolve(root);
  const { pf, d, file, absent, state, workspaceKey, projectId, revision } =
    await loadProjectDescriptor(rootAbs);

  if (!absent && pf && pf.projectId) {
    if (pf.workspaceKey === workspaceKey) {
      // existing, matches this root — return, don't rewrite.
      return {
        root: rootAbs, memoryDir: d.memoryDir, exists: true,
        projectId, workspaceKey, schema: pf.schema || SCHEMA,
        formatVersion: pf.formatVersion || FORMAT_VERSION, revision, created: pf.created,
        newlyCreated: false,
      };
    }
    // Foreign marker (moved/copied). Do NOT silently overwrite or drop changes.
    fail('A project marker already exists here with a different workspace key. ' +
      'Call adoptProject(root) to recover/move it explicitly; refusing to create a fresh project over it.',
      'ISOLATED_MARKER');
  }
  if (state.error) {
    fail(`Cannot initialize: unreadable ${PROJECT_FILE}: ${state.error}`, 'CORRUPT_PROJECT_FILE');
  }
  // absent (no marker at all) is fine — fresh initialization.

  const newKey = await workspaceKeyFor(rootAbs);
  const descriptor = {
    root: rootAbs, projectId: randomUUID(), workspaceKey: newKey,
    schema: SCHEMA, formatVersion: FORMAT_VERSION,
    created: nowVal(opts._now), revision: 0, _now: opts._now,
  };
  await writeProjectFile(descriptor);
  return {
    root: rootAbs, memoryDir: d.memoryDir, exists: true,
    projectId: descriptor.projectId, workspaceKey: newKey, schema: SCHEMA,
    formatVersion: FORMAT_VERSION, revision: 0,
    created: descriptor.created, newlyCreated: true,
  };
}

// Explicit adoption of a moved/copied project: recover the SAME data (projectId
// kept, journal reused) but re-key to the actual root. Copies then remain
// isolated by distinct workspaceKey while still readable/historical.
export async function adoptProject(root, opts = {}) {
  const rootAbs = path.resolve(root);
  const { pf, d, file, absent, state, workspaceKey, projectId, revision } =
    await loadProjectDescriptor(rootAbs);
  if (state.error) fail(`Cannot adopt unreadable ${PROJECT_FILE}`, 'CORRUPT_PROJECT_FILE');
  if (absent || !pf || !pf.projectId) {
    fail('No project marker to adopt; initialize first', 'PROJECT_NOT_FOUND');
  }
  if (pf.workspaceKey === workspaceKey) {
    return {
      root: rootAbs, memoryDir: d.memoryDir, exists: true, projectId,
      workspaceKey, schema: pf.schema || SCHEMA, formatVersion: pf.formatVersion || FORMAT_VERSION,
      revision, created: pf.created, isolated: false,
    };
  }
  const release = await acquireLock(d.memoryDir);
  try {
    // Validate before re-keying: failed adoption must preserve the old identity.
    const before = await readState(rootAbs);
    if (before.corrupt) fail('Cannot adopt a corrupt store', 'CORRUPT_JOURNAL');
    // re-read under lock
    const { pf: pf2, workspaceKey: key2 } = await loadProjectDescriptor(rootAbs);
    if (!pf2 || !pf2.projectId) { fail('Project vanished during adopt', 'PROJECT_NOT_FOUND'); }
    if (pf2.workspaceKey === key2) {
      // someone else adopted; fine
    } else {
      pf2.workspaceKey = key2;
      pf2.adoptedAt = nowVal(opts._now);
      await writeFileAtomic(file, JSON.stringify(pf2, null, 2) + '\n');
    }
    await regenProjections(rootAbs, { memoryDir: d.memoryDir });
    return {
      root: rootAbs, memoryDir: d.memoryDir, exists: true, projectId: pf2.projectId,
      workspaceKey: key2, schema: pf2.schema || SCHEMA, formatVersion: pf2.formatVersion || FORMAT_VERSION,
      revision: (await loadProjectDescriptor(rootAbs)).revision, created: pf2.created, isolated: false,
    };
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------------------
// locking — token+PID+lease; only break when PID dead AND token unchanged.
// ---------------------------------------------------------------------------
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

async function acquireLock(memoryDir, { timeoutMs = 4000, staleMs = STALE_LOCK_MS } = {}) {
  await guardStatePath(path.dirname(path.dirname(memoryDir)), path.join(MEMORY_DIR, LOCK_FILE));
  await fsp.mkdir(memoryDir, { recursive: true });
  const lockFile = path.join(memoryDir, LOCK_FILE);
  const token = randomUUID();
  const pid = process.pid;
  const now = Date.now();
  const deadline = now + timeoutMs;
  for (;;) {
    try {
      const fh = await fsp.open(lockFile, 'wx', 0o600);
      await fh.writeFile(JSON.stringify({ token, pid, createdAt: Date.now() }));
      await fh.close();
      return async () => {
        try {
          const cur = await readJsonSafe(lockFile);
          if (cur && cur.token === token) await fsp.rm(lockFile, { force: true });
        } catch { /* already gone */ }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Only sabotage a lock if its owner PID is dead AND token unchanged AND
      // the lock is older than staleMs (lease). A live PID never loses the lock.
      const cur = await readJsonSafe(lockFile);
      const ownerDead = !isPidAlive(cur && cur.pid);
      let ageOk = false;
      try {
        const st = await fsp.stat(lockFile);
        ageOk = Date.now() - st.mtimeMs > staleMs;
      } catch { ageOk = true; }
      if (ownerDead && ageOk && cur && typeof cur.token === 'string') {
        // verify the file still holds the same token before removing
        const again = await readJsonSafe(lockFile);
        if (again && again.token === cur.token) {
          await fsp.rm(lockFile, { force: true }).catch(() => {});
          continue;
        }
      }
      if (Date.now() >= deadline) {
        fail('Lock acquisition timed out; another session holds the write lock', 'LOCK_TIMEOUT');
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

// ---------------------------------------------------------------------------
// source confinement / hashing (project-relative, traversal/abs/control reject)
// ---------------------------------------------------------------------------
function isControl(p) {
  return /[\u0000-\u001f\u007f]/.test(p);
}
function normRel(rel) {
  return rel.split(path.sep).join('/').replace(/^\.\//, '');
}

// Returns stored canonical rel path, or throws. `mustExist` controls whether a
// missing file is a hard error (capture) or a non-fatal result (staleness check).
async function confineSource(root, srcPath, { mustExist = true } = {}) {
  if (typeof srcPath !== 'string' || srcPath.length === 0) {
    fail('source.path is required', 'INVALID_SOURCE_PATH');
  }
  if (isControl(srcPath)) fail('source.path contains control characters', 'INVALID_SOURCE_PATH');
  if (path.isAbsolute(srcPath)) {
    fail(`source.path must be project-relative, got absolute: ${srcPath}`, 'INVALID_SOURCE_PATH');
  }
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, srcPath);
  const rel = path.relative(rootAbs, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    fail(`source.path escapes project root: ${srcPath}`, 'INVALID_SOURCE_PATH');
  }
  const realRoot = await realpathSafe(rootAbs);
  let realTarget = null;
  try { realTarget = await fsp.realpath(target); } catch { realTarget = null; }
  if (realTarget) {
    const rrel = path.relative(realRoot, realTarget);
    if (rrel === '' || rrel.startsWith('..') || path.isAbsolute(rrel)) {
      fail(`source.path resolves outside project (symlink/junction): ${srcPath}`, 'INVALID_SOURCE_PATH');
    }
  }
  return normRel(rel);
}

async function computeSourceHash(rootAbs, relSrc) {
  const full = path.resolve(rootAbs, relSrc);
  let st;
  try { st = await fsp.stat(full); }
  catch { fail(`source file missing: ${relSrc}`, 'SOURCE_MISSING'); }
  if (!st.isFile()) fail(`source is not a file: ${relSrc}`, 'SOURCE_MISSING');
  if (st.size > MAX_SOURCE_BYTES) fail(`source too large (>${MAX_SOURCE_BYTES} bytes): ${relSrc}`, 'SOURCE_TOO_LARGE');
  try {
    return await sha256FileBounded(full, MAX_SOURCE_BYTES);
  } catch (e) {
    if (e instanceof ContinuityError) throw e;
    fail(`cannot hash source: ${e && e.message || e}`, 'SOURCE_IO');
  }
}

async function markStale(rootAbs, rec) {
  if (!rec || !rec.source || !rec.source.path) return true;
  const rootAbsP = path.resolve(rootAbs);
  // re-confine post-write (a file could have been replaced by a symlink out)
  let rel;
  try { rel = await confineSource(rootAbsP, rec.source.path, { mustExist: false }); }
  catch { return true; } // now escapes -> stale
  const full = path.resolve(rootAbsP, rel);
  let st;
  try { st = await fsp.stat(full); }
  catch { return true; }
  if (!st.isFile()) return true;
  if (st.size > MAX_SOURCE_BYTES) return true;
  if (rec.source.sha256) {
    let h;
    try { h = (await sha256FileBounded(full, MAX_SOURCE_BYTES)).hash; }
    catch { return true; }
    return h !== rec.source.sha256;
  }
  return true;
}

// ---------------------------------------------------------------------------
// input validation / normalization
// ---------------------------------------------------------------------------
function validateKind(kind) {
  if (!KINDS.includes(kind)) fail(`invalid kind: ${kind}`, 'INVALID_KIND');
}
function normalizeStatus(kind, status) {
  validateKind(kind);
  const allowed = STATUS[kind];
  if (status === undefined || status === null || status === '') {
    return DEFAULT_STATUS[kind];
  }
  if (status === 'validated') {
    fail('status "validated" is not allowed; claims stay candidate', 'INVALID_STATUS');
  }
  if (!allowed.includes(status)) {
    fail(`invalid status "${status}" for kind "${kind}" (allowed: ${allowed.join(', ')})`, 'INVALID_STATUS');
  }
  return status;
}

function checkInputLength(value, field, max) {
  if (typeof value === 'string' && value.length > max) {
    fail(`${field} exceeds ${max} characters; shorten the input and use a source pointer for the full content.`, 'INPUT_TOO_LONG');
  }
}

function normalizeInput(input, root) {
  if (!input || typeof input !== 'object') fail('input required', 'INVALID_INPUT');
  const kind = input.kind;
  validateKind(kind);
  const status = normalizeStatus(kind, input.status);
  if (typeof input.title !== 'string' || input.title.trim() === '') {
    fail('input.title is required', 'INVALID_INPUT');
  }
  checkInputLength(input.title, 'input.title', 2000);
  checkInputLength(input.text, 'input.text', 4000);
  checkInputLength(input.reason, 'input.reason', 1000);
  checkInputLength(input.source?.excerpt, 'input.source.excerpt', 2000);
  const id = typeof input.id === 'string' && input.id.trim()
    ? encodeId(input.id)
    : encodeId(input.title);
  const source = {
    path: typeof input.source?.path === 'string' ? input.source.path : null,
    sha256: typeof input.source?.sha256 === 'string' ? input.source.sha256 : undefined,
    excerpt: typeof input.source?.excerpt === 'string' ? input.source.excerpt : undefined,
  };
  if (!source.path) fail('input.source.path is required (file required source)', 'INVALID_INPUT');
  const ctxOut = {};
  if (input.context && typeof input.context === 'object') {
    for (const k of CONTEXT_KEYS) {
      const v = input.context[k];
      if (v !== undefined && v !== null && v !== '') {
        const value = String(v);
        checkInputLength(value, `input.context.${k}`, 2000);
        ctxOut[k] = value;
      }
    }
  }
  const result = {
    id,
    kind,
    title: input.title,
    text: typeof input.text === 'string' ? input.text : '',
    status,
    source,
    context: Object.keys(ctxOut).length ? ctxOut : undefined,
  };
  if (Array.isArray(input.aliases)) {
    if (input.aliases.length > 20) {
      fail('input.aliases exceeds 20 entries; shorten the input and use a source pointer for the full content.', 'INPUT_TOO_LONG');
    }
    // aliases preserved as raw text (Unicode kept), never slugged
    const a = input.aliases.map((x, index) => {
      const value = String(x);
      checkInputLength(value, `input.aliases[${index}]`, 256);
      return value.trim();
    }).filter((x) => x !== '');
    if (a.length) result.aliases = [...new Set(a)];
  }
  if (typeof input.supersedes === 'string' && input.supersedes.trim()) {
    result.supersedes = encodeId(input.supersedes);
  }
  if (typeof input.reason === 'string' && input.reason.trim()) {
    result.reason = input.reason;
  }
  return result;
}

// ---------------------------------------------------------------------------
// journal read / reconstruction + integrity (pure, no writes)
// ---------------------------------------------------------------------------
const changeBytes = (change) => Buffer.from(JSON.stringify(change, null, 2) + '\n');

function validChange(change) {
  const r = change?.record;
  return change && typeof change === 'object' && change.schema === SCHEMA &&
    typeof change.projectId === 'string' && !!change.projectId &&
    Number.isSafeInteger(change.projectRevision) && change.projectRevision > 0 &&
    Number.isSafeInteger(change.recordRevision) && change.recordRevision > 0 &&
    typeof change.changeId === 'string' && !!change.changeId &&
    typeof change.logicalId === 'string' && /^[a-z0-9._-]+$/.test(change.logicalId) &&
    r && r.id === change.logicalId && KINDS.includes(r.kind) &&
    (STATUS[r.kind].includes(r.status) || TOMBSTONE_STATUS.includes(r.status)) &&
    typeof r.title === 'string' && typeof r.source?.path === 'string' &&
    (!r.aliases || (Array.isArray(r.aliases) && r.aliases.every((a) => typeof a === 'string')));
}

async function readJournalChanges(changesDir) {
  const root = path.dirname(path.dirname(path.dirname(changesDir)));
  const issues = [];
  const raw = [];
  let entries;
  try {
    await guardStatePath(root, path.join(MEMORY_DIR, CHANGES_DIR));
    entries = await fsp.readdir(changesDir);
  } catch (e) {
    return { raw, issues: e.code === 'ENOENT' ? [] : [{ code: e.code === 'STATE_ESCAPE' ? e.code : 'CORRUPT', message: 'cannot read changes directory' }] };
  }
  for (const name of entries) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const file = path.join(changesDir, name);
    let rawBuf;
    try {
      await guardStatePath(root, path.join(MEMORY_DIR, CHANGES_DIR, name));
      rawBuf = await fsp.readFile(file);
    } catch (e) {
      issues.push({ code: e.code === 'STATE_ESCAPE' ? e.code : 'PARSE_ERROR', message: `cannot read change file ${name}`, changeId: name });
      continue;
    }
    let obj;
    try { obj = JSON.parse(rawBuf.toString('utf8')); }
    catch { issues.push({ code: 'PARSE_ERROR', message: `invalid JSON: ${name}`, changeId: name }); continue; }
    const verified = (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const { checksum, ...rest } = value;
      return typeof checksum === 'string' && sha256(JSON.stringify(rest)) === checksum;
    };
    if (!verified(obj)) {
      issues.push({ code: 'TAMPER', changeId: name, message: `missing or mismatched checksum: ${name}` });
      continue;
    }
    const batch = obj.transaction;
    if (batch !== undefined) {
      if (!Array.isArray(batch) || batch.length !== 2 ||
          obj.projectRevision !== batch[1]?.projectRevision ||
          batch.some((c) => !verified(c) || !validChange(c) || c.projectId !== obj.projectId) ||
          batch[1].projectRevision !== batch[0].projectRevision + 1 ||
          batch[0].record.supersedes !== batch[1].logicalId ||
          batch[1].record.supersededBy !== batch[0].logicalId) {
        issues.push({ code: 'CORRUPT', changeId: name, message: `invalid transaction: ${name}` });
        continue;
      }
      for (const change of batch) raw.push({ file, name, obj: change, bytes: changeBytes(change) });
    } else if (validChange(obj)) {
      raw.push({ file, name, obj, bytes: rawBuf });
    } else {
      issues.push({ code: 'CORRUPT', changeId: name, message: `invalid change schema: ${name}` });
    }
  }
  return { raw, issues };
}

// reconstruct current per logicalId; strict integrity (gaps/dup chain).
async function readJournal(changesDir, projectId, workspaceKey) {
  const { raw, issues } = await readJournalChanges(changesDir);
  if (projectId) {
    for (const r of raw) {
      if (r.obj.projectId && r.obj.projectId !== projectId) {
        issues.push({ code: 'TAMPER', changeId: r.obj.changeId || r.name, message: `change from foreign project: ${r.name}` });
      }
    }
  }
  const changes = raw.filter((r) => !projectId || r.obj.projectId === projectId);
  changes.sort((a, b) => (a.obj.projectRevision - b.obj.projectRevision) || a.name.localeCompare(b.name));

  // Compare against the sorted sequence instead of iterating to an untrusted max.
  if (changes.some((c, index) => c.obj.projectRevision !== index + 1)) {
    issues.push({ code: 'CORRUPT', message: 'duplicate or missing projectRevision in journal' });
  }

  // parent-chain: child.parentDigest must equal sha256 of previous same-id change file bytes
  const prevById = new Map();
  for (const c of changes) {
    const prev = prevById.get(c.obj.logicalId);
    if (prev) {
      const expected = prev.bytes ? sha256(prev.bytes) : null;
      if (c.obj.parentDigest && expected && c.obj.parentDigest !== expected) {
        issues.push({ code: 'TAMPER', changeId: c.obj.changeId, message: `parent digest mismatch (chain broken): ${c.name}` });
      } else if (!c.obj.parentDigest) {
        issues.push({ code: 'CORRUPT', changeId: c.obj.changeId, message: `missing parentDigest on revision update: ${c.name}` });
      }
    }
    if (c.obj.recordRevision !== (prev ? prev.obj.recordRevision + 1 : 1) ||
        (!prev && c.obj.parentDigest)) {
      issues.push({ code: 'CORRUPT', changeId: c.obj.changeId, message: 'invalid record revision chain' });
    }
    prevById.set(c.obj.logicalId, c);
  }

  const byId = new Map();
  let maxRev = 0;
  for (const c of changes) {
    const o = c.obj;
    if (o.projectRevision > maxRev) maxRev = o.projectRevision;
    let entry = byId.get(o.logicalId);
    if (!entry) { entry = { id: o.logicalId, history: [] }; byId.set(o.logicalId, entry); }
    entry.history.push({ change: o, file: c.file, bytes: c.bytes });
  }
  for (const entry of byId.values()) {
    entry.revisions = entry.history.map((h) => h.change.recordRevision);
    const last = entry.history[entry.history.length - 1];
    entry.current = last;
    entry.file = last.file;
    // historical aliases union (so a dropped alias remains discoverable)
    entry.allAliases = [];
    for (const h of entry.history) {
      const a = h.change.record && h.change.record.aliases || [];
      for (const x of a) if (!entry.allAliases.includes(x)) entry.allAliases.push(x);
    }
  }
  // The latest tombstone owns its replacement link. Historical edges must not
  // override a newer cancellation/replacement or resurrect an old target.
  for (const entry of byId.values()) {
    const r = entry.current.change.record;
    entry.supersededBy = r.supersededBy;
    if (r.supersededBy && (!byId.has(r.supersededBy) || !TOMBSTONE_STATUS.includes(r.status))) {
      issues.push({ code: 'CORRUPT', message: 'invalid replacement link' });
    }
    if (r.supersedes && r.supersedes !== r.id && byId.get(r.supersedes)?.current.change.record.supersededBy !== r.id) {
      issues.push({ code: 'CORRUPT', message: 'incomplete supersession' });
    }
  }
  for (const entry of byId.values()) {
    const seen = new Set();
    let next = entry;
    while (next?.supersededBy && next.supersededBy !== next.id) {
      if (seen.has(next.id)) { issues.push({ code: 'CORRUPT', message: 'replacement cycle' }); break; }
      seen.add(next.id);
      next = byId.get(next.supersededBy);
    }
  }

  const corrupt = issues.some((i) => FATAL_ISSUES.has(i.code));
  return { changes: changes.map((c) => ({ file: c.file, name: c.name, obj: c.obj, bytes: c.bytes })),
           byId, maxRev, issues, corrupt };
}

function recordObject(entry) {
  const c = entry.current.change.record;
  const tombstone = TOMBSTONE_STATUS.includes(c.status);
  return {
    id: entry.id,
    kind: c.kind,
    title: c.title,
    text: c.text || '',
    status: c.status,
    revision: entry.current.change.recordRevision,
    projectRevision: entry.current.change.projectRevision,
    tombstone,
    aliases: c.aliases || [],
    allAliases: entry.allAliases || [],
    source: c.source || { path: '' },
    context: c.context || {},
    reason: c.reason,
    supersedes: c.supersedes,
    supersededBy: entry.supersededBy || undefined,
    updatedAt: c.updatedAt || c.createdAt,
    createdAt: c.createdAt,
  };
}

function toRecordsArray(byId) {
  return [...byId.values()].map(recordObject);
}

// ---------------------------------------------------------------------------
// readState — pure read; records is an ARRAY (runtime interface).
// Works even on isolated/moved markers so data stays readable (never silently empty).
// ---------------------------------------------------------------------------
export async function readState(root, opts = {}) {
  const rootAbs = path.resolve(root);
  const actualKey = await workspaceKeyFor(rootAbs);
  const d = wp(rootAbs);
  let pf;
  try { pf = await readProjectFile(rootAbs); }
  catch (e) {
    return { project: { root: rootAbs, memoryDir: d.memoryDir, exists: false, workspaceKey: actualKey, revision: 0 },
      exists: false, revision: 0, records: [], corrupt: true,
      issues: [{ code: e.code || 'CORRUPT_PROJECT_FILE', message: 'cannot safely read project marker' }] };
  }
  const issues = [];
  if (pf && pf.__error) {
    issues.push({ code: 'CORRUPT_PROJECT_FILE', message: `unreadable ${PROJECT_FILE}: ${pf.__error}` });
    return {
      project: { root: rootAbs, memoryDir: d.memoryDir, exists: false, workspaceKey: actualKey, projectId: undefined, revision: 0 },
      exists: false, revision: 0, records: [], issues, corrupt: true,
    };
  }
  if (pf && pf.__enoent) {
    // no marker at all -> uninitialized, not corrupt
    return {
      project: { root: rootAbs, memoryDir: d.memoryDir, exists: false, workspaceKey: actualKey, projectId: undefined, revision: 0 },
      exists: false, revision: 0, records: [], issues,
    };
  }
  if (!pf || !pf.projectId) {
    return {
      project: { root: rootAbs, memoryDir: d.memoryDir, exists: false, workspaceKey: actualKey, projectId: undefined, revision: 0 },
      exists: false, revision: 0, records: [], issues,
    };
  }
  const storedKey = pf.workspaceKey;
  const isolated = Boolean(storedKey && storedKey !== actualKey);
  if (isolated) {
    issues.push({ code: 'ISOLATED', message: 'project marker from a different workspace key (moved/copied). Data readable; call adoptProject to re-key before writing.' });
  }
  let base = Number.isInteger(pf.revision) ? pf.revision : 0;
  const j = await readJournal(d.changesDir, pf.projectId, actualKey);
  if (j.maxRev > base) base = j.maxRev;
  if (pf.revision > j.maxRev) {
    j.issues.push({ code: 'CORRUPT', message: 'journal ends before committed project revision' });
    j.corrupt = true;
  }
  j.issues.forEach((i) => issues.push(i));
  const records = j.corrupt ? [] : toRecordsArray(j.byId);
  const project = {
    root: rootAbs, memoryDir: d.memoryDir, exists: true,
    projectId: pf.projectId, workspaceKey: actualKey, schema: pf.schema,
    formatVersion: pf.formatVersion, revision: base, created: pf.created,
    isolated,
  };
  return { project, exists: true, revision: base, records, issues, corrupt: j.corrupt,
    ...(opts._includeJournal ? { _journal: j } : {}) };
}

// ---------------------------------------------------------------------------
// projections — rebuilt from journal (canonical). Manual edits = stale.
// ---------------------------------------------------------------------------
function digestBlock(rec) {
  const lines = [];
  if (rec.status) lines.push(`status: ${rec.status}`);
  if (rec.kind) lines.push(`kind: ${rec.kind}`);
  if (rec.aliases && rec.aliases.length) lines.push(`aliases: ${rec.aliases.join(', ')}`);
  if (rec.reason) lines.push(`reason: ${rec.reason}`);
  if (rec.context && Object.keys(rec.context).length) {
    lines.push(`context: ${Object.entries(rec.context).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  if (rec.supersedes) lines.push(`supersedes: ${rec.supersedes}`);
  return lines;
}

export async function regenProjections(root, { memoryDir } = {}) {
  const rootAbs = path.resolve(root);
  const d = wp(rootAbs);
  if (memoryDir && path.resolve(memoryDir) !== d.memoryDir) fail('Invalid projection directory', 'STATE_ESCAPE');
  const st = await readState(rootAbs);
  if (st.corrupt) fail('Cannot project a corrupt store', 'CORRUPT_JOURNAL');
  if (!st.exists) return st;
  await guardStatePath(rootAbs, path.join(MEMORY_DIR, 'MEMORY.md'));
  await guardStatePath(rootAbs, path.join(MEMORY_DIR, TOPICS_DIR));
  const lines = [];
  lines.push('# Project Memory');
  lines.push('');
  lines.push(`project: ${st.project.projectId}`);
  lines.push(`workspaceKey: ${st.project.workspaceKey}`);
  lines.push(`revision: ${st.revision}`);
  lines.push(`generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('> Generated from changes journal. Hand edits are stale (not canonical).');
  lines.push('');

  const active = st.records.filter((r) => !r.tombstone);
  const tombs = st.records.filter((r) => r.tombstone);

  lines.push('## Active');
  for (const r of active) {
    lines.push(`- [${r.status}] ${r.title} (id:${r.id})`);
    if (r.reason) lines.push(`  reason: ${r.reason}`);
    if (r.source && r.source.path) lines.push(`  source: ${r.source.path}`);
  }
  lines.push('');
  lines.push('## Retired / Cancelled / Superseded (tombstones)');
  for (const r of tombs) {
    lines.push(`- [${r.status}] ${r.title} (id:${r.id}, last rev ${r.revision})`);
  }
  if (!active.length && !tombs.length) {
    lines.push('(no records yet)');
  }

  await writeFileAtomic(path.join(d.memoryDir, 'MEMORY.md'), lines.join('\n') + '\n');

  await fsp.mkdir(path.join(d.memoryDir, TOPICS_DIR), { recursive: true });
  for (const r of st.records) {
    const t = [];
    t.push(`# ${r.title}`);
    t.push('');
    t.push(`id: ${r.id}`);
    t.push(`kind: ${r.kind}`);
    t.push(`status: ${r.status}`);
    t.push(`revision: ${r.revision}`);
    t.push('');
    if (r.text) t.push(r.text, '');
    for (const line of digestBlock(r)) t.push(line);
    if (r.source && r.source.path) t.push('', `source: ${r.source.path}`);
    t.push('');
    t.push('---');
    t.push('auto-generated from changes journal; hand edits are stale.');
    const tp = path.join(d.memoryDir, TOPICS_DIR, `${r.id}.md`);
    await guardStatePath(rootAbs, path.join(MEMORY_DIR, TOPICS_DIR, `${r.id}.md`));
    await writeFileAtomic(tp, t.join('\n') + '\n');
  }
  return st;
}

// recovery: reconcile project.json.revision to truth + regenerate projections.
// Only invoked during commit (under lock). Not by plain reads.
async function recoverCommit(rootAbs, memoryDir) {
  const file = path.join(memoryDir, PROJECT_FILE);
  const pf = await readProjectFile(rootAbs);
  if (!pf || !pf.projectId) fail('Invalid project marker', 'CORRUPT_PROJECT_FILE');
  const st = await readState(rootAbs);
  if (st.corrupt) fail('Cannot recover a corrupt journal', 'CORRUPT_JOURNAL');
  const base = st.revision;
  await regenProjections(rootAbs, { memoryDir });
  if (Number.isInteger(pf.revision) && pf.revision !== base) {
    pf.revision = base;
    await writeFileAtomic(file, JSON.stringify(pf, null, 2) + '\n');
  }
}

// ---------------------------------------------------------------------------
// saveRecord — CAS commit (global expectedRevision)
// ---------------------------------------------------------------------------
export async function saveRecord(root, input, opts = {}) {
  const rootAbs = path.resolve(root);
  const expectedRevision = opts.expectedRevision;
  if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
    fail('expectedRevision (global project revision) is required for CAS', 'MISSING_EXPECTED_REVISION');
  }
  const sessionId = typeof opts.sessionId === 'string' ? opts.sessionId : 'unknown';

  const rec = normalizeInput(input, rootAbs);

  // confine + capture source before locking (fast fail on bad paths)
  const relSrc = await confineSource(rootAbs, rec.source.path);
  rec.source.path = relSrc;
  const srcHash = await computeSourceHash(rootAbs, relSrc);
  if (rec.source.sha256 && rec.source.sha256 !== srcHash.hash) {
    fail(`supplied source hash does not match file ${relSrc}`, 'SOURCE_HASH');
  }
  rec.source.sha256 = srcHash.hash;
  rec.source.size = srcHash.size;

  await guardStatePath(rootAbs, path.join(MEMORY_DIR, PROJECT_FILE));
  await guardStatePath(rootAbs, path.join(MEMORY_DIR, CHANGES_DIR));
  const memoryDir = path.join(rootAbs, MEMORY_DIR);
  const release = await acquireLock(memoryDir);
  try {
    // ensure initialized (explicit save), under lock — never eager writes.
    const file = path.join(memoryDir, PROJECT_FILE);
    let pf;
    if (!(await pathExists(file))) {
      if (expectedRevision !== 0) fail('project not initialized; expectedRevision must be 0', 'PROJECT_NOT_FOUND');
      const key = await workspaceKeyFor(rootAbs);
      const init = await initializeProjectUnlocked(rootAbs, { _now: opts._now });
      pf = { schema: SCHEMA, formatVersion: FORMAT_VERSION, root: rootAbs,
             projectId: init.projectId, workspaceKey: key, revision: 0, created: init.created };
    } else {
      pf = await readProjectFile(rootAbs);
      if (pf?.__error) fail(`Cannot save: unreadable ${PROJECT_FILE}`, 'CORRUPT_PROJECT_FILE');
      if (!pf || !pf.projectId) fail('Cannot save: uninitialized project', 'PROJECT_NOT_FOUND');
      const actualKey = await workspaceKeyFor(rootAbs);
      if (pf.workspaceKey !== actualKey) {
        fail('Cannot write: project marker is from another workspace (moved/copied). Call adoptProject(root) first.', 'ISOLATED_MARKER');
      }
    }

    // recover any interrupted commit before proceeding
    await recoverCommit(rootAbs, memoryDir);
    const pfR = await readProjectFile(rootAbs);
    if (Number.isInteger(pfR.revision) && pfR.revision !== expectedRevision) {
      fail(`revision conflict: expected ${expectedRevision}, current ${pfR.revision}`, 'REVISION_CONFLICT');
    }

    const j = await readJournal(path.join(memoryDir, CHANGES_DIR), pfR.projectId, pfR.workspaceKey);
    if (j.corrupt) {
      fail('Cannot save: changes journal is corrupt (tampered/gapped). Fix issues first.', 'CORRUPT_JOURNAL');
    }
    const { byId } = j;
    if (rec.supersedes && !byId.has(rec.supersedes)) {
      fail(`cannot supersede unknown logical id: ${rec.supersedes}`, 'TARGET_UNKNOWN');
    }

    if (byId.get(rec.id)?.supersededBy && byId.get(rec.id).supersededBy !== rec.id) {
      fail('Update the current replacement instead of a superseded record', 'TARGET_SUPERSEDED');
    }
    if (rec.supersedes && rec.supersedes !== rec.id && byId.get(rec.supersedes).supersededBy &&
        byId.get(rec.supersedes).supersededBy !== rec.id) {
      fail('Target already has a replacement', 'TARGET_SUPERSEDED');
    }
    let globalRev = Number.isInteger(pfR.revision) ? pfR.revision : 0;
    const prevById = new Map();
    for (const entry of byId.values()) {
      prevById.set(entry.id, { change: entry.current.change, bytes: entry.current.bytes });
    }

    const written = [];
    const commitOne = async (logicalId, payloadRecord, extra) => {
      globalRev += 1;
      const previous = prevById.get(logicalId);
      const prevChg = previous?.change;
      const recordRevision = prevChg ? prevChg.recordRevision + 1 : 1;
      const parentDigest = previous ? sha256(previous.bytes) : null;
      const changeId = `${globalRev}-${randomUUID()}`;
      const createdAt = nowVal(opts._now);
      const record = {
        ...payloadRecord,
        id: logicalId,
        updatedAt: createdAt,
        createdAt: prevChg ? prevChg.record.createdAt : createdAt,
        revision: recordRevision,
        sha256: undefined,
      };
      const change = {
        schema: SCHEMA,
        changeId,
        projectId: pfR.projectId,
        workspaceKey: pfR.workspaceKey,
        createdAt,
        sessionId,
        logicalId,
        previousRevision: expectedRevision,
        recordRevision,
        projectRevision: globalRev,
        parentDigest,
        superseding: !!extra?.superseding,
        supersededBy: extra?.supersededBy,
        record,
      };
      const body = { ...change };
      delete body.checksum;
      change.checksum = sha256(JSON.stringify(body));
      prevById.set(logicalId, { change, bytes: changeBytes(change) });
      written.push({ change, logicalId, recordRevision });
    };

    await commitOne(rec.id, rec);
    if (rec.supersedes) {
      const tid = rec.supersedes;
      const tgtRecord = tid === rec.id ? rec : byId.get(tid).current.change.record;
      const tombRecord = {
        ...tgtRecord,
        status: tgtRecord.kind === 'artifact' ? 'retired' : 'superseded',
        supersededBy: rec.id,
        reason: rec.reason || `superseded by ${rec.id}`,
        updatedAt: nowVal(opts._now),
      };
      delete tombRecord.supersedes;
      await commitOne(tid, tombRecord, { superseding: true, supersededBy: rec.id });
    }

    // Publish the replacement and its tombstone together. A reader or crash
    // sees either the previous journal or the whole transaction, never half.
    let publication = written[0].change;
    if (written.length > 1) {
      publication = { schema: SCHEMA, projectId: pfR.projectId,
        projectRevision: globalRev, transaction: written.map((w) => w.change) };
      publication.checksum = sha256(JSON.stringify(publication));
    }
    const cfile = path.join(memoryDir, CHANGES_DIR, `${written[0].change.changeId}.json`);
    await writeFileAtomic(cfile, changeBytes(publication));

    pfR.revision = globalRev;
    await writeFileAtomic(file, JSON.stringify(pfR, null, 2) + '\n');
    await regenProjections(rootAbs, { memoryDir });

    return {
      project: {
        root: rootAbs, memoryDir, projectId: pfR.projectId,
        workspaceKey: pfR.workspaceKey, schema: pfR.schema,
        formatVersion: pfR.formatVersion, revision: globalRev,
      },
      revision: globalRev,
      logicalId: rec.id,
      recordId: rec.id,
      recordRevision: written[0].recordRevision,
      changeId: written[0].change.changeId,
      savedFrom: written.map((w) => ({
        logicalId: w.logicalId, recordRevision: w.recordRevision,
        projectRevision: w.change.projectRevision, changeId: w.change.changeId,
        superseding: !!w.change.superseding,
      })),
      conflict: false,
    };
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------------------
// lookup
// ---------------------------------------------------------------------------
function ctxCompatible(recordCtx, filterCtx) {
  for (const key of CONTEXT_KEYS) {
    const fv = filterCtx && filterCtx[key];
    if (fv === undefined || fv === null || fv === '') continue;
    const rv = recordCtx && recordCtx[key];
    if (rv && rv !== String(fv)) return false; // specified + exists + mismatch => incompatible
  }
  return true;
}

function matchQuery(rec, q) {
  if (!q) return true;
  const ql = String(q).toLowerCase();
  const hay = [(rec.allAliases || []).join(' '), rec.id, rec.title, rec.text, rec.kind,
    rec.status, (rec.aliases || []).join(' '), rec.reason || ''].join(' ').toLowerCase();
  return hay.includes(ql);
}

function aliasOrIdMatch(rec, want) {
  const wl = String(want).toLowerCase();
  if (rec.id === encodeId(want)) return true;
  for (const a of rec.allAliases || []) if (String(a).toLowerCase() === wl) return true;
  return false;
}

function resolveToCurrent(rec, allById) {
  const seen = new Set();
  let cur = rec;
  while (cur.supersededBy && allById.has(cur.supersededBy) && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = allById.get(cur.supersededBy);
  }
  return cur;
}

export async function lookup(root, opts = {}) {
  const rootAbs = path.resolve(root);
  const filterCtx = opts.context && typeof opts.context === 'object' ? opts.context : null;
  const history = !!opts.history;
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 50;
  const st = await readState(rootAbs, { _includeJournal: history });
  if (!st.exists || st.corrupt) {
    return { project: st.project, revision: st.revision, records: [], current: null,
      incompatible: [], exists: st.exists, issues: st.issues, corrupt: st.corrupt };
  }
  const journal = st._journal;
  const allById = new Map(st.records.map((r) => [r.id, r]));
  const incompatible = [];
  let matched = [];

  const hasId = opts.id !== undefined && opts.id !== null && String(opts.id) !== '';
  const seen = new Set();
  for (const rec of st.records) {
    if (!(hasId ? aliasOrIdMatch(rec, opts.id) : matchQuery(rec, opts.query))) continue;
    const current = resolveToCurrent(rec, allById);
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    if (!ctxCompatible(current.context, filterCtx)) {
      if (incompatible.length < Math.min(limit, 50)) {
        incompatible.push({ id: current.id, reason: 'context mismatch',
          mismatchedKeys: CONTEXT_KEYS.filter((key) => filterCtx?.[key] !== undefined &&
            filterCtx[key] !== null && filterCtx[key] !== '' && current.context?.[key] &&
            current.context[key] !== String(filterCtx[key])) });
      }
      continue;
    }
    matched.push(current);
  }

  const withCur = matched.map((rec) => ({ record: rec, current: rec }));
  withCur.sort((a, b) => {
    const aT = a.current.tombstone ? 1 : 0;
    const bT = b.current.tombstone ? 1 : 0;
    if (aT !== bT) return aT - bT;
    return b.current.revision - a.current.revision;
  });

  const output = [];
  for (const item of withCur.slice(0, limit)) {
    const stale = await markStale(rootAbs, item.record);
    output.push({
      record: item.record,
      current: item.current,
      staleSource: stale,
      history: history ? (await historyOf(journal, item.record.id)) : undefined,
    });
  }

  let current = null;
  if (opts.id !== undefined && opts.id !== null && String(opts.id) !== '') {
    const active = output.find((o) => !o.current.tombstone);
    current = (active || output[0] || {}).current || null;
  }

  return {
    project: st.project,
    revision: st.revision,
    exists: true,
    records: output,
    current,
    incompatible,
    issues: st.issues,
    corrupt: st.corrupt,
  };
}

async function historyOf(journal, id) {
  return journal.changes
    .filter((c) => c.obj.logicalId === id)
    .sort((a, b) => a.obj.recordRevision - b.obj.recordRevision)
    .map((c) => ({
      record: c.obj.record,
      projectRevision: c.obj.projectRevision,
      recordRevision: c.obj.recordRevision,
      changeId: c.obj.changeId,
      sessionId: c.obj.sessionId,
      createdAt: c.obj.createdAt,
    }));
}

// ---------------------------------------------------------------------------
// renderRecovery — bounded STRING; whole-sentence truncation only; no raw source.
// Always shows active decisions/context + tombstones; other records via query.
// ---------------------------------------------------------------------------
function boundedNotice(budget, choices) {
  return choices.find((s) => s.length <= budget) || '!';
}

function renderer(budget) {
  const notice = boundedNotice(budget, [
    '[continuity] Details/records omitted; use lookup before relying on this summary.',
    '[continuity] Omitted; use lookup.', '[omitted]', '!',
  ]);
  const out = [];
  let used = 0;
  let omitted = false;
  // Reserve the notice including its separator before adding any content.
  const available = Math.max(0, budget - notice.length - 1);
  const fit = (s) => {
    const cost = s.length + (out.length ? 1 : 0);
    if (used + cost > available) return false;
    out.push(s);
    used += cost;
    return true;
  };
  const add = (s, fallback) => {
    if (!s) return true;
    if (fit(String(s))) return true;
    omitted = true;
    return fallback ? fit(String(fallback)) : false;
  };
  return { add, lines: () => [...out, ...(omitted ? [notice] : [])].join('\n') };
}

export async function renderRecovery(root, opts = {}) {
  const maxChars = Number.isInteger(opts.maxChars) && opts.maxChars > 0 ? opts.maxChars : 6000;
  const R = renderer(maxChars);
  const rootAbs = path.resolve(root);
  const st = await readState(rootAbs);
  if (st.corrupt) {
    return boundedNotice(maxChars, [
      '[continuity] INTEGRITY WARNING: corrupt or unsafe store; current facts withheld until repaired.',
      '[continuity] CORRUPT: current facts withheld.', '[CORRUPT]', '!',
    ]);
  }
  if (!st.exists) {
    return boundedNotice(maxChars, [
      `[continuity] no active project memory at ${rootAbs} (not initialized)`,
      '[continuity] Not initialized.', '[no memory]', '!',
    ]);
  }
  if (st.project.isolated) {
    const warning = '!! ISOLATED copy: historical data only; adoptProject before writing.';
    if (!R.add(warning)) return boundedNotice(maxChars, [warning, '[ISOLATED]', '!']);
  }
  R.add(`Project memory: ${st.project.projectId} (rev ${st.revision})`);
  const filterCtx = opts.context && typeof opts.context === 'object' ? opts.context : null;
  const relevant = st.records.filter((r) => ctxCompatible(r.context, filterCtx));
  const tombs = relevant.filter((r) => r.tombstone);
  const constraints = relevant.filter((r) => !r.tombstone && (r.kind === 'decision' || r.kind === 'context'));
  const others = relevant.filter((r) => !r.tombstone && r.kind !== 'decision' && r.kind !== 'context')
    .filter((r) => !opts.query || matchQuery(r, opts.query));

  // Compact tombstones and constraint pointers precede all explanatory text and
  // ordinary facts. Never print a record's body without its status/id context.
  const core = [];
  for (const r of [...tombs, ...constraints]) {
    const stale = await markStale(rootAbs, r);
    const flags = stale ? ' {SOURCE STALE/MISSING}' : '';
    const link = r.supersededBy ? ` -> current: ${r.supersededBy}` : '';
    const pointer = `- [${r.status}] (${r.id})${flags}${link}`;
    if (R.add(`${pointer} ${r.title}`, `${pointer} [details omitted]`)) core.push(r);
  }
  for (const r of core) {
    const details = [r.reason && `reason: ${r.reason}`, r.text,
      r.source?.path && `source: ${r.source.path}`].filter(Boolean).join('\n');
    if (details) R.add(`(${r.id}) [${r.status}]\n${details}`);
  }
  for (const r of others) {
    const stale = await markStale(rootAbs, r);
    const flags = [r.kind === 'claim' && 'NOT verified (candidate)', stale && 'SOURCE STALE/MISSING'].filter(Boolean);
    const conditions = r.kind === 'attempt'
      ? `\nAttempt conditions: ${Object.entries(r.context).map(([k, v]) => `${k}=${v}`).join(', ') || 'unspecified; not a general prohibition'}` : '';
    const block = `- [${r.status}] (${r.id}) ${r.title}${flags.length ? ' {' + flags.join('; ') + '}' : ''}${conditions}` +
      (r.reason ? `\nreason: ${r.reason}` : '') + (r.source?.path ? `\nsource: ${r.source.path}` : '');
    R.add(block);
  }
  R.add('Claims are NOT verified. Sources are pointers; use lookup for full records.');
  return R.lines();
}
