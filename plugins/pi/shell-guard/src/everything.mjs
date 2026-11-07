// Everything (voidtools) CLI backend. Pure helpers only: building arguments,
// parsing output and describing the fallback. Process execution lives in index.ts.

const DEFAULT_LIMIT = 50;

export function buildArgs(query, options = {}) {
  const limit = Number(options.limit ?? DEFAULT_LIMIT);
  const args = ['-n', String(Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT), '-json'];
  if (options.path) args.push('-path', String(options.path));
  if (options.matchPath) args.push('-p');
  if (options.regex) args.push('-r');
  if (options.caseSensitive) args.push('-i');
  if (options.foldersOnly) args.push('/ad');
  args.push(String(query ?? ''));
  return args;
}

/** ES -json prints [{ "filename": "..." }, ...]; tolerate plain line output too. */
export function parseOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return [];
  try {
    const data = JSON.parse(text);
    const rows = Array.isArray(data) ? data : [data];
    return rows
      .map((row) => (typeof row === 'string' ? row : row?.filename ?? row?.path ?? null))
      .filter((value) => typeof value === 'string' && value.length > 0);
  } catch {
    return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
}

export function describe(query, options = {}) {
  const es = options.esPath || 'es.exe';
  const limit = options.limit ?? DEFAULT_LIMIT;
  return `${es} -n ${limit} -json "${query}"`;
}

/**
 * search_files is only usable when the CLI exists. When it does not, callers
 * must fall back to a scoped `rg` instead of silently returning "not found".
 */
export function availability(esPath) {
  if (!esPath) return { ok: false, reason: 'es.exe 路径未配置（settings: shellGuard.everything.esPath）' };
  return { ok: true, esPath };
}

export { DEFAULT_LIMIT };
