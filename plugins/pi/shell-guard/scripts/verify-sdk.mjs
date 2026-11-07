#!/usr/bin/env node
// Real-SDK verification for pi-shell-guard.
//
// Loads a caller-supplied Pi SDK, a deterministic in-process provider (no
// network), and the extension from this package. It then drives genuine tool
// calls through the agent loop and asserts what the guard did:
//   - a whole-disk search is blocked and never executes
//   - deleting a drive root is blocked
//   - a bare REPL is blocked
//   - an ordinary command runs and receives an injected timeout
//   - a delete the user named in their own message goes through
//   - search_files is registered and can query Everything
//
// Required: PI_SDK_DIR=<.../@earendil-works/pi-coding-agent>
// Optional: PI_AI_DIR, PI_SHELL_GUARD_ES, PI_SHELL_GUARD_REPORT

import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '..');
const EXT_ENTRY = path.join(EXT, 'index.ts');
const SDK_DIR = process.env.PI_SDK_DIR || process.env.PI_WEB_RUNTIME;
if (!SDK_DIR) {
  console.error('PI_SDK_DIR is required (path to @earendil-works/pi-coding-agent).');
  process.exit(1);
}
const PI_ENTRY = path.join(path.resolve(SDK_DIR), 'dist/index.js');
const AI_ENTRY = path.join(path.resolve(process.env.PI_AI_DIR || path.join(SDK_DIR, '..', 'pi-ai')), 'dist/index.js');

const checks = [];
const observed = [];
const failures = [];
let queued;
let seq = 0;

function check(name, passed, detail) {
  checks.push({ name, passed: Boolean(passed), ...(detail === undefined ? {} : { detail }) });
  if (!passed) failures.push(name);
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n');
}

