/**
 * dsh-infinite-retry
 * 
 * DeepSeek Harness (dsh) 仿 PI-Desktop 无限重试插件（带 UI 开关）
 */

export const name = 'dsh-infinite-retry';
export const inject = ['webServer', 'settings'];

// 致命不可重试错误码集合
const TERMINAL_ERROR_CODES = new Set([
  'AUTH',
  'INVALID_CREDENTIAL',
  'INVALID_API_KEY',
  'UNAUTHORIZED',
  'PERMISSION_DENIED',
  'INVALID_REQUEST',
  'MALFORMED_REQUEST',
  'INVALID_PARAMS',
  'CONTEXT_WINDOW_EXCEEDED',
  'CONTEXT_LENGTH_EXCEEDED',
  'QUOTA_EXCEEDED',
  'INSUFFICIENT_QUOTA',
  'ACCOUNT_OVERDUE',
  'ABORTED',
  'CANCELED',
]);

const TERMINAL_HTTP_STATUSES = new Set([400, 401, 403, 404, 422]);

const RETRYABLE_ERROR_CODES = new Set([
  'RATE_LIMIT',
  'PROVIDER_RATE_LIMITED',
  'TRANSPORT',
  'NETWORK_ERROR',
  'TIMEOUT',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'SERVER',
  'INTERNAL_SERVER_ERROR',
  'GATEWAY_TIMEOUT',
  'BAD_GATEWAY',
  'SERVICE_UNAVAILABLE',
  'EMPTY_RESPONSE',
  'STREAM_CLOSED',
  'STREAM_FAILED',
]);

const TRANSIENT_MESSAGE_PATTERNS = [
  /network_error/i,
  /network-error/i,
  /network error/i,
  /unexpected EOF/i,
  /stream_read_error/i,
  /stream ended before/i,
  /stream ended without/i,
  /bad record MAC/i,
  /fetch failed/i,
  /socket hang up/i,
  /connection reset/i,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /rate limit/i,
  /too many requests/i,
  /overloaded/i,
  /502 Bad Gateway/i,
  /503 Service/i,
  /504 Gateway/i,
];

function isTerminalFailure(failure, signal) {
  if (signal?.aborted) return true;
  if (!failure) return false;

  const code = String(failure.code || '').toUpperCase();
  if (TERMINAL_ERROR_CODES.has(code)) return true;

  const status = Number(failure.status);
  if (TERMINAL_HTTP_STATUSES.has(status)) return true;

  return false;
}

function isAdmittedRetryable(failure) {
  if (!failure) return true;

  const code = String(failure.code || '').toUpperCase();
  if (RETRYABLE_ERROR_CODES.has(code)) return true;

  const status = Number(failure.status);
  if (status === 429 || (status >= 500 && status <= 599)) return true;

  const message = String(failure.message || '');
  for (const pattern of TRANSIENT_MESSAGE_PATTERNS) {
    if (pattern.test(message)) return true;
  }

  return true;
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function isTrustedApiRequest(request) {
  const host = request.headers['host'];
  if (!host || typeof host !== 'string') return false;
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  if (!isLoopbackHostname(hostname)) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers['origin'];
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function writeJson(res, status, body) {
  if (typeof res.statusCode === 'number') res.statusCode = status;
  if (typeof res.setHeader === 'function') res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) body += String(chunk);
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

function safeGetService(ctx, name) {
  try {
    return ctx[name];
  } catch {
    try {
      return ctx.get?.(name, false) ?? ctx.reflect?.get?.(name, false);
    } catch {
      return undefined;
    }
  }
}

export function apply(ctx, config = {}) {
  let enabled = config.enabled ?? true;
  const initialDelayMs = Number.isFinite(config.initialDelayMs) ? Math.max(100, config.initialDelayMs) : 1000;
  const maxDelayMs = Number.isFinite(config.maxDelayMs) ? Math.max(1000, config.maxDelayMs) : 60000;
  const jitterRatio = Number.isFinite(config.jitterRatio) ? Math.max(0, Math.min(1, config.jitterRatio)) : 0.2;

  // 1. 注册 HTTP 接口给前端设置页面调用
  const webServer = safeGetService(ctx, 'webServer');
  const settings = safeGetService(ctx, 'settings');

  const API_PATH = '/infinite-retry/api';
  if (webServer && typeof webServer.register === 'function') {
    const disposeRoute = webServer.register({
      kind: 'prefix',
      path: API_PATH,
      handler: async (req, res) => {
        if (!isTrustedApiRequest(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden' });
          return;
        }

        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
        if (req.method === 'GET') {
          writeJson(res, 200, { ok: true, enabled, maxDelayMs, initialDelayMs });
          return;
        }

        if (req.method === 'POST' && pathname === API_PATH) {
          try {
            const body = await readJsonBody(req);
            if (typeof body.enabled === 'boolean') {
              enabled = body.enabled;
              if (settings && typeof settings.mutate === 'function') {
                try {
                  await settings.mutate('infinite-retry', [{ op: 'set', path: ['enabled'], value: enabled }]);
                } catch {}
              }
            }
            writeJson(res, 200, { ok: true, enabled });
          } catch (err) {
            writeJson(res, 500, { ok: false, error: String(err?.message || err) });
          }
          return;
        }

        writeJson(res, 405, { ok: false, error: 'method not allowed' });
      },
    });

    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => disposeRoute?.(), 'dsh-infinite-retry: api route');
    }
  }

  // 2. 注册错误拦截与改写流水线
  const disposeListener = ctx.on('agent/request-error', (payload, next) => {
    if (!payload || !enabled) return next();

    const { failure, signal } = payload;

    // 致命错误放行报错
    if (isTerminalFailure(failure, signal)) {
      return next();
    }

    // 检查重试准入
    if (!isAdmittedRetryable(failure)) {
      return next();
    }

    // 改写为 mode: "always" 无限重试
    const existingPolicy = payload.retryPolicy;
    payload.retryPolicy = Object.freeze({
      ...(typeof existingPolicy === 'object' && existingPolicy !== null ? existingPolicy : {}),
      mode: 'always',
      initialDelayMs: existingPolicy?.initialDelayMs ?? initialDelayMs,
      maxDelayMs: Math.max(existingPolicy?.maxDelayMs ?? 0, maxDelayMs),
      jitterRatio: existingPolicy?.jitterRatio ?? jitterRatio,
    });

    return next();
  }, true);

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => disposeListener?.(), 'dsh-infinite-retry: request-error listener');
  }

  ctx.logger?.info?.(
    `[dsh-infinite-retry] Loaded successfully. Status: ${enabled ? 'ENABLED' : 'DISABLED'} (mode: always-retry).`
  );
}

// Cordis 对象插件标准导出（必须携带 inject 与 apply）
const plugin = {
  name,
  inject,
  apply,
};

export default plugin;
