// Whole-disk search detection.
//
// The failing real-world case was:
//   find / -maxdepth 6 -name "*skinforge*" -newermt "2026-11-06" -type f | head -30
// On Windows, Git Bash maps "/" to the MSYS root, so this walked C:, D: and E:.
// `find`/`grep -r` also ignore .gitignore, and `| head` does not stop them early.

import { isDriveRoot, isHomeRoot, isUncRoot, resolveTarget, hasGlob, stripTrailingSep } from '../paths.mjs';

const RECURSIVE_GREP = new Set(['grep', 'egrep', 'fgrep', 'zgrep']);
const PATH_ROOTS = new Set(['du', 'tree', 'where']);

// /s, /q, /R are Windows switches only for the programs that use them.
// For find/grep/rg/du/tree, "/d" is a drive path, not a flag.
const SWITCH_PROGRAMS = new Set(['dir', 'where', 'findstr']);

function isOption(program, token) {
  if (token.startsWith('-')) return true;
  return SWITCH_PROGRAMS.has(program) && /^\/[a-zA-Z]{1,3}$/.test(token);
}

function rootsOf(program, args) {
  const out = [];
  const push = (token) => {
    if (token) out.push(token);
  };

  if (program === 'find') {
    for (const token of args) {
      if (token === '!' || token === '(' || token === ')') continue;
      if (isOption(program, token)) continue;
      push(token);
      break; // find takes one starting point before expressions
    }
    if (!out.length) out.push('.');
    return out;
  }

  if (RECURSIVE_GREP.has(program)) {
    let patternSeen = false;
    for (const token of args) {
      if (isOption(program, token)) continue;
      if (!patternSeen) {
        patternSeen = true;
        continue;
      }
      push(token);
    }
    return out; // no explicit path -> cwd, which is bounded
  }

  if (program === 'rg' || program === 'ag' || program === 'ack') {
    let patternSeen = false;
    for (const token of args) {
      if (isOption(program, token)) continue;
      if (!patternSeen) {
        patternSeen = true;
        continue;
      }
      push(token);
    }
    return out;
  }

  if (program === 'fd' || program === 'fdfind' || program === 'findstr') {
    for (const token of args) {
      if (isOption(program, token)) continue;
      push(token);
    }
    return out;
  }

  if (PATH_ROOTS.has(program)) {
    for (const token of args) {
      if (isOption(program, token)) continue;
      push(token);
    }
    return out;
  }

  return out;
}

function isBroad(target, options) {
  if (target.dynamic) return false;
  const p = target.path;
  if (!p) return false;
  if (isDriveRoot(p)) return true;
  if (isUncRoot(p)) return true;
  if (isHomeRoot(p, options.home)) return true;
  return false;
}

function searchHint(program, allArgs, rawRoot) {
  const nameIndex = allArgs.findIndex((token) => /^-(name|iname)$/i.test(token));
  if (nameIndex >= 0 && allArgs[nameIndex + 1]) return allArgs[nameIndex + 1];
  // A bare number is usually a depth/count flag value, not a search term.
  return allArgs.find((token) => !isOption(program, token) && token !== rawRoot && !/^\d+$/.test(token)) || '';
}

function suggestion(pattern, options) {
  const es = options.everything?.esPath || 'es.exe';
  const query = pattern && !hasGlob(pattern) && pattern.length <= 60 ? pattern : '<name-pattern>';
  return [
    `改用：search_files("${query}") 或 ${es} -n ${options.everything?.maxResults ?? 50} -json "${query}"（按文件名，毫秒级，全盘）`,
    `内容搜索请限定目录：rg -n "<pattern>" ${options.projectRoot ? stripTrailingSep(options.projectRoot) : '<case目录>'}`,
  ].join('；');
}

/**
 * @returns {{action:'allow'|'block', rule?:string, reason?:string}|null}
 */
export function checkWholeDiskSearch(program, args, options) {
  if (!options.blockWholeDisk) return null;

  // `dir /s` and PowerShell equivalents only matter when they recurse.
  if (program === 'dir') {
    const recursive = args.some((t) => /^\/s$/i.test(t));
    if (!recursive) return null;
    const target = args.filter((t) => !isOption('dir', t) && !t.startsWith('-')).pop();
    if (!target) return null; // cwd
    const resolved = resolveTarget(target, options.cwd, options.home);
    if (resolved && isBroad(resolved, options)) return block(target);
    return null;
  }

  if (program === 'get-childitem' || program === 'gci') {
    const recursive = args.some((t) => /^-recurse/i.test(t));
    if (!recursive) return null;
    const target = args.filter((t) => !isOption('dir', t) && !t.startsWith('-')).pop();
    if (!target) return null;
    const resolved = resolveTarget(target, options.cwd, options.home);
    if (resolved && isBroad(resolved, options)) return block(target);
    return null;
  }

  const roots = rootsOf(program, args);
  if (!roots.length) return null;

  for (const root of roots) {
    const resolved = resolveTarget(root, options.cwd, options.home);
    if (!resolved || !isBroad(resolved, options)) continue;
    return block(root, args);
  }
  return null;

  function block(rawRoot, allArgs = args) {
    const pattern = searchHint(program, allArgs, rawRoot).replace(/^['"]|['"]$/g, '').replace(/\*/g, '');
    return {
      action: 'block',
      rule: 'whole-disk-search',
      reason: [
        `整盘搜索被拒绝（${program} ${rawRoot}）：Git Bash 的 / 是整台机器（/c /d /e），find/grep 不读 .gitignore，管道接 head 也不会提前停止。`,
        suggestion(pattern, options),
      ].join(' '),
    };
  }
}

export const SEARCH_PROGRAMS = new Set([
  'find', 'grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack', 'fd', 'fdfind',
  'findstr', 'du', 'tree', 'where', 'dir', 'get-childitem', 'gci',
]);
