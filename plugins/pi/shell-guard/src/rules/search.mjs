// Bounded path/option recognition for common traversal commands.
import { hasGlob, isDriveRoot, isHomeRoot, isUncRoot, resolveTarget, stripTrailingSep } from '../paths.mjs';

export const SEARCH_PROGRAMS = new Set(['find', 'grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack', 'fd', 'fdfind', 'findstr', 'du', 'tree', 'where', 'dir', 'get-childitem', 'gci']);
const VALUE_FLAGS = new Set(['-e', '--regexp', '-f', '--file', '-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not', '-m', '--max-count', '-A', '--after-context', '-B', '--before-context', '-C', '--context', '--max-depth', '--maxdepth', '--max-filesize', '--encoding', '--ignore-file', '--sort', '--sortr', '--color', '--colors', '--threads', '-j', '-d', '--extension', '-E', '--exclude', '--exclude-dir', '--include', '--exclude-from', '-I', '--ignore', '-L', '--level', '--block-size', '--threshold']);
const SHORT_VALUES = {
  rg: new Set(['-e', '-f', '-g', '-t', '-T', '-m', '-A', '-B', '-C', '-j']),
  grep: new Set(['-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D']),
  fd: new Set(['-d', '-e', '-E', '-t', '-x', '-X']),
  du: new Set(['-d', '-t', '-B']), tree: new Set(['-L', '-I', '-P']),
};
function takesValue(program, flag) {
  const kind = /^(?:grep|egrep|fgrep|zgrep)$/.test(program) ? 'grep' : program === 'fdfind' ? 'fd' : program;
  if (kind === 'fd' && flag === '--glob' || kind === 'grep' && flag === '--color') return false;
  return flag.startsWith('--') ? VALUE_FLAGS.has(flag) : (SHORT_VALUES[kind] || new Set(['-e', '-f', '-m', '-A', '-B', '-C'])).has(flag);
}
const uncertain = () => ({ action: 'confirm', rule: 'search-path-unknown', reason: '搜索根路径或参数无法静态确定；请明确指定有限目录。' });

function rootsOf(program, args) {
  if (program === 'find') {
    let i = 0;
    while (['-H', '-L', '-P'].includes(args[i])) i++;
    const roots = [];
    if (args[i] === '--') i++;
    for (; i < args.length; i++) {
      if (args[i].startsWith('-') || ['!', '(', ')'].includes(args[i])) break;
      roots.push(args[i]);
    }
    return { roots: roots.length ? roots : ['.'], unknown: args.includes('-files0-from') };
  }
  if (['dir', 'get-childitem', 'gci'].includes(program)) {
    const recursive = args.some((a) => program === 'dir' ? /^\/s$/i.test(a) : /^-(r|recurse)(:.*)?$/i.test(a));
    if (!recursive) return { roots: [] };
    const roots = []; let unknown = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (/^\/[a-z:-]+$/i.test(arg) && program === 'dir') continue;
      if (/^-(path|literalpath)(:|$)/i.test(arg)) { const colon = arg.indexOf(':'); roots.push(colon < 0 ? args[++i] : arg.slice(colon + 1)); continue; }
      if (/^-(depth|filter|include|exclude)$/i.test(arg)) { i++; continue; }
      if (arg.startsWith('-')) { if (!/^-(r|recurse|force|file|directory|hidden)$/i.test(arg)) unknown = true; continue; }
      roots.push(arg);
    }
    return { roots: roots.length ? roots : ['.'], unknown };
  }
  const grep = /^(?:grep|egrep|fgrep|zgrep)$/.test(program);
  if (grep && !args.some((a) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a) || ['--recursive', '--dereference-recursive'].includes(a))) return { roots: [] };
  const patternProgram = grep || ['rg', 'ag', 'ack', 'fd', 'fdfind', 'findstr'].includes(program);
  let patternSeen = !patternProgram || args.includes('--files') || args.includes('--type-list');
  let literal = false, unknown = false;
  const roots = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!literal && arg === '--') { literal = true; continue; }
    if (!literal && program === 'where' && /^\/r$/i.test(arg)) { roots.push(args[++i]); continue; }
    if (!literal && program === 'where' && arg.startsWith('/')) continue;
    if (!literal && program === 'findstr' && /^\/[a-z]+(?::.*)?$/i.test(arg)) { if (/^\/c:/i.test(arg)) patternSeen = true; continue; }
    if (!literal && arg.startsWith('-')) {
      const equals = arg.indexOf('='), key = equals < 0 ? arg : arg.slice(0, equals);
      if (takesValue(program, key)) {
        if (['-e', '--regexp', '-f', '--file'].includes(key)) patternSeen = true;
        if (equals < 0 && args[++i] === undefined) unknown = true;
      } else if (/^-[ef].+/.test(arg)) patternSeen = true;
      // Other combined short flags with attached values cannot define a root.
      else if (/^-[a-zA-Z]{2,}$/.test(arg) && /[efg]/.test(arg.slice(1)) && !['--files', '--hidden'].includes(arg)) {
        if (!/^(?:grep|egrep|fgrep|zgrep)$/.test(program) || /[ef]/.test(arg.slice(1))) unknown = true;
      }
      continue;
    }
    if (!patternSeen) { patternSeen = true; continue; }
    roots.push(arg);
  }
  // `where /R root pattern`: the filename pattern is not a traversal root.
  if (program === 'where' && args.some((a) => /^\/r$/i.test(a))) return { roots: roots.slice(0, 1), unknown };
  return { roots: roots.length ? roots : ['.'], unknown };
}

export function checkWholeDiskSearch(program, args, options) {
  if (!options.blockWholeDisk || !SEARCH_PROGRAMS.has(program)) return null;
  const { roots, unknown } = rootsOf(program, args);
  let decision = unknown ? uncertain() : null;
  for (const raw of roots) {
    if (!raw) { decision = uncertain(); continue; }
    const resolved = resolveTarget(raw, options.cwd, options.home, options.platform);
    if (!resolved?.path || options.cwdUnknown && !/^([a-z]:[\\/]|\/|\\\\)/i.test(raw)) { decision = uncertain(); continue; }
    const target = resolved.path;
    if (isDriveRoot(target) || isUncRoot(target) || isHomeRoot(target, options.home, options.platform)) {
      return { action: 'block', rule: 'whole-disk-search', reason: `整盘或主目录搜索被拒绝（${program} ${raw}）；管道接 head 或外层 timeout 不能证明遍历范围有限。改用 search_files("<name-pattern>") 或 es.exe；内容搜索请限定目录：rg -n "<pattern>" ${stripTrailingSep(options.projectRoot)}。` };
    }
    if (hasGlob(raw)) {
      // A glob at a root can fan out over the entire drive or home directory.
      const prefix = raw.slice(0, raw.search(/[*?[]/)).replace(/\/+$/, '') || '/';
      const base = resolveTarget(prefix, options.cwd, options.home, options.platform);
      if (base?.path && (isDriveRoot(base.path) || isUncRoot(base.path) || isHomeRoot(base.path, options.home, options.platform))) return { action: 'block', rule: 'whole-disk-search', reason: '根目录上的搜索通配符会扩大遍历范围；请使用 search_files 或指定有限目录后 rg -n。' };
      decision = uncertain();
    }
  }
  return decision;
}
