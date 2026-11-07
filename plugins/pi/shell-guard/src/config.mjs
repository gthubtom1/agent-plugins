// Configuration defaults and normalisation. Kept separate from the rules so the
// rules stay pure and testable.

import { HOME, defaultProtectedPaths, stripTrailingSep } from './paths.mjs';

export const DEFAULTS = {
  enabled: true,
  blockWholeDisk: true,
  interactive: true,
  requireBackgroundRedirect: true,
  timeout: { fast: 60, default: 120, heavy: 900, ceiling: 1800 },
  rm: { policy: 'tiered', grantFromUserText: true },
  everything: { enabled: true, esPath: '', maxResults: 50 },
  allow: [],
};

function merge(base, patch) {
  if (!patch || typeof patch !== 'object') return { ...base };
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      out[key] = { ...base[key], ...value };
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * @param {object} input
 * @param {object} [input.settings]  shellGuard settings block from settings.json
 * @param {string} [input.cwd]       shell working directory
 * @param {string} [input.projectRoot]
 * @param {string} [input.home]
 * @param {number} [input.explicitTimeout] timeout the model already passed
 */
export function normalizeOptions(input = {}) {
  const merged = merge(DEFAULTS, input.settings || {});
  const home = input.home || HOME;
  const configured = Array.isArray(input.settings?.protectedPaths) ? input.settings.protectedPaths : null;
  return {
    ...merged,
    cwd: input.cwd || process.cwd(),
    projectRoot: input.projectRoot || input.cwd || process.cwd(),
    home,
    explicitTimeout: input.explicitTimeout,
    // Optional injected resolver (tests) or fs.realpath (runtime).
    realpath: typeof input.realpath === 'function' ? input.realpath : undefined,
    protectedPaths: (configured || defaultProtectedPaths(home)).map((p) => stripTrailingSep(p)),
    allow: Array.isArray(merged.allow) ? merged.allow : [],
  };
}
