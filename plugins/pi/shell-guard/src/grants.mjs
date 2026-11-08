// userText must be the runtime-attested, current direct user message, never a
// prompt/template/tool result. This parser cannot authenticate text provenance.
// Only one complete affirmative directive naming one literal path is accepted.
import { hasGlob, isUnder, resolveTarget } from './paths.mjs';

export function readGrants(text, { cwd = process.cwd(), home, platform = process.platform } = {}) {
  const empty = { verbs: false, paths: [], raws: [], platform };
  if (typeof text !== 'string' || text.length > 2048 || /[\n\r`<>\0]/.test(text)) return empty;
  const source = text.trim();
  const directive = /^(?:(?:please\s+)?(?:delete|remove)\s+|(?:请|帮我)?(?:删除|删掉|移除)\s*)(.+)$/i.exec(source)
    ?? /^(?:请|帮我)?把\s*(.+?)\s*(?:删掉|删除|移除)$/.exec(source);
  if (!directive) return empty;
  let raw = directive[1];
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    if (raw.at(-1) !== quote || raw.slice(1, -1).includes(quote)) return empty;
    raw = raw.slice(1, -1);
  } else if (!/^[\p{L}\p{N}_.~:/\\-]+$/u.test(raw)) return empty;
  // Prose, lists, shell expressions and broad unnamed requests are not grants.
  if (!raw || /["'`$%{};,，；\r\n]/.test(raw) || hasGlob(raw)
      || /^(?:all|everything|nothing|none|it|them|全部|所有|一切)$/i.test(raw)) return empty;
  const resolved = resolveTarget(raw, cwd, home, platform);
  return resolved?.path ? { verbs: true, paths: [resolved.path], raws: [raw], platform } : empty;
}

export function covered(target, grants) {
  return Boolean(grants?.verbs && grants.paths?.some((path) => isUnder(target, path, grants.platform) && isUnder(path, target, grants.platform)));
}
