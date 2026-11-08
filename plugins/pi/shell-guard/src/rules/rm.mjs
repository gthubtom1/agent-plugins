// Tiered heuristic deletion checks. No filesystem writes or process execution.
import { HOME, hasGlob, isAbsoluteAny, isDriveRoot, isHomeRoot, isSystemPath, isUncRoot, isUnder, normalisePath, resolveTarget } from '../paths.mjs';
import { covered } from '../grants.mjs';
import { programName } from '../split.mjs';
import { scriptedDeletes } from './scripts.mjs';

const POSIX_RM = new Set(['rm', 'unlink', 'shred', 'sdel', 'truncate']);
const WIN_DEL = new Set(['del', 'erase', 'rd', 'rmdir']);
const PS_DEL = new Set(['remove-item', 'ri']);
const GENERATED = new Set(['node_modules', 'dist', 'build', 'target', 'coverage', '.cache', '.next', '.nuxt', '.venv', '__pycache__', '.pytest_cache', '.turbo', '.parcel-cache']);
const SEVERITY = { allow: 0, confirm: 1, block: 2 };
export const worst = (a, b) => SEVERITY[b.action] >= SEVERITY[a.action] ? b : a;
const confirm = (rule, reason) => ({ action: 'confirm', tier: 'T2', rule, reason });
const block = (rule, target) => ({ action: 'block', tier: 'T3', rule, reason: `拒绝删除根目录、系统或受保护路径（${target}），包括会影响其内容的祖先路径。` });

function deletionArgs(program, args) {
  let recursive = WIN_DEL.has(program), uncertain = false, literal = false;
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (literal) { targets.push(token); continue; }
    if (token === '--') { literal = true; continue; }
    if (PS_DEL.has(program)) {
      if (/^-(literalpath|path)(:|$)/i.test(token)) {
        const colon = token.indexOf(':');
        const value = colon < 0 ? args[++i] : token.slice(colon + 1);
        if (value) targets.push(value); else uncertain = true;
        continue;
      }
      if (/^-(r|recurse)(:|$)/i.test(token)) { recursive = !/:\$?false$/i.test(token); continue; }
      if (/^-(force|f|whatif|confirm)(:.*)?$/i.test(token)) continue;
      if (/^-(erroraction|warningaction|informationaction|filter|include|exclude)$/i.test(token)) {
        if (args[++i] === undefined) uncertain = true;
        // Filters can change the selected target; they never establish safety.
        uncertain = true; continue;
      }
      if (token.startsWith('-')) { uncertain = true; continue; }
    } else if (WIN_DEL.has(program) && /^\/[a-z](?::.*)?$/i.test(token)) {
      if (/^\/s$/i.test(token)) recursive = true;
      else if (!/^\/[qfpay]$/i.test(token)) uncertain = true;
      continue;
    } else if (token.startsWith('-')) {
      if (token === '--recursive' || /^-[a-z]*r[a-z]*$/i.test(token)) recursive = true;
      if (!/^-[rRfivdIP]+$/.test(token) && !['--recursive', '--force', '--verbose', '--dir', '--preserve-root', '--no-preserve-root', '--one-file-system'].includes(token)) uncertain = true;
      if (token === '-d' || token === '--dir') recursive = true;
      continue;
    }
    targets.push(token);
  }
  return { targets, recursive, uncertain };
}

export function hardTarget(candidate, options) {
  const platform = options.platform;
  if (isDriveRoot(candidate)) return block('rm-drive-root', candidate);
  if (isUncRoot(candidate)) return block('rm-unc-root', candidate);
  if (isHomeRoot(candidate, options.home || HOME, platform)) return block('rm-home-root', candidate);
  if (isSystemPath(candidate, platform)) return block('rm-protected-path', candidate);
  for (const guarded of options.protectedPaths || []) {
    if (isUnder(candidate, guarded, platform) || isUnder(guarded, candidate, platform)) return block('rm-protected-path', candidate);
  }
  return null;
}

