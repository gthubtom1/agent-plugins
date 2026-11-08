// Pure Everything CLI helpers. Invalid input/output throws for runtime to report
// as an error, never as an empty search result or a fabricated filename.
import { isAbsoluteAny, resolveTarget } from './paths.mjs';
const DEFAULT_LIMIT = 50;
const MAX_RESULTS = 200;

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
