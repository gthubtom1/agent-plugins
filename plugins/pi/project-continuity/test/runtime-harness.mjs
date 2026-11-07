import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerContinuity } from '../runtime.mjs';

export async function harness(t, { trusted = true } = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-runtime-'));
  // Keep fixtures independent even when the caller places TMP inside a package.
  await fs.mkdir(path.join(cwd, '.git'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const tools = new Map(), hooks = new Map(), commands = new Map(), messages = [];
  const entries = [{ type: 'message', id: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: '角色审核员负责核对日志。' }] } }];
  const ctx = { cwd, hasUI: false, isProjectTrusted: () => trusted,
    sessionManager: { getSessionId: () => 'session-one', getBranch: () => entries }, ui: {} };
  const pi = { appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data, id: `option-${entries.length}` }), registerTool: v => tools.set(v.name, v), registerCommand: (n,v) => commands.set(n,v), on: (n,h) => hooks.set(n,h), sendMessage: m => messages.push(m) };
  registerContinuity(pi);
  return { cwd, ctx, tools, hooks, commands, entries, messages,
    call: (name, params) => tools.get(name).execute('call-1', params, undefined, undefined, ctx),
    event: (name, data = {}) => hooks.get(name)?.(data, ctx) };
}
export const text = r => r.content.filter(x => x.type === 'text').map(x => x.text).join('\n');
