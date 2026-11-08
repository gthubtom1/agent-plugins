// Lexical paths only. The caller supplies the shell platform; host OS is the default.
import os from 'node:os';

export const HOME = os.homedir();
export const TMP = os.tmpdir();
const win = (platform) => platform === 'win32';
const windowsPath = (value) => /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value);
export const toPosix = (value) => String(value).replace(/\\/g, '/');

export function msysToWin(value) {
  const match = /^\/([a-z])(\/.*)?$/i.exec(value);
  return match ? `${match[1].toUpperCase()}:${match[2] || '/'}` : value;
}

export function isAbsoluteAny(value) {
  return /^[a-z]:[\\/]/i.test(value) || value.startsWith('/') || /^\\\\/.test(value);
}

export function stripTrailingSep(value) {
  const text = String(value);
  if (text === '/' || text === '//' || /^[a-z]:\/$/i.test(text)) return text;
  return text.replace(/\/+$/, '');
}

export function normalisePath(input, platform = process.platform) {
  const raw = String(input ?? '');
  const text = win(platform) || windowsPath(raw) ? toPosix(raw) : raw;
  const drive = /^[a-z]:/i.exec(text);
  const unc = text.startsWith('//');
  const prefix = drive ? drive[0].toUpperCase() + '/' : unc ? '//' : text.startsWith('/') ? '/' : '';
  const parts = [];
  for (let part of text.slice(drive ? 2 : unc ? 2 : prefix.length).split('/')) {
    // Strip Win32 suffixes before resolving dot components, including '.. '.
    if (win(platform)) {
      part = part.replace(/ +$/, '');
      if (part !== '.' && part !== '..') part = part.replace(/[ .]+$/, '');
    }
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > (unc ? 2 : 0) && parts.at(-1) !== '..') parts.pop();
      else if (!prefix) parts.push(part);
      continue;
    }
    // Win32 ignores trailing dots/spaces in ordinary path components.
    if (win(platform)) part = part.replace(/[ .]+$/, '');
    if (part) parts.push(part);
  }
  return prefix + parts.join('/') || '.';
}

export function resolveTarget(token, cwd = process.cwd(), home = HOME, platform = process.platform) {
  let text = String(token ?? '');
  if (!text) return null;
  if (['~', '$HOME', '${HOME}', '%USERPROFILE%'].includes(text)) text = home;
  else if (text.startsWith('~/') || (win(platform) && text.startsWith('~\\'))) text = `${home}/${text.slice(2)}`;
  else if (/^(?:\$HOME|\$\{HOME\}|%USERPROFILE%)[/\\]/.test(text)) text = home + '/' + text.replace(/^(?:\$HOME|\$\{HOME\}|%USERPROFILE%)[/\\]/, '');
  else if (/[$`]|%[^%]+%|^~|[{}\n\r\0]/.test(text)) return { dynamic: true, raw: text };
  if (/^[a-z]:(?![\\/])/i.test(text) || /^[/\\]{2}[?.]/.test(text) || text === '-') return { dynamic: true, raw: text };
  if (win(platform) && /:/.test(text.replace(/^[a-z]:/i, ''))) return { dynamic: true, raw: text };
  if (win(platform) && /^\\(?!\\)/.test(text)) {
    const drive = /^[a-z]:/i.exec(cwd);
    if (!drive) return { dynamic: true, raw: text };
    text = drive[0] + text;
  }
  text = win(platform) ? msysToWin(text) : text;
  return { path: stripTrailingSep(normalisePath(isAbsoluteAny(text) ? text : `${/[\\/]$/.test(cwd) ? cwd : cwd + '/'}${text}`, platform)) };
}

export function isDriveRoot(value) {
  return /^(?:\/|[a-z]:\/?)$/i.test(toPosix(value));
}

export function isUncRoot(value) {
  const text = toPosix(value);
  return text.startsWith('//') && text.slice(2).split('/').filter(Boolean).length <= 2;
}

export function isUnder(child, parent, platform = process.platform) {
  let c = stripTrailingSep(normalisePath(child, platform));
  let p = stripTrailingSep(normalisePath(parent, platform));
  if (win(platform)) { c = c.toLowerCase(); p = p.toLowerCase(); }
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

export function isHomeRoot(value, home = HOME, platform = process.platform) {
  return isUnder(value, home, platform) && isUnder(home, value, platform);
}

export function isSystemPath(value, platform = process.platform) {
  const text = toPosix(value).toLowerCase();
  if (/^[a-z]:\/(windows|program files|program files \(x86\)|programdata|\$recycle\.bin|system volume information)(\/|$)/.test(text)) return true;
  return /^\/(bin|boot|dev|etc|lib|lib64|proc|sbin|sys|usr|var)(\/|$)/.test(text);
}

export const hasGlob = (value) => /[*?[]/.test(String(value));
export function defaultProtectedPaths(home = HOME, platform = process.platform) {
  const list = ['.ssh', '.gnupg', '.pi', '.config'].map((name) => `${home}/${name}`);
  if (!win(platform)) list.push('/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/sbin', '/sys', '/usr', '/var');
  return list.map((value) => normalisePath(value, platform));
}
export const describe = toPosix;
