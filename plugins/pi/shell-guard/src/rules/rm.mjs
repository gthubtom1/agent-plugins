// Deletion policy.
//
// Deleting must stay possible: caches, build output and scratch files are
// routine. What must not happen is an unrecoverable wipe of a drive, the user
// profile or a system directory. Note that Git Bash `rm` does NOT use the
// Windows Recycle Bin, so `rm` here is genuinely destructive.
//
// Tiers:
//   T0 allow            single path, inside the project, no glob
//   T1 allow + note     generated trees inside the project (recursive ok)
//   T2 confirm          recursive outside the project, globs, project root, .git
//   T3 block            drive root, home root, system dirs, wildcard at root

import path from 'node:path';
import {
  HOME, TMP, hasGlob, isDriveRoot, isHomeRoot, isSystemPath, isUncRoot, isUnder,
  resolveTarget, stripTrailingSep,
} from '../paths.mjs';
import { covered } from '../grants.mjs';

const POSIX_RM = new Set(['rm', 'unlink', 'shred', 'sdel', 'truncate']);
const WIN_DEL = new Set(['del', 'erase', 'rd', 'rmdir']);
const PS_DEL = new Set(['remove-item', 'ri', 'erase']);
const GENERATED = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'coverage', '.cache', '.next',
  '.nuxt', '.venv', 'venv', '__pycache__', '.pytest_cache', '.turbo', '.parcel-cache',
  'tmp', 'temp', '.tmp',
]);

const SEVERITY = { allow: 0, confirm: 1, block: 2 };

export function worst(a, b) {
  // Higher severity wins; on a tie the later, more specific rule wins.
  return SEVERITY[b.action] >= SEVERITY[a.action] ? b : a;
}

function recursiveFlag(program, args) {
  if (POSIX_RM.has(program)) return args.some((t) => /^-[a-zA-Z]*r/i.test(t) || t === '--recursive');
  if (WIN_DEL.has(program)) return args.some((t) => /^\/s$/i.test(t));
  if (PS_DEL.has(program)) return args.some((t) => /^-recurse/i.test(t));
  return false;
}

function forceFlag(program, args) {
  if (POSIX_RM.has(program)) return args.some((t) => /^-[a-zA-Z]*f/i.test(t) || t === '--force');
  if (WIN_DEL.has(program)) return args.some((t) => /^\/[qfy]$/i.test(t));
  if (PS_DEL.has(program)) return args.some((t) => /^-force/i.test(t));
  return false;
}

function targetsOf(program, args) {
  const optionLike = (t) => {
    if (t.startsWith('--')) return true;
    if (t.startsWith('-')) return true;
    if (WIN_DEL.has(program) && /^\/[a-zA-Z]$/.test(t)) return true;
    return false;
  };
  return args.filter((t) => !optionLike(t));
}

