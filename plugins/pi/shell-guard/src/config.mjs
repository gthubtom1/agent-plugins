import { HOME, defaultProtectedPaths, resolveTarget } from './paths.mjs';

export const DEFAULTS = {
  enabled: true, blockWholeDisk: true, interactive: true, requireBackgroundRedirect: true,
  timeout: { fast: 60, default: 120, heavy: 900, ceiling: 1800 },
  rm: { policy: 'tiered', grantFromUserText: true },
  everything: { enabled: true, esPath: '', maxResults: 50 }, allow: [],
};
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const seconds = (value, fallback) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, 1800) : fallback;

export function normalizeOptions(input = {}) {
  const settings = object(input.settings);
  const platform = input.platform ?? process.platform;
  const home = input.home || HOME;
  const cwd = input.cwd || process.cwd();
  const merged = { ...DEFAULTS, ...settings };
  const timeout = { ...DEFAULTS.timeout, ...object(settings.timeout) };
  for (const key of Object.keys(DEFAULTS.timeout)) timeout[key] = seconds(timeout[key], DEFAULTS.timeout[key]);
  const protectedPaths = [...defaultProtectedPaths(home, platform), ...(Array.isArray(settings.protectedPaths) ? settings.protectedPaths : [])];
  return {
    ...merged, platform, cwd, home, projectRoot: input.projectRoot || cwd,
    timeout, rm: { ...DEFAULTS.rm, ...object(settings.rm) },
    everything: { ...DEFAULTS.everything, ...object(settings.everything) },
    explicitTimeout: input.explicitTimeout,
    realpath: typeof input.realpath === 'function' ? input.realpath : undefined,
    protectedPaths: protectedPaths.map((value) => {
      if (typeof value !== 'string') throw new TypeError('Invalid protected path');
      const result = resolveTarget(value, cwd, home, platform);
      if (!result?.path) throw new TypeError('Protected path must be literal');
      return result.path;
    }),
    allow: Array.isArray(merged.allow) ? merged.allow : [],
  };
}
