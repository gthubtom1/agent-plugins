// Pure Everything CLI helpers. Invalid input/output throws for runtime to report
// as an error, never as an empty search result or a fabricated filename.
import path from 'node:path';
import { isAbsoluteAny, resolveTarget } from './paths.mjs';
const DEFAULT_LIMIT = 50;
const MAX_RESULTS = 200;
const CONTROL = /[\x00-\x1f\x7f]/;

export function validateAbsoluteExecutable(value, label = 'Everything executable path') {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value) || CONTROL.test(value)) {
    throw new TypeError(`${label} must be an absolute executable path`);
  }
  return value;
}

export function validateEverythingConfig(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('Invalid Everything configuration');
  const esPath = config.esPath ?? '';
  if (esPath !== '') validateAbsoluteExecutable(esPath, 'Everything esPath');
  const guiPath = config.guiPath ?? '';
  if (guiPath !== '') validateAbsoluteExecutable(guiPath, 'Everything guiPath');
  const autostart = config.autostart ?? false;
  if (typeof autostart !== 'boolean') throw new TypeError('Everything autostart must be boolean');
  if (autostart && !guiPath) throw new TypeError('Everything autostart requires an absolute guiPath');
  return { esPath, guiPath, autostart };
}

export function isIpcUnavailable(error) {
  const code = String(error?.code ?? '').toLowerCase().replace(/[-\s]+/g, '_');
  if (['ipc_unavailable', 'everything_ipc_unavailable', 'everything_service_unavailable'].includes(code)) return true;
  const text = [error?.message, error?.stderr, error?.stdout]
    .filter((value) => typeof value === 'string').join('\n').toLowerCase();
  if (!text.includes('everything') && !text.includes('ipc')) return false;
  return /everything\s+(?:ipc(?:\s+(?:window|service))?|service)\s+(?:is\s+)?(?:not\s+available|unavailable|not\s+found|not\s+running|failed|cannot\s+connect|connection\s+refused)/.test(text)
    || /(?:ipc|service)\s+(?:is\s+)?(?:not\s+available|unavailable|not\s+found|not\s+running|failed|cannot\s+connect|connection\s+refused)/.test(text)
    || /(?:not\s+available|unavailable|not\s+found|not\s+running|failed\s+to\s+connect|connection\s+refused)[\s\S]{0,80}(?:everything|ipc|service)/.test(text);
}

export function isBoundedTimeout(error) {
  const code = String(error?.code ?? '').toUpperCase();
  return code === 'ETIMEDOUT' || code === 'ETIME' || (error?.killed === true && ['SIGTERM', 'SIGKILL'].includes(error?.signal));
}

export function buildArgs(query, options = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 512 || /[\x00-\x1f\x7f]/.test(query) || /^[-/]/.test(query.trimStart())) throw new TypeError('Everything query must be nonblank, at most 512 characters, and must not start with a switch');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Invalid Everything options');
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) throw new RangeError('Everything limit must be an integer between 1 and 200');
  const args = ['-n', String(limit), '-json'];
  if (options.path !== undefined) {
    if (typeof options.path !== 'string' || !options.path.trim() || options.path.length > 512 || /[\x00-\x1f\x7f]/.test(options.path) || !isAbsoluteAny(options.path) || !resolveTarget(options.path)?.path) throw new TypeError('Everything path must be a literal absolute directory');
    args.push('-path', options.path);
  }
  for (const [name, flag] of [['matchPath', '-p'], ['regex', '-r'], ['caseSensitive', '-i'], ['foldersOnly', '/ad']]) {
    if (options[name] !== undefined && typeof options[name] !== 'boolean') throw new TypeError(`Everything ${name} must be boolean`);
    if (options[name]) args.push(flag);
  }
  args.push(query);
  return args;
}

export function parseOutput(stdout) {
  if (typeof stdout !== 'string') throw new TypeError('Everything output must be JSON text');
  if (!stdout.trim()) throw new SyntaxError('Everything returned no JSON');
  const data = JSON.parse(stdout);
  if (!Array.isArray(data) || data.length > MAX_RESULTS) throw new TypeError('Everything JSON must be an array of at most 200 results');
  return data.map((row) => {
    const value = typeof row === 'string' ? row : row && typeof row === 'object' && !Array.isArray(row) ? row.filename ?? row.path : undefined;
    if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new TypeError('Invalid Everything result filename');
    return value;
  });
}

export function describe(query, options = {}) {
  const es = options.esPath || 'es.exe';
  const args = buildArgs(query, options);
  return `${es} ${args.map((arg, index) => index === args.length - 1 || /\s/.test(arg) ? JSON.stringify(arg) : arg).join(' ')}`;
}

export function availability(esPath) {
  if (typeof esPath !== 'string' || !esPath.trim()) return { ok: false, reason: 'es.exe 路径未配置（settings: shellGuard.everything.esPath）' };
  return { ok: true, esPath };
}

export { DEFAULT_LIMIT, MAX_RESULTS };