function classifyTarget(resolved, options, { recursive, force, raw }) {
  const projectRoot = stripTrailingSep(options.projectRoot || options.cwd || process.cwd());
  const protectedPaths = options.protectedPaths || [];

  if (resolved.dynamic) {
    return { action: 'confirm', tier: 'T2', rule: 'rm-dynamic-target',
      reason: `删除目标是动态路径（${raw}），无法静态确认范围，需要明确确认。` };
  }

  const rawTarget = stripTrailingSep(resolved.path);
  // Resolve links/junctions before judging containment: a junction inside the
  // project can still point at C:\\Windows.
  const target = stripTrailingSep(
    typeof options.realpath === 'function' ? options.realpath(rawTarget) ?? rawTarget : rawTarget,
  );
  const granted = covered(target, options.grants);

  if (isDriveRoot(target)) {
    return { action: 'block', tier: 'T3', rule: 'rm-drive-root',
      reason: `拒绝删除磁盘根目录（${target}）：这等于清空整个盘且不进回收站，无法恢复。如需清理缓存，请指向具体目录。` };
  }
  if (isUncRoot(target)) {
    return { action: 'block', tier: 'T3', rule: 'rm-unc-root',
      reason: `拒绝删除网络共享根目录（${target}）：影响范围不受本机控制。` };
  }
  if (isHomeRoot(target, options.home || HOME)) {
    return { action: 'block', tier: 'T3', rule: 'rm-home-root',
      reason: `拒绝删除用户主目录（${target}）：会连带清掉配置、密钥和会话。请指向具体子目录。` };
  }
  if (isSystemPath(target)) {
    return { action: 'block', tier: 'T3', rule: 'rm-protected-path',
      reason: `拒绝删除系统目录（${target}）：会导致系统或已装软件不可用。` };
  }
  for (const guarded of protectedPaths) {
    if (isUnder(target, guarded)) {
      return { action: 'block', tier: 'T3', rule: 'rm-protected-path',
        reason: `拒绝删除受保护目录（${target}，属于 ${guarded}）：系统或凭据数据。` };
    }
  }
  if (isUnder(target, TMP) && target !== stripTrailingSep(TMP)) {
    return { action: 'allow', tier: 'T1', rule: 'rm-temp',
      reason: `删除临时目录内容（${target}），允许。` };
  }
  if (hasGlob(raw)) {
    return { action: 'confirm', tier: 'T2', rule: 'rm-glob',
      reason: `删除表达式含通配符（${raw}）：展开范围不确定，需要明确确认。` };
  }
  if (target === projectRoot) {
    if (granted) {
      return { action: 'allow', tier: 'T2', rule: 'rm-user-granted',
        reason: `用户在当前消息里点名删除项目根（${target}），放行；无法从回收站恢复。` };
    }
    return { action: 'confirm', tier: 'T2', rule: 'rm-project-root',
      reason: `删除目标是整个项目根（${target}）：会同时删除 case、Evidence 和未提交工作，需要明确确认。` };
  }
  if (isUnder(target, path.join(projectRoot, '.git'))) {
    if (granted) {
      return { action: 'allow', tier: 'T2', rule: 'rm-user-granted',
        reason: `用户在当前消息里点名删除 .git（${target}），放行；历史将不可恢复。` };
    }
    return { action: 'confirm', tier: 'T2', rule: 'rm-git-dir',
      reason: `删除 .git（${target}）：会丢失全部历史与回滚能力，需要明确确认。` };
  }
  if (isUnder(target, projectRoot)) {
    const base = path.basename(target).toLowerCase();
    if (GENERATED.has(base)) {
      return { action: 'allow', tier: 'T1', rule: 'rm-generated',
        reason: `删除项目内生成目录（${target}），允许；需要时可重新构建。` };
    }
    if (!recursive) return { action: 'allow', tier: 'T0', rule: 'rm-project-file' };
    return { action: 'allow', tier: 'T1', rule: 'rm-project-tree',
      reason: `删除项目内目录树（${target}），允许；无法从回收站恢复。` };
  }

  // Outside the project: never silent when force or recursive.
  if ((recursive || force) && granted) {
    return { action: 'allow', tier: 'T2', rule: 'rm-user-granted',
      reason: `用户在当前消息里点名删除项目外路径（${target}），放行；无法从回收站恢复。` };
  }
  if (recursive || force) {
    return { action: 'confirm', tier: 'T2', rule: 'rm-outside-project',
      reason: `删除项目外路径（${target}，recursive=${recursive}, force=${force}）：需要明确确认。` };
  }
  if (granted) {
    return { action: 'allow', tier: 'T2', rule: 'rm-user-granted',
      reason: `用户在当前消息里点名删除项目外文件（${target}），放行。` };
  }
  return { action: 'confirm', tier: 'T2', rule: 'rm-outside-project-plain',
    reason: `删除项目外文件（${target}）：需要明确确认。` };
}