async function main() {
  const ai = await import(pathToFileURL(AI_ENTRY).href);
  const pi = await import(pathToFileURL(PI_ENTRY).href);

  // Deliberately outside os.tmpdir(): the guard allows deletes inside the temp
  // directory, so a temp sandbox could not test the outside-project tiers.
  const scratch = path.join(os.homedir(), `.shell-guard-sdk-${Date.now()}`);
  await mkdir(scratch, { recursive: true });
  const project = path.join(scratch, 'project');
  const agentDir = path.join(scratch, 'agent');
  const sessionDir = path.join(scratch, 'sessions');
  await mkdir(project, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(project, 'notes.txt'), 'fixture\n');

  const credentials = new Map();
  // ModelRuntime expects read/list/modify/delete.
  const credentialStore = {
    async read(providerId) { return credentials.get(providerId); },
    async list() { return []; },
    async modify(providerId, mutate) {
      const next = await mutate(credentials.get(providerId));
      if (next) credentials.set(providerId, next);
      else credentials.delete(providerId);
      return next;
    },
    async delete(providerId) { credentials.delete(providerId); },
  };

  const { ModelRuntime } = await import(pathToFileURL(PI_ENTRY).href);
  const modelRuntime = await ModelRuntime.create({
    credentials: credentialStore,
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });

  const provider = {
    name: 'Fixture Provider',
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: 'fixture-key',
    api: 'openai-completions',
    models: [{
      id: 'fixture-model', name: 'Fixture Model', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 8192,
    }],
    streamSimple(model) {
      const stream = ai.createAssistantMessageEventStream();
      const message = {
        role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'pending', timestamp: Date.now(),
      };
      const call = queued;
      queued = undefined;
      stream.push({ type: 'start', partial: message });
      if (call) {
        message.content.push(call);
        stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
        stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: message });
        message.stopReason = 'toolUse';
        stream.push({ type: 'done', reason: 'toolUse', message });
      } else {
        message.content.push({ type: 'text', text: 'FIXTURE_DONE' });
        stream.push({ type: 'text_start', contentIndex: 0, partial: message });
        stream.push({ type: 'text_end', contentIndex: 0, content: 'FIXTURE_DONE', partial: message });
        message.stopReason = 'stop';
        stream.push({ type: 'done', reason: 'stop', message });
      }
      return stream;
    },
  };
  modelRuntime.registerProvider('fixture', provider);
  const model = modelRuntime.getModel('fixture', 'fixture-model');
  if (!model) throw new Error('fixture model registration failed');

  // Observer loaded after the guard: later tool_call handlers see its mutations.
  const observer = (extensionApi) => {
    extensionApi.on('tool_call', (event) => {
      if (event.toolName === 'bash') {
        observed.push({ command: event.input?.command, timeout: event.input?.timeout });
      }
    });
  };

  const settingsManager = pi.SettingsManager.inMemory({
    packages: [],
    compaction: { enabled: false, keepRecentTokens: 10, reserveTokens: 10 },
    retry: { enabled: false },
  }, { projectTrusted: true });

  const loader = new pi.DefaultResourceLoader({
    cwd: project,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [EXT_ENTRY],
    extensionFactories: [observer],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    disabledBuiltinExtensions: ['mcp', 'codemode', 'tool_search'],
    systemPrompt: 'HARNESS-BASE-PROMPT',
    appendSystemPrompt: [],
  });
  await loader.reload();

  const { session } = await pi.createAgentSession({
    cwd: project,
    agentDir,
    model,
    thinkingLevel: 'off',
    modelRuntime,
    resourceLoader: loader,
    sessionManager: pi.SessionManager.create(project, sessionDir),
    settingsManager,
    tools: ['bash', 'search_files'],
  });

  async function dispatch(name, args, userText) {
    if (queued) throw new Error('dispatch already pending');
    const call = { type: 'toolCall', id: `guard-${++seq}`, name, arguments: args };
    queued = call;
    try {
      // The prompt is what the guard reads as the user's own message.
      await session.prompt(userText ?? 'fixture dispatch');
    } finally {
      queued = undefined;
    }
    const result = session.messages.findLast((m) => m.role === 'toolResult' && m.toolCallId === call.id);
    if (!result) {
      const tail = session.messages.slice(-6).map((m) => ({
        role: m.role,
        id: m.toolCallId,
        stop: m.stopReason,
        parts: Array.isArray(m.content) ? m.content.map((c) => c?.type) : typeof m.content,
        text: messageText(m).slice(0, 160),
      }));
      throw new Error(`no tool result for ${name}: ${JSON.stringify(tail)}`);
    }
    return result;
  }

  const toolError = (result) => result.isError === true || /error|blocked|拒绝/i.test(messageText(result));

  // 1. whole-disk search is blocked and does not execute
  const findResult = await dispatch('bash', { command: 'find / -maxdepth 2 -name "*marker*" -type f' });
  check('whole-disk-search blocked', toolError(findResult), messageText(findResult).slice(0, 200));
  check('whole-disk-search reason mentions alternative', /search_files|rg -n/.test(messageText(findResult)));

  // 2. drive-root deletion is blocked
  const rmResult = await dispatch('bash', { command: 'rm -rf /' });
  check('drive-root delete blocked', toolError(rmResult), messageText(rmResult).slice(0, 200));

  // 3. bare REPL would hang: blocked
  const replResult = await dispatch('bash', { command: 'python' });
  check('bare REPL blocked', toolError(replResult), messageText(replResult).slice(0, 160));

  // 4. ordinary command runs and gets a timeout
  observed.length = 0;
  const lsResult = await dispatch('bash', { command: 'ls' });
  check('ordinary command allowed', !toolError(lsResult), messageText(lsResult).slice(0, 160));
  const lsObserved = observed.find((entry) => entry.command === 'ls');
  check('timeout injected for ordinary command', lsObserved?.timeout === 60, lsObserved);

  // 5. outside-project delete: blocked unless the user names that path
  const outsideDir = path.join(scratch, 'outside-target');
  const outsidePosix = outsideDir.replace(/\\/g, '/');
  await mkdir(outsideDir, { recursive: true });
  await writeFile(path.join(outsideDir, 'x.txt'), 'x');

  // Unquoted Windows path: Git Bash eats the backslashes, so the guard asks first.
  const backslash = await dispatch('bash', { command: `rm -rf ${outsideDir}` }, `删除 ${outsidePosix}`);
  check('unquoted backslash path is refused with a hint',
    toolError(backslash) && /反斜杠|正斜杠/.test(messageText(backslash)), messageText(backslash).slice(0, 200));

  const ungranted = await dispatch('bash', { command: `rm -rf ${outsidePosix}` }, '看看这个目录');
  check('unnamed delete is not allowed silently', toolError(ungranted), messageText(ungranted).slice(0, 160));
  let outsideStillThere = true;
  try { await access(outsideDir); } catch { outsideStillThere = false; }
  check('unnamed delete did not run', outsideStillThere === true);

  // The very same command is allowed once the user names that exact path.
  const grantedResult = await dispatch('bash', { command: `rm -rf ${outsidePosix}` }, `删除 ${outsidePosix}`);
  check('user-named delete allowed', !toolError(grantedResult), messageText(grantedResult).slice(0, 160));
  let remained = true;
  try { await access(outsideDir); } catch { remained = false; }
  check('user-named delete actually removed the directory', remained === false,
    { existed: remained, tool: messageText(grantedResult).slice(0, 300), dir: outsideDir });

  // A grant for one path must not authorise a second one.
  const a = path.join(scratch, 'grant-a');
  const b = path.join(scratch, 'grant-b');
  await mkdir(a, { recursive: true });
  await mkdir(b, { recursive: true });
  const widened = await dispatch('bash', { command: `rm -rf ${a} ${b}` }, `删除 ${a}`);
  check('grant does not widen to a second path', toolError(widened), messageText(widened).slice(0, 160));
  let bStillThere = true;
  try { await access(b); } catch { bStillThere = false; }
  check('second path untouched', bStillThere === true);

  // 6. search_files is registered and works when Everything is configured
  const esPath = process.env.PI_SHELL_GUARD_ES;
  const definition = session.extensionRunner?.getToolDefinition?.('search_files');
  check('search_files registered', Boolean(definition));
  if (esPath) {
    const search = await dispatch('search_files', { query: 'es.exe', limit: 5 });
    const text = messageText(search);
    check('search_files returns paths', /es\.exe/i.test(text), text.slice(0, 200));
  } else {
    check('search_files returns paths', true, 'skipped: PI_SHELL_GUARD_ES not set');
  }

  session.dispose?.();
  await rm(scratch, { recursive: true, force: true });

  const report = {
    ok: failures.length === 0,
    sdk: path.resolve(SDK_DIR),
    extension: EXT_ENTRY,
    checks,
    failures,
  };
  const out = process.env.PI_SHELL_GUARD_REPORT;
  if (out) {
    const { writeFile: write } = await import('node:fs/promises');
    await write(path.resolve(out), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.stack || String(error) }, null, 2));
  process.exit(2);
});