export function classifyTarget(resolved, options, { recursive, raw }) {
  const platform = options.platform;
  if (hasGlob(raw)) {
    const beforeGlob = raw.slice(0, raw.search(/[*?[]/));
    const boundary = Math.max(beforeGlob.lastIndexOf('/'), platform === 'win32' ? beforeGlob.lastIndexOf('\\') : -1);
    const prefix = boundary < 0 ? '.' : beforeGlob.slice(0, boundary + 1);
    const resolvedPrefix = resolveTarget(prefix, options.cwd, options.home, platform);
    if (resolvedPrefix) {
      const hard = classifyTarget(resolvedPrefix, options, { recursive: true, raw: prefix });
      if (hard.action === 'block') return { ...hard, rule: 'rm-broad-glob', reason: `删除通配符的静态目录前缀涉及根、系统、主目录祖先或受保护路径（${prefix}），禁止通过确认扩大范围。` };
    }
    return confirm('rm-glob', '删除目标含通配符，展开范围需要明确确认。');
  }
  if (resolved.dynamic) return confirm('rm-dynamic-target', '删除目标含动态表达式，无法静态确定范围。');
  const lexical = resolved.path;
  const lexicalHard = hardTarget(lexical, options);
  if (lexicalHard) return lexicalHard;
  let target = lexical;
  if (options.realpath) {
    try {
      const actual = options.realpath(lexical);
      if (typeof actual !== 'string' || !isAbsoluteAny(actual)) return confirm('rm-realpath-unknown', '无法确定删除目标的实际路径。');
      target = normalisePath(actual, platform);
    } catch { return confirm('rm-realpath-unknown', '无法确定删除目标的实际路径。'); }
  }
  // Check both spellings: a symlink cannot remove a lexical protection, and a
  // generated directory cannot grant deletion of its external referent.
  const actualHard = hardTarget(target, options);
  if (actualHard) return actualHard;
  if (options.cwdUnknown && !isAbsoluteAny(raw)) return confirm('rm-cwd-unknown', '先前命令改变了工作目录，当前相对删除范围不确定。');
  const projectRoot = normalisePath(options.projectRoot || options.cwd, platform);
  const exact = (a, b) => isUnder(a, b, platform) && isUnder(b, a, platform);
  // A grant names the lexical target exactly; it never authorizes following a
  // link to a different destination. Root/system checks always run first.
  if (exact(lexical, target) && covered(lexical, options.grants)) {
    return { action: 'allow', tier: 'T2', rule: 'rm-user-granted', reason: '当前直接用户指令精确点名此删除路径。' };
  }
  if (!exact(lexical, target)) return confirm('rm-link-target', '删除目标经链接指向其他路径，需要确认实际影响范围。');
  if (exact(target, projectRoot)) return confirm('rm-project-root', '删除整个项目根目录需要明确确认。');
  if (isUnder(target, `${projectRoot}/.git`, platform)) return confirm('rm-git-dir', '删除 Git 数据需要明确确认。');
  if (isUnder(target, projectRoot, platform)) {
    const relative = target.slice(projectRoot.length + 1).split('/');
    // Only a literal generated subtree directly under the configured project
    // root gets the default grant; matching an arbitrary nested name is unsafe.
    const generated = GENERATED.has(platform === 'win32' ? relative[0].toLowerCase() : relative[0]);
    if (generated) return { action: 'allow', tier: 'T1', rule: 'rm-generated', reason: '允许清理项目内生成目录或其内容。' };
    if (!recursive) return { action: 'allow', tier: 'T0', rule: 'rm-project-file' };
    return confirm('rm-project-tree', '项目内非生成目录的递归删除需要精确用户指令或确认。');
  }
  return confirm('rm-outside-project', '删除项目外路径需要精确用户指令或确认。');
}

export function checkDelete(program, args, options) {
  if (!POSIX_RM.has(program) && !WIN_DEL.has(program) && !PS_DEL.has(program)) return null;
  if (options.rm?.policy === 'off') return null;
  const parsed = deletionArgs(program, args);
  if (PS_DEL.has(program)) {
    parsed.targets = parsed.targets.flatMap((raw) => {
      const token = options.argTokens?.find((item) => item.value === raw);
      if (!raw.includes(',') || token && /^['"]/.test(token.raw)) return [raw];
      parsed.uncertain = true;
      return raw.split(',');
    });
  }
  if (!parsed.targets.length) return block('rm-no-target', '未指定目标');
  let decision = { action: 'allow', tier: 'T0', rule: 'rm-ok' };
  for (const raw of parsed.targets) {
    const drive = /^[a-z]:/i.exec(options.cwd);
    const targetRaw = PS_DEL.has(program) && options.platform === 'win32' && /^\/(?!\/)/.test(raw) && drive ? drive[0] + raw : raw;
    const resolved = resolveTarget(targetRaw, options.cwd, options.home, options.platform);
    if (resolved) decision = worst(decision, classifyTarget(resolved, options, { ...parsed, raw }));
    else decision = worst(decision, confirm('rm-empty-target', '空删除目标需要确认。'));
    const token = options.argTokens?.find((item) => item.value === raw);
    if (raw.includes('\\') && (!token || token.dynamic || !/^['"]/.test(token.raw))) {
      decision = worst(decision, confirm('rm-unquoted-backslash', '未加引号的反斜杠路径在 shell 中有歧义；请使用正斜杠或引用路径。'));
    }
  }
  if (parsed.uncertain) decision = worst(decision, confirm('rm-unknown-option', '无法可靠解析删除参数，需要明确确认。'));
  if (['shred', 'sdel', 'truncate'].includes(program)) decision = worst(decision, confirm('rm-destructive-tool', '此工具会不可恢复地覆盖或清空数据，需要明确确认。'));
  return decision;
}

export function checkGitClean(args, options) {
  if (options.rm?.policy === 'off') return null;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--') break;
    if (token === '--exclude' || token === '-e') { i++; continue; }
    if (token.startsWith('--exclude=')) continue;
    if (token === '--dry-run') dryRun = true;
    else if (/^-[^-]/.test(token)) {
      for (let j = 1; j < token.length; j++) {
        if (token[j] === 'e') { if (j === token.length - 1) i++; break; }
        if (token[j] === 'n') dryRun = true;
      }
    }
  }
  if (dryRun) return null;
  return confirm('git-clean', 'git clean 会删除未跟踪文件，需要明确确认。');
}

export function checkIndirectDelete(program, args, options) {
  if (options.rm?.policy === 'off') return null;
  if (program === 'find' && args.some((t) => ['-delete', '-exec', '-execdir', '-ok', '-okdir'].includes(t))) {
    let decision = confirm('find-delete', 'find 的删除或执行动作具有动态目标，需要明确确认。');
    const i = args.findIndex((t) => ['-exec', '-execdir', '-ok', '-okdir'].includes(t));
    if (i >= 0) {
      const child = args.slice(i + 1), end = child.findIndex((t) => [';', '+'].includes(t));
      const result = checkDelete(programName(child[0]), child.slice(1, end < 0 ? undefined : end), options);
      if (result) decision = worst(decision, result);
    }
    return decision;
  }
  if (program === 'xargs') {
    const i = args.findIndex((t) => POSIX_RM.has(programName(t)) || WIN_DEL.has(programName(t)) || PS_DEL.has(programName(t)));
    if (i >= 0) {
      const explicit = checkDelete(programName(args[i]), args.slice(i + 1), options);
      return worst(explicit?.rule === 'rm-no-target' ? { action: 'allow' } : explicit || { action: 'allow' }, confirm('xargs-rm', 'xargs 删除目标来自上游，范围需要明确确认。'));
    }
    return null;
  }
  if (['python', 'python3', 'py', 'node', 'nodejs', 'bun', 'deno'].includes(program)) {
    return scriptedDeletes(program, args, options, classifyTarget);
  }
  return null;
}

export { GENERATED };
