// Pure, bounded heuristic policy. Unsupported syntax confirms; never a sandbox.
import { normalizeOptions } from './config.mjs';
import { readGrants } from './grants.mjs';
import { isAbsoluteAny, resolveTarget } from './paths.mjs';
import { parseShell, programName, streamsDetached } from './split.mjs';
import { unwrap } from './wrappers.mjs';
import { checkDelete, checkGitClean, checkIndirectDelete, worst } from './rules/rm.mjs';
import { checkInteractive } from './rules/interactive.mjs';
import { checkWholeDiskSearch } from './rules/search.mjs';
import { clampExplicit, classify } from './rules/timeout.mjs';

const CLASS_RANK = { fast: 0, default: 1, heavy: 2 };
const uncertain = (rule, reason) => ({ action: 'confirm', tier: 'T2', rule, reason });
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'pwsh', 'powershell', 'cmd']);
const CONTROL = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'eval', 'source', '.', 'alias', 'unalias', 'trap']);

export function evaluate(command, input = {}) {
  try { return evaluateCommand(command, input, 0); }
  catch {
    return { action: 'block', timeout: 120, reason: '策略发生内部或配置错误，未完成评估，已拒绝执行。', rule: 'policy-error', tier: 'T3' };
  }
}

function evaluateCommand(command, input, depth, inheritedGrants) {
  const base = normalizeOptions(input);
  const timeoutDefault = () => clampExplicit(base.explicitTimeout, base) ?? Math.min(base.timeout.default, base.timeout.ceiling);
  if (base.enabled === false) return { action: 'allow', rule: 'disabled', timeout: timeoutDefault() };
  const grants = inheritedGrants !== undefined ? inheritedGrants : base.rm?.grantFromUserText === false ? null : readGrants(input.userText ?? '', base);
  const parsed = parseShell(command);
  let decision = { action: 'allow', rule: 'default' }, heaviest = 'fast';
  const notes = new Set();
  const merge = (candidate) => {
    if (!candidate) return;
    decision = worst(decision, candidate);
    if (candidate.action !== 'allow' && candidate.reason) notes.add(candidate.reason);
  };
  if (parsed.uncertain) merge(uncertain('shell-syntax-unknown', '命令含未支持或不完整的 shell 语法，需要明确确认。'));
  let states = [{ cwd: base.cwd, cwdUnknown: input.cwdUnknown === true }], jobStart = states;
  for (const [index, segment] of parsed.segments.entries()) {
    const incoming = ['|', '|&'].includes(parsed.segments[index - 1]?.connector);
    const outgoing = ['|', '|&'].includes(segment.connector);
    if (segment.background && base.requireBackgroundRedirect && !streamsDetached(segment, outgoing)) {
      merge({ action: 'block', rule: 'background-no-redirect', reason: '每个后台任务的 stdout 和 stderr 都必须脱离执行器；仅重定向 stdin 不够。请使用 >log 2>&1 &。' });
    }
    const nextStates = states.slice();
    for (const state of states) {
      let commandTokens = segment.tokens;
      if (['then', 'do', 'else', 'if', 'elif', 'while', 'until', '!'].includes(programName(commandTokens[0]?.value))) {
        merge(uncertain('shell-control-flow', '控制流无法完整静态求值；仍检查显式子命令，需要明确确认。'));
        commandTokens = commandTokens.slice(1);
      }
      const inner = unwrap(commandTokens, { ...base, ...state });
      const { program, args } = inner;
      const envCwdUnknown = commandTokens.some((token) => /^(CDPATH|HOME|PWD|OLDPWD)=/.test(token.value));
      if (envCwdUnknown) {
        nextStates.push({ cwd: state.cwd, cwdUnknown: true });
        merge(uncertain('shell-environment-cwd', '命令显式改变目录解析相关环境，不能据此推定相对路径安全。'));
      }
      const options = {
        ...base, ...state, cwdUnknown: state.cwdUnknown || envCwdUnknown, cwd: inner.cwd, grants, commandText: command,
        argTokens: inner.argTokens, heredocs: segment.heredocs,
        stdinSources: [...segment.heredocs.map((item) => item.body), ...segment.redirects.filter((item) => item.fd === 0 && item.op === '<<<').map((item) => item.target.value)],
        resolveScriptTarget: (raw) => resolveTarget(raw, inner.cwd, base.home, base.platform),
      };
      if (inner.uncertain) {
        merge(uncertain('wrapper-unknown', '包装器参数或程序名不确定，需要明确确认。'));
        // Uncertainty cannot downgrade an explicit hard target in the residual
        // argv of a recognized wrapper. Do not apply this to arbitrary prose.
        for (let i = 1; i < commandTokens.length; i++) {
          const fallback = checkDelete(programName(commandTokens[i].value), commandTokens.slice(i + 1).map((token) => token.value), options);
          if (fallback?.action === 'block') merge(fallback);
        }
        const splitFlag = commandTokens.findIndex((token) => token.value === '-S' || token.value === '--split-string' || token.value.startsWith('--split-string='));
        if (splitFlag >= 0 && programName(commandTokens[0].value) === 'env') {
          const value = commandTokens[splitFlag].value;
          const source = value.includes('=') ? value.slice(value.indexOf('=') + 1) : commandTokens[splitFlag + 1]?.value;
          if (source && depth < 4) {
            const nested = evaluateCommand(source, { ...input, cwd: inner.cwd, cwdUnknown: options.cwdUnknown }, depth + 1, grants);
            if (nested.action === 'block') merge(nested);
          }
        }
      }
      if (!program) continue;
      if (CONTROL.has(program) || ['pushd', 'popd', 'set-location', 'sl', 'chdir'].includes(program)) {
        merge(uncertain('shell-state-unknown', '命令改变或动态解释 shell 状态，需要明确确认。'));
        nextStates.push({ cwd: state.cwd, cwdUnknown: true });
      }
      if (segment.tokens.some((token) => token.expansion) || segment.redirects.some((redirect) => redirect.target.expansion)) {
        merge(uncertain('shell-expansion', '命令含命令替换或动态展开，需要明确确认。'));
      }
      const optionsForDelete = options;
      merge(checkDelete(program, args, optionsForDelete));
      merge(checkIndirectDelete(program, args, optionsForDelete));
      if (program === 'git') {
        // Global git options can precede the subcommand; all clean forms confirm.
        const clean = args.indexOf('clean');
        if (clean >= 0) merge(checkGitClean(args.slice(clean + 1), options));
      }
      merge(checkWholeDiskSearch(program, args, options));
      merge(checkInteractive(program, args, options, {
        piped: incoming || segment.redirects.some(({ fd }) => fd === 0) || segment.heredocs.length > 0,
        background: segment.background && streamsDetached(segment, outgoing),
      }));
      if (SHELLS.has(program)) {
        let source;
        const flag = args.findIndex((value) => /^-(?:[a-z]*c|command)$/i.test(value) || /^\/(?:c|k)$/i.test(value));
        if (flag >= 0) source = args[flag + 1];
        else if (options.stdinSources.length && (args.includes('-s') || args.every((arg) => arg.startsWith('-')))) source = options.stdinSources.join('\n');
        if (source !== undefined) {
          if (depth >= 4) merge(uncertain('nested-shell-limit', '嵌套 shell 超过解析范围，需要明确确认。'));
          else {
            const nested = evaluateCommand(source, { ...input, cwd: inner.cwd, cwdUnknown: options.cwdUnknown }, depth + 1, grants);
            merge(nested);
            if (CLASS_RANK[nested.klass] > CLASS_RANK[heaviest]) heaviest = nested.klass;
          }
          if (!['bash', 'sh', 'zsh', 'dash'].includes(program)) merge(uncertain('shell-dialect-unknown', '内联命令使用不同 shell 方言，需要明确确认。'));
        } else if (args.some((a) => /^-(?:encodedcommand|enc)$/i.test(a))) merge(uncertain('encoded-shell', '编码命令无法静态审查，需要明确确认。'));
      }
      if (program === 'cd' && !incoming && !outgoing) {
        const values = args.filter((arg) => !['--', '-L', '-P'].includes(arg));
        const target = values.length === 0 ? { path: base.home } : values.length === 1 ? resolveTarget(values[0], inner.cwd, base.home, base.platform) : null;
        if (!target?.path || options.cwdUnknown && !isAbsoluteAny(values[0] ?? '')) {
          nextStates.push({ cwd: state.cwd, cwdUnknown: true });
          merge(uncertain('cd-unknown', '无法确定 cd 后的工作目录，需要明确确认。'));
        } else nextStates.push({ cwd: target.path, cwdUnknown: false });
      }
      const klass = classify(program, args);
      if (CLASS_RANK[klass] > CLASS_RANK[heaviest]) heaviest = klass;
    }
    // Keep success and failure paths: cd may fail before a semicolon/newline or
    // a logical list. Never let a guessed cwd establish an automatic grant.
    states = [...new Map(nextStates.map((state) => [JSON.stringify(state), state])).values()];
    if (states.length > 16) { states = [{ cwd: base.cwd, cwdUnknown: true }]; merge(uncertain('cwd-state-limit', '工作目录分支超过解析范围，需要明确确认。')); }
    if (segment.connector === '&') { states = jobStart; jobStart = states; }
    else if ([';', '\n'].includes(segment.connector)) jobStart = states;
  }
  const timeout = clampExplicit(base.explicitTimeout, base) ?? Math.min(base.timeout[heaviest], base.timeout.ceiling);
  // Allow patterns may annotate already safe commands, never suppress a rule.
  if (decision.action === 'allow') {
    for (const pattern of base.allow) {
      try { if (typeof pattern === 'string' && new RegExp(pattern).test(command)) decision.rule = 'allowlist'; } catch { /* ignore invalid patterns */ }
    }
  }
  return { action: decision.action, timeout, reason: notes.size ? [...notes].join(' ') : decision.reason, rule: decision.rule, tier: decision.tier, klass: heaviest };
}

export { normalizeOptions };
