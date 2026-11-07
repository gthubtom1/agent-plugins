// Path normalisation shared by every rule. Pure functions, no I/O.
import os from 'node:os';
import path from 'node:path';

const WINDOWS_ABS = /^[a-zA-Z]:[\\/]/;
const UNC = /^\\\\/;

export const HOME = os.homedir();
export const TMP = os.tmpdir();

export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/** Git Bash exposes drives as /c, /d ... ; convert to C:/, D:/ */
export function msysToWin(p) {
  if (p === '/tmp' || p.startsWith('/tmp/')) return path.join(TMP, p.slice(4));
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
  if (m) return `${m[1].toUpperCase()}:${m[2] || '/'}`;
  return p;
}

export function isAbsoluteAny(p) {
  return WINDOWS_ABS.test(p) || p.startsWith('/') || UNC.test(p) || /^[a-zA-Z]:$/.test(p);
}

export function stripTrailingSep(p) {
  const s = toPosix(p);
  if (s === '/' || /^[a-zA-Z]:\/$/.test(s)) return s;
  return s.replace(/\/+$/, '');
}

/**
 * Resolve one target token (as typed) into a normalised absolute path.
 * Returns { path } or { dynamic: true, raw } when the token cannot be resolved
 * statically (variables, command substitution, ~user, unknown globs at root).
 */
export function resolveTarget(token, cwd = process.cwd(), home = HOME) {
  let t = String(token ?? '').trim().replace(/^['"]|['"]$/g, '');
  if (!t) return null;
  if (t === '~' || t === '$HOME' || t === '${HOME}' || t === '%USERPROFILE%') return { path: home };
  if (t.startsWith('~/') || t.startsWith('~\\')) return { path: stripTrailingSep(path.normalize(path.resolve(home, t.slice(2)))) };
  if (/\$\(|`|\$\{|\$[A-Za-z_]|%[A-Za-z_]+%/.test(t)) return { dynamic: true, raw: t };
  if (t === '-' || t === '--') return { dynamic: true, raw: t };
  t = msysToWin(t);
  const absolute = isAbsoluteAny(t) ? t : path.resolve(cwd, t);
  return { path: stripTrailingSep(path.normalize(absolute)) };
}

export function isDriveRoot(p) {
  const s = stripTrailingSep(p).toLowerCase();
  return s === '/' || s === '' || /^[a-z]:$/.test(s) || /^[a-z]:\/$/.test(s);
}

export function isHomeRoot(p, home = HOME) {
  return stripTrailingSep(p).toLowerCase() === stripTrailingSep(home).toLowerCase();
}

export function isUncRoot(p) {
  const raw = String(p);
  if (!raw.startsWith('//') && !raw.startsWith('\\')) return false;
  // //server/share is a share root; anything deeper is a normal directory.
  const parts = toPosix(raw).replace(/^\/+/, '').split('/').filter(Boolean);
  return parts.length <= 2;
}

const SYSTEM_DIRS = /^[a-z]:\/(windows|program files|program files \(x86\)|programdata|\$recycle\.bin|system volume information)(\/|$)/;

/** Windows/Unix system locations, matched on any drive rather than one root. */
export function isSystemPath(p) {
  const s = toPosix(p).toLowerCase();
  if (SYSTEM_DIRS.test(s)) return true;
  return /^\/(bin|boot|dev|etc|lib|lib64|proc|sbin|sys|usr|var)(\/|$)/.test(s);
}

export function isUnder(child, parent) {
  const c = stripTrailingSep(child).toLowerCase();
  const p = stripTrailingSep(parent).toLowerCase();
  if (!p) return false;
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

export function hasGlob(token) {
  return /[*?[]/.test(String(token));
}

/** Directories that must never be deleted, even when a target resolves inside them. */
export function defaultProtectedPaths(home = HOME) {
  const win = process.platform === 'win32';
  const list = [
    path.join(home, '.ssh'),
    path.join(home, '.gnupg'),
    path.join(home, '.pi'),
    path.join(home, '.config'),
  ];
  if (win) {
    for (const drive of ['C:/', 'D:/', 'E:/']) {
      list.push(
        path.join(drive, 'Windows'),
        path.join(drive, 'Program Files'),
        path.join(drive, 'Program Files (x86)'),
        path.join(drive, 'ProgramData'),
      );
    }
  } else {
    list.push('/bin', '/boot', '/dev', '/etc', '/lib', '/proc', '/sbin', '/sys', '/usr', '/var');
  }
  return list.map((p) => stripTrailingSep(p));
}

export function describe(p) {
  return toPosix(p);
}
