import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rename, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeOptions } from './config.mjs';
import { hasGlob, isUnder, resolveTarget } from './paths.mjs';
import { hardTarget } from './rules/rm.mjs';
import { parseShell } from './split.mjs';
import { parse } from './vendor/unbash/parser.js';

const FLAGS = new Set(['-r', '-R', '-f', '-v', '--recursive', '--force', '--verbose']);
const DATABASE_DIRS = new Set(['db', 'database', 'databases', 'data', 'pgdata', 'postgres', 'postgresql', 'mysql', 'mariadb', 'mongodb', 'redis', 'leveldb', 'rocksdb']);
const protectedName = (name) => {
  const lower = name.toLowerCase();
  return ['temp', '.git', '.ssh', '.gnupg', '.pi', '.config'].includes(lower)
    || DATABASE_DIRS.has(lower) || /\.(?:db|sqlite|sqlite3)(?:$|[-.])/.test(lower)
    || /^(?:dump\.rdb|appendonly\.aof|ibdata\d*|ib_logfile\d*|pg_version|wiredtiger(?:\..*)?)$/.test(lower);
};
const same = (a, b) => isUnder(a, b) && isUnder(b, a);
const shellQuote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;

function assertSafeTarget(root, target, options) {
  if (same(root, target) || !isUnder(target, root)) throw new Error('Target must be strictly inside the project');
  const components = path.relative(root, target).split(path.sep);
  if (components.some(protectedName) || protectedName(path.basename(root))) {
    throw new Error('TEMP, .git, credentials and database storage cannot be moved automatically');
  }
  const hard = hardTarget(target, options) || hardTarget(root, { ...options, protectedPaths: [] });
  if (hard) throw new Error(hard.reason);
  // A project opened inside Git/credential metadata remains protected too.
  if (root.split(path.sep).some((part) => ['.git', '.ssh', '.gnupg', '.pi', '.config'].includes(part.toLowerCase()))) {
    throw new Error('Project is inside protected metadata');
  }
}

export function parseTrashableRm(command, { cwd, projectRoot = cwd, home, platform = process.platform, settings } = {}) {
  if (typeof command !== 'string' || command.length > 65536 || command.includes('\0')) return null;
  // Require one complete AST command as well as the local literal-token
  // contract. Parse errors never return the original deletion command.
  try {
    const ast = parse(command), statement = ast.commands[0], node = statement?.command;
    if (ast.errors?.length || ast.commands.length !== 1 || statement.type !== 'Statement' || statement.background || statement.redirects.length
      || node?.type !== 'Command' || node.prefix.length || node.redirects.length || node.name?.value !== 'rm') return null;
  } catch { return null; }
  const parsed = parseShell(command);
  if (parsed.uncertain || parsed.segments.length !== 1) return null;
  const segment = parsed.segments[0];
  if (segment.connector || segment.background || segment.redirects.length || segment.heredocs.length) return null;
  const tokens = segment.tokens;
  if (tokens[0]?.value !== 'rm' || tokens[0]?.dynamic) return null;

  let literal = false;
  let force = false;
  let target;
  for (const token of tokens.slice(1)) {
    if (token.dynamic) return null;
    if (!literal && token.value === '--') { literal = true; continue; }
    if (!literal && token.value.startsWith('-')) {
      const flags = token.value.startsWith('--') ? [token.value] : [...token.value].slice(1).map((flag) => `-${flag}`);
      if (!flags.length || flags.some((flag) => !FLAGS.has(flag))) return null;
      if (flags.includes('-f') || flags.includes('--force')) force = true;
      continue;
    }
    if (target || !token.value || /[\x00-\x1f\x7f]/.test(token.value) || hasGlob(token.value)) return null;
    // Do not normalize away a parent traversal before the helper checks links.
    // A raw link/../cache route can name a different file than its lexical path.
    if (token.value.split(/[\\/]/).some(component => component.replace(/ +$/, '') === '..')) return null;
    const resolved = resolveTarget(token.value, cwd, home, platform);
    if (!resolved?.path || resolved.dynamic) return null;
    target = path.resolve(resolved.path);
  }
  if (!target || !cwd) return null;
  const root = path.resolve(projectRoot);
  const options = normalizeOptions({ cwd, projectRoot: root, home, platform, settings });
  try { assertSafeTarget(root, target, options); } catch { return null; }
  return { root, target, force, protectedPaths: options.protectedPaths };
}

