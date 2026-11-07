// Path normalisation shared by every rule. Pure functions, no I/O.
//
// Resolution is lexical rather than host-dependent: the same Windows-style input
// must classify identically on Linux CI, where `node:path` would treat `D:/x` as
// a relative name.
import os from 'node:os';
import path from 'node:path';

const WINDOWS_ABS = /^[a-zA-Z]:[\\/]/;
const UNC = /^\\\\/;
const BACKSLASH = String.fromCharCode(92);

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

/** Collapse `.` and `..` lexically, keeping drive letters and leading slashes. */
export function normalisePath(input) {
  const s = toPosix(String(input ?? ''));
  const drive = /^[a-zA-Z]:/.exec(s);
  const prefix = drive ? drive[0].toUpperCase() : s.startsWith('/') ? '/' : '';
  const rest = drive ? s.slice(2) : s.startsWith('/') ? s.slice(1) : s;
  const parts = [];
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
      else if (!prefix) parts.push('..');
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join('/');
  if (drive) return joined ? `${prefix}/${joined}` : `${prefix}/`;
  if (prefix === '/') return `/${joined}`;
  return joined || '.';
}

/**
 * Resolve one target token (as typed) into a normalised absolute path.
 * Returns { path } or { dynamic: true, raw } when the token cannot be resolved
 * statically (variables, command substitution, unknown globs at root).
 */
export function resolveTarget(token, cwd = process.cwd(), home = HOME) {
  let t = String(token ?? '').trim().replace(/^['"]|['"]$/g, '');
  if (!t) return null;
  if (t === '~' || t === '$HOME' || t === '${HOME}' || t === '%USERPROFILE%') return { path: normalisePath(home) };
  if (t.startsWith('~/') || t.startsWith(`~${BACKSLASH}`)) return { path: normalisePath(`${home}/${t.slice(2)}`) };
  if (/\$\(|`|\$\{|\$[A-Za-z_]|%[A-Za-z_]+%/.test(t)) return { dynamic: true, raw: t };
  if (t === '-' || t === '--') return { dynamic: true, raw: t };
  t = msysToWin(t);
  const absolute = isAbsoluteAny(t) ? t : `${cwd}/${t}`;
  return { path: stripTrailingSep(normalisePath(absolute)) };
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
  const s = toPosix(raw);
  const isUnc = s.startsWith('//') || raw.startsWith('\\\\');
  if (!isUnc) return false;
  // //server/share is a share root; anything deeper is a normal directory.
  return s.replace(/^\/+/, '').split('/').filter(Boolean).length <= 2;
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
