// Decision aggregation. Every rule is pure; this module only orders them and
// combines their verdicts. Rules run in this order:
//   1. hard blocks (destructive, whole-disk, interactive, background)
//   2. confirm-tier deletions
//   3. allow, with a timeout class
// Any internal error must fail open: returning "allow" is always safer than
// breaking the user's shell.

import { normalizeOptions } from './config.mjs';
import { readGrants } from './grants.mjs';
import { isBackground, hasBackgroundRedirect, programName, splitSegments, words } from './split.mjs';
import { checkDelete, checkGitClean, checkIndirectDelete, worst } from './rules/rm.mjs';
import { checkInteractive } from './rules/interactive.mjs';
import { checkWholeDiskSearch } from './rules/search.mjs';
import { clampExplicit, classify } from './rules/timeout.mjs';

const CLASS_RANK = { fast: 0, default: 1, heavy: 2 };

export function evaluate(command, input = {}) {
  const base = normalizeOptions(input);
  // Grants come from the user's own message for this turn, never from the model.
  const grants = base.rm?.grantFromUserText === false
    ? null
    : readGrants(input.userText ?? '', { cwd: base.cwd, home: base.home });
  const text = String(command ?? '');
  const options = { ...base, grants, commandText: text };

  if (!options.enabled) return { action: 'allow', rule: 'disabled', timeout: clampExplicit(options.explicitTimeout, options) };

  if (Array.isArray(options.allow)) {
    for (const pattern of options.allow) {
      try {
        if (new RegExp(pattern).test(text)) {
          return { action: 'allow', rule: 'allowlist', timeout: clampExplicit(options.explicitTimeout, options) };
        }
      } catch {
        // An invalid allow pattern must not break shell calls.
      }
    }
  }

  const segments = splitSegments(text);
  if (!segments.length) return { action: 'allow', rule: 'empty', timeout: clampExplicit(options.explicitTimeout, options) };

  let decision = { action: 'allow', rule: 'default' };
  let heaviest = 'fast';
  const notes = [];

  for (const [index, segment] of segments.entries()) {
    const tokens = words(segment.text);
    if (!tokens.length) continue;
    const program = programName(tokens[0]);
    const args = tokens.slice(1);

    for (const candidate of [
      checkDelete(program, args, options),
      checkIndirectDelete(program, args, options),
      program === 'git' && args[0] === 'clean' ? checkGitClean(args.slice(1), options) : null,
      checkWholeDiskSearch(program, args, options),
      checkInteractive(program, args, options, { index, piped: index > 0 }),
    ]) {
      if (!candidate) continue;
      decision = worst(decision, candidate);
      if (candidate.reason && candidate.action !== 'allow') notes.push(candidate.reason);
    }

    const klass = classify(program, args);
    if (CLASS_RANK[klass] > CLASS_RANK[heaviest]) heaviest = klass;
  }

  if (options.requireBackgroundRedirect && isBackground(segments, text) && !hasBackgroundRedirect(text)) {
    decision = worst(decision, {
      action: 'block',
      rule: 'background-no-redirect',
      reason: '后台命令没有重定向输出和关闭 stdin，执行器会一直等管道关闭（看起来就是卡死）。改用：cmd > .pi/logs/run.log 2>&1 </dev/null &',
    });
  }

  const limits = options.timeout || {};
  const ceiling = Number(limits.ceiling ?? 1800);
  const baseSeconds = heaviest === 'fast'
    ? Number(limits.fast ?? 60)
    : heaviest === 'heavy' ? Number(limits.heavy ?? 900) : Number(limits.default ?? 120);
  const timeout = clampExplicit(options.explicitTimeout, options) ?? Math.min(baseSeconds, ceiling);

  return {
    action: decision.action,
    rule: decision.rule,
    tier: decision.tier,
    reason: notes.length ? notes.join(' ') : decision.reason,
    timeout,
    klass: heaviest,
  };
}

export { normalizeOptions };