// Only arguments are interpolated, each quoted as one literal Bash word. The
// original rm is absent. Later tool_call handlers can still block with no I/O.
export function trashCommand(plan) {
  return [process.execPath.replaceAll('\\', '/'), fileURLToPath(import.meta.url).replaceAll('\\', '/'), '--move-to-temp',
    plan.root, plan.target, plan.force ? '1' : '0', ...(plan.protectedPaths ?? [])].map(shellQuote).join(' ');
}

async function statOrMissing(candidate) {
  try { return await lstat(candidate); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Check every component, including junctions and links that resolve back inside
// the project. realpath alone only proves the final referent, not the route.
async function plainPath(candidate) {
  const absolute = path.resolve(candidate);
  let current = path.parse(absolute).root;
  for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Not a plain directory: ${current}`);
  }
  if (!same(await realpath(absolute), absolute)) throw new Error(`Path alias is unsupported: ${absolute}`);
  return absolute;
}

export async function moveToTemp(plan) {
  if (!plan || !path.isAbsolute(plan.root) || !path.isAbsolute(plan.target) || typeof plan.force !== 'boolean') {
    throw new Error('Invalid TEMP move plan');
  }
  const root = path.resolve(plan.root), target = path.resolve(plan.target);
  const options = normalizeOptions({ cwd: root, projectRoot: root, settings: { protectedPaths: plan.protectedPaths ?? [] } });
  assertSafeTarget(root, target, options);
  await plainPath(root);
  await plainPath(path.dirname(target));
  const source = await statOrMissing(target);
  if (!source) {
    if (!plan.force) throw new Error('Target does not exist; original rm was not run');
    return { location: null, moved: false };
  }
  if (source.isSymbolicLink()) throw new Error('Refusing to move a target link/junction');
  const tempRoot = path.join(root, 'TEMP');
  if (!await statOrMissing(tempRoot)) await mkdir(tempRoot);
  await plainPath(tempRoot);
  const batch = path.join(tempRoot, `${Date.now().toString(36)}-${randomUUID()}`);
  await mkdir(batch); // Exclusive; never reuse a pre-existing batch.
  const destination = path.join(batch, path.basename(target));
  try {
    // Recheck hard protections and both parent routes after preparing TEMP.
    assertSafeTarget(root, target, options);
    await plainPath(root);
    await plainPath(path.dirname(target));
    await plainPath(tempRoot);
    await plainPath(batch);
    const fresh = await lstat(target);
    if (fresh.isSymbolicLink() || fresh.dev !== source.dev || fresh.ino !== source.ino) throw new Error('Source identity changed');
    if (await statOrMissing(destination)) throw new Error('TEMP destination already exists');
    await rename(target, destination); // No copy/unlink or EXDEV fallback.
  } catch (error) {
    await rmdir(batch).catch(() => {}); // Only this newly-created empty batch.
    throw new Error(`Move failed; original rm was not run: ${error.message}`);
  }
  return { location: path.relative(root, destination).split(path.sep).join('/'), moved: true };
}

// Executed only by the rewritten Bash command, never while assessing a call.
if (process.argv[1] && same(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  try {
    const [mode, root, target, force, ...protectedPaths] = process.argv.slice(2);
    if (mode !== '--move-to-temp' || !['0', '1'].includes(force)) throw new Error('Invalid TEMP helper arguments');
    const moved = await moveToTemp({ root, target, force: force === '1', protectedPaths });
    console.log(moved.moved ? `Moved ${path.relative(root, target)} to ${path.join(root, moved.location)}\nRecovery path: ${moved.location}` : 'Target did not exist; nothing to move');
  } catch (error) {
    console.error(`shell-guard: ${error.message}; original rm was not run`);
    process.exitCode = 1;
  }
}
