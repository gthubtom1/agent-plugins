// Deletion grants.
//
// Problem: the guard must not stop the user from deleting what they asked for,
// and it must not be possible to widen the scope behind their back.
//
// Approach: read the *user's own* current message. A target may proceed without a
// confirmation prompt only when the user's message
//   1. contains a delete verb, and
//   2. names a path that contains (or equals) the target.
// The model cannot add text to a user message, so it cannot mint a grant. Grants
// never apply to T3 (drive root, home root, system directories) and never to
// globs or indirect deletes, because those cannot be matched to named paths.

import { isUnder, resolveTarget, stripTrailingSep } from './paths.mjs';

const DELETE_VERB = /(删除|删掉|清空|清理|移除|清除|remove|delete|wipe|erase|clean\s+up|\brm\b)/i;

const QUOTED = /[`"'「『]([^`"'「」『』]{1,300})[`"'」』]/g;
const PATHLIKE = /(?:[A-Za-z]:[\\/]|\/d\/|\/(?:c|e)\/|\.{1,2}[\\/]|~[\\/])[^\s,;:，。；、)）`"'<>|]+/g;
const BARE_NAME = /(?:^|[\s（(、,，])([A-Za-z0-9._\-\u4e00-\u9fff]{2,80}[\\/][A-Za-z0-9._\-\u4e00-\u9fff\\/]*)/g;

/**
 * @returns {{verbs:boolean, paths:string[], raws:string[]}}
 */
export function readGrants(text, { cwd = process.cwd(), home } = {}) {
  const source = String(text ?? '');
  const verbs = DELETE_VERB.test(source);
  const raws = new Set();

  for (const match of source.matchAll(QUOTED)) raws.add(match[1]);
  for (const match of source.matchAll(PATHLIKE)) raws.add(match[0]);
  for (const match of source.matchAll(BARE_NAME)) raws.add(match[1]);

  const paths = [];
  for (const raw of raws) {
    const cleaned = raw.trim().replace(/[.。,;；:：]+$/, '');
    if (!cleaned) continue;
    const resolved = resolveTarget(cleaned, cwd, home);
    if (resolved?.path) paths.push(stripTrailingSep(resolved.path));
  }
  return { verbs, paths: [...new Set(paths)], raws: [...raws] };
}

/** True when every part of the target is covered by a user-named path. */
export function covered(target, grants) {
  if (!grants?.verbs || !grants.paths?.length) return false;
  const normalised = stripTrailingSep(target);
  return grants.paths.some((granted) => isUnder(normalised, granted));
}