/** rm / del / Remove-Item and close relatives. */
export function checkDelete(program, args, options) {
  if (!POSIX_RM.has(program) && !WIN_DEL.has(program) && !PS_DEL.has(program)) return null;
  if (!options.rm?.policy || options.rm.policy === 'off') return null;

  const recursive = recursiveFlag(program, args);
  const force = forceFlag(program, args);
  const targets = targetsOf(program, args);

  if (!targets.length) {
    return { action: 'block', tier: 'T3', rule: 'rm-no-target',
      reason: '删除命令没有目标路径，可能等待标准输入，已拒绝。' };
  }

  let decision = { action: 'allow', tier: 'T0', rule: 'rm-ok' };
  for (const raw of targets) {
    const resolved = resolveTarget(raw, options.cwd, options.home || HOME);
    if (resolved) decision = worst(decision, classifyTarget(resolved, options, { recursive, force, raw }));
    // Git Bash strips unquoted backslashes: `rm -rf C:\\x\\y` becomes a path that
    // does not exist, and `rm -f` ignores missing paths, so the command reports
    // success while deleting nothing. Ask instead of guessing. Classification
    // still runs first so a T3 target stays a block.
    if (raw.includes('\\') && !isQuoted(raw, options.commandText)) {
      decision = worst(decision, {
        action: 'confirm', tier: 'T2', rule: 'rm-unquoted-backslash',
        reason: `删除目标含未加引号的反斜杠（${raw}）：Git Bash 会把反斜杠当转义吃掉，命令可能静默什么也不删。改用正斜杠（D:/path）或给路径加引号。`,
      });
    }
    if (decision.action === 'block') break;
  }
  return decision.action === 'allow' && !decision.reason ? { ...decision, reason: undefined } : decision;
}

/** git clean -fdx and friends: deletes untracked work silently. */
export function checkGitClean(args, options) {
  if (!options.rm?.policy || options.rm.policy === 'off') return null;
  const dryRun = args.some((t) => /^(-n|--dry-run)$/.test(t));
  const forced = args.some((t) => /^-[a-zA-Z]*f/.test(t));
  if (dryRun || !forced) return null;
  return { action: 'confirm', tier: 'T2', rule: 'git-clean',
    reason: 'git clean 会删除未跟踪文件（包含未提交的分析笔记/补丁），需要明确确认。' };
}

/** find ... -delete, xargs rm, and inline scripted deletes. */
export function checkIndirectDelete(program, args, options) {
  if (!options.rm?.policy || options.rm.policy === 'off') return null;

  if (program === 'find' && args.includes('-delete')) {
    return { action: 'confirm', tier: 'T2', rule: 'find-delete',
      reason: 'find -delete 会批量删除匹配文件，需要明确确认。' };
  }
  if (program === 'xargs' && args.some((t) => /^(rm|del|unlink)$/i.test(t))) {
    return { action: 'confirm', tier: 'T2', rule: 'xargs-rm',
      reason: 'xargs rm 的删除目标来自上游输出，范围不确定，需要明确确认。' };
  }
  if (program === 'python' || program === 'python3' || program === 'py' || program === 'node') {
    // Only literal paths are judged. A build script that deletes `STAGE` (a
    // variable) or merely writes documentation containing the call name must not
    // be treated as a delete; `rmtree('/')` must be.
    const found = scriptedDeletes(options.commandText || args.join(' '), options);
    if (found && found.action !== 'allow') return found;
  }
  if (program === 'truncate') {
    return { action: 'confirm', tier: 'T2', rule: 'truncate',
      reason: 'truncate 会清空目标文件内容且不可恢复，需要明确确认。' };
  }
  return null;
}

const SCRIPT_DELETE = /(?:shutil\.rmtree|rmtree|os\.remove|os\.unlink|fs\.rmSync|fs\.unlinkSync|rimraf|rmSync|rmdirSync)\s*\(\s*['"]([^'"]+)['"]/g;

function scriptedDeletes(source, options) {
  let decision = null;
  for (const match of String(source).matchAll(SCRIPT_DELETE)) {
    const resolved = resolveTarget(match[1], options.cwd, options.home || HOME);
    if (!resolved?.path) continue;
    const next = classifyTarget(resolved, options, { recursive: true, force: true, raw: match[1] });
    decision = decision ? worst(decision, next) : next;
  }
  return decision;
}

function isQuoted(raw, commandText) {
  if (!commandText) return false;
  return commandText.includes(`"${raw}"`) || commandText.includes(`'${raw}'`);
}

export { GENERATED };
