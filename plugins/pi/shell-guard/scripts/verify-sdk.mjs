#!/usr/bin/env node
// Real SDK lifecycle verification, with an inert bash implementation.
// Required: PI_SDK_DIR (pi-coding-agent 1.5.0).
// Optional: PI_AI_DIR, PI_SHELL_GUARD_EXTENSION_DIR, PI_SHELL_GUARD_REPORT.
// PI_SHELL_GUARD_ES explicitly opts into ONE read-only Everything query.
// No candidate command is ever passed to a shell or a child-process API.
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSdkFixture } from './fixtures/sdk-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(process.env.PI_SHELL_GUARD_EXTENSION_DIR || path.join(HERE, '..'));
const EXT_ENTRY = path.join(EXT, 'index.ts');
const SDK_DIR = process.env.PI_SDK_DIR || process.env.PI_WEB_RUNTIME;
const WORKSPACE = path.resolve(HERE, '..', '..', '..', '..', '..', '..');
const REPORT = path.resolve(process.env.PI_SHELL_GUARD_REPORT || path.join(WORKSPACE,
  'verification/shell-guard-review-2026-11-08/sdk-verification.json'));
const checks = [];
const cases = [];
const sessions = new Set();
const extensionErrors = [];
const startedAt = new Date().toISOString();
const sdkDeadline = Date.now() + 50000;
let scratch;
let sourceBefore;
let sdkVersion;
let fatal;
let networkAttempts = 0;
const nativeFetch = globalThis.fetch;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const textOf = (message) => typeof message?.content === 'string' ? message.content :
  (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
const inside = (parent, target) => {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
function check(name, passed, detail) {
  checks.push({ name, status: passed ? 'passed' : 'failed', ...(detail === undefined ? {} : { detail }) });
}
function requireCheck(name, passed, detail) {
  check(name, passed, detail);
  if (!passed) throw new Error(name);
}
function incomplete(name, status, detail) { checks.push({ name, status, detail }); }
async function bounded(operation, label, milliseconds = 5000) {
  const remaining = Math.min(milliseconds, sdkDeadline - Date.now());
  if (remaining <= 0) throw new Error(`Harness budget exhausted: ${label}`);
  let timer;
  try {
    const promise = typeof operation === 'function' ? operation() : operation;
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Harness deadline: ${label}`)), remaining);
    })]);
  } finally { clearTimeout(timer); }
}
// Follow only local static imports of the extension entry. No directory scan,
// source rewriting, staged copy, or changing the caller's deployed package.
async function sourceManifest() {
  const pending = [EXT_ENTRY];
  const seen = new Set();
  const files = [];
  while (pending.length) {
    const filename = pending.pop();
    if (seen.has(filename)) continue;
    if (!inside(EXT, filename) || seen.size >= 40) throw new Error('Extension import graph exceeds source audit scope');
    seen.add(filename);
    const bytes = await readFile(filename);
    if (bytes.length > 1024 * 1024) throw new Error('Extension source exceeds audit size budget');
    files.push({ path: path.relative(EXT, filename).replace(/\\/g, '/'), sha256: hash(bytes), bytes: bytes.length });
    for (const match of bytes.toString('utf8').matchAll(/\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"](\.[^'"]+)['"]/g)) {
      const dependency = path.resolve(path.dirname(filename), match[1]);
      if (/\.(?:mjs|js|ts)$/.test(dependency)) pending.push(dependency);
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function main() {
  if (!SDK_DIR) throw new Error('PI_SDK_DIR is required');
  if (inside(EXT, REPORT)) throw new Error('Report must be outside the extension source directory');
  sdkVersion = JSON.parse(await readFile(path.join(SDK_DIR, 'package.json'), 'utf8')).version;
  requireCheck('installed SDK version', sdkVersion === '1.5.0', { expected: '1.5.0', actual: sdkVersion });
  sourceBefore = await sourceManifest();
  globalThis.fetch = async () => { networkAttempts++; throw new Error('Harness forbids network requests'); };
  const aiPath = path.join(path.resolve(process.env.PI_AI_DIR || path.join(SDK_DIR, '..', 'pi-ai')), 'dist/index.js');
  const [ai, pi] = await bounded(() => Promise.all([
    import(pathToFileURL(aiPath).href), import(pathToFileURL(path.join(path.resolve(SDK_DIR), 'dist/index.js')).href),
  ]), 'SDK imports', 10000);

  // Fixtures live outside source/deployed packages. The reviewed policy does
  // not automatically grant arbitrary temp-directory deletion.
  scratch = await mkdtemp(path.join(os.tmpdir(), 'shell-guard-sdk-'));
  const project = path.join(scratch, 'project');
  const agentDir = path.join(scratch, 'agent');
  const target = path.join(scratch, 'outside-target');
  const other = path.join(scratch, 'outside-other');
  for (const directory of [project, agentDir, target, other]) await mkdir(directory);
  requireCheck('authorization fixture is outside project', !inside(project, target));
  const sentinel = path.join(target, 'sentinel.txt');
  await writeFile(sentinel, 'SDK inert fixture sentinel\n');
  const posix = target.replace(/\\/g, '/');
  const otherPosix = other.replace(/\\/g, '/');
  const deletion = `rm -rf "${posix}"`;

  // Exact installed ModelRuntime CredentialStore shape; entirely in memory.
  const credentials = new Map();
  const credentialStore = {
    async read(providerId) { return credentials.get(providerId); },
    async list() { return []; },
    async modify(providerId, mutate) {
      const next = await mutate(credentials.get(providerId));
      if (next) credentials.set(providerId, next); else credentials.delete(providerId);
      return next;
    },
    async delete(providerId) { credentials.delete(providerId); },
  };
  const modelRuntime = await bounded(() => pi.ModelRuntime.create({ credentials: credentialStore, modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false }), 'ModelRuntime initialization');

  async function createSession(label, shellGuard = {}, uiChoice) {
    const fixture = createSdkFixture(ai);
    const providerId = `sdk-inert-fixture-${sessions.size + 1}`;
    modelRuntime.registerProvider(providerId, fixture.provider);
    const model = modelRuntime.getModel(providerId, 'fixture-model');
    if (!model) throw new Error('Deterministic model registration failed');
    const settingsManager = pi.SettingsManager.inMemory({
      packages: [], compaction: { enabled: false }, retry: { enabled: false },
      shellGuard: { ...shellGuard, everything: { enabled: false, ...shellGuard.everything } },
    }, { projectTrusted: true });
    const loader = new pi.DefaultResourceLoader({
      cwd: project, agentDir, settingsManager, additionalExtensionPaths: [EXT_ENTRY],
      extensionFactories: [fixture.extension], noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
      disabledBuiltinExtensions: ['mcp', 'codemode', 'tool_search'],
      systemPrompt: 'INERT-SDK-VERIFICATION', appendSystemPrompt: [],
      promptsOverride: () => ({ prompts: [{ name: 'fixture-delete', description: 'Synthetic authorization template',
        content: `删除 ${posix}`, filePath: fileURLToPath(import.meta.url), sourceInfo: { source: 'fixture' } }], diagnostics: [] }),
    });
    await bounded(() => loader.reload(), `${label}: extension load`);
    const loaded = loader.getExtensions();
    requireCheck(`${label}: no extension loader errors`, loaded.errors.length === 0,
      loaded.errors.map(({ path: filename, error }) => ({ path: filename, error: String(error).slice(0, 400) })));
    requireCheck(`${label}: requested extension loaded`, loaded.extensions.some((extension) =>
      path.resolve(extension.path) === EXT_ENTRY));
    const { session, extensionsResult } = await bounded(() => pi.createAgentSession({
      cwd: project, agentDir, model, modelRuntime, thinkingLevel: 'off', settingsManager, resourceLoader: loader,
      sessionManager: pi.SessionManager.inMemory(project), noTools: 'builtin',
      tools: ['bash', 'search_files', 'fixture_nested', 'fixture_nested_twice', 'fixture_errors', 'fixture_throw'],
    }), `${label}: session creation`);
    sessions.add(session);
    requireCheck(`${label}: session extension loader errors`, extensionsResult.errors.length === 0);
    const uiRequests = [];
    await bounded(() => session.bindExtensions({
      mode: uiChoice === undefined ? 'json' : 'rpc',
      ...(uiChoice === undefined ? {} : { uiContext: {
        async select(title, choices) {
          uiRequests.push({ title, choices });
          if (uiChoice === 'throw') throw new Error('FIXTURE_UI_UNAVAILABLE');
          return uiChoice === 'dismiss' ? undefined : '取消';
        },
        notify() {}, setStatus() {}, setWidget() {},
      } }),
      onError(error) { extensionErrors.push({ label, event: error.event, error: String(error.error).slice(0, 400) }); },
    }), `${label}: extension bind`);
    requireCheck(`${label}: inert bash override installed`,
      session.extensionRunner.getToolDefinition('bash')?.execute === fixture.inertBash);
    requireCheck(`${label}: search_files registered`, Boolean(session.extensionRunner.getToolDefinition('search_files')));
    const executionEvents = [];
    session.subscribe((event) => {
      if (event.type.startsWith('tool_execution_')) executionEvents.push({
        type: event.type, toolCallId: event.toolCallId, parentToolCallId: event.parentToolCallId,
        toolName: event.toolName, isError: event.isError,
      });
    });
    return { label, session, fixture, executionEvents, uiRequests };
  }

  async function dispatch(harness, label, name, args, prompt = '检查合成测试 fixture', options = {}) {
    const { session, fixture, executionEvents } = harness;
    const start = { executed: fixture.executed.length, events: fixture.events.length,
      execution: executionEvents.length, calls: fixture.modelCalls.length };
    const id = fixture.queue(name, args);
    let unsubscribe = () => {};
    try {
      let run;
      if (options.inject) {
        run = new Promise((resolve) => {
          unsubscribe = session.subscribe((event) => { if (event.type === 'agent_settled') resolve(); });
        });
        if (options.inject === 'custom') fixture.injectCustom(prompt);
        else fixture.injectUser(prompt, options.expand === true);
      } else {
        run = session.prompt(prompt, { source: options.source ?? 'interactive' });
      }
      await bounded(run, label, options.deadline ?? 5000);
      await bounded(session.waitForIdle(), `${label}: settle`);
    } finally { unsubscribe(); fixture.clearQueue(); }
    const result = session.messages.findLast((message) => message.role === 'toolResult' && message.toolCallId === id);
    if (!result) throw new Error(`${label}: SDK produced no tool result`);
    const events = fixture.events.slice(start.events);
    const execution = executionEvents.slice(start.execution);
    const captures = fixture.executed.slice(start.executed);
    requireCheck(`${label}: model-issued call completed through lifecycle`,
      fixture.modelCalls.length === start.calls + 1 && events.some((event) => event.type === 'before_agent_start') &&
      events.some((event) => event.type === 'agent_start') && events.some((event) => event.type === 'agent_settled') &&
      execution.some((event) => event.type === 'tool_execution_end' && event.toolCallId === id));
    const record = { label, modelCallId: id, tool: name, isError: result.isError,
      text: textOf(result).slice(0, 600), captures, events, execution };
    cases.push(record);
    return { result, captures, events, execution, record };
  }
  function denied(label, run) {
    check(`${label}: explicit error result`, run.result.isError === true, run.record.text);
    check(`${label}: bash never entered`, run.captures.length === 0, { executions: run.captures.length });
  }
  function allowed(label, run, timeout) {
    check(`${label}: successful inert result`, run.result.isError === false, run.record.text);
    check(`${label}: exact one post-preflight capture`, run.captures.length === 1 &&
      run.captures[0].timeout === timeout, { expectedTimeout: timeout, captures: run.captures });
  }

  const normal = await createSession('default settings');
  for (const [label, command] of [
    ['whole-disk search', 'find / -maxdepth 2 -name "fixture-marker" -type f'],
    ['wrapped whole-disk search', 'timeout 5 find / -maxdepth 2 -name "fixture-marker" -type f'],
    ['root deletion', 'rm -rf /'], ['drive deletion', 'rm -rf D:/'], ['bare REPL', 'python'],
  ]) {
    const run = await dispatch(normal, label, 'bash', { command });
    denied(label, run);
    if (label.includes('search')) check(`${label}: guard alternative supplied`, /search_files|rg -n/.test(run.record.text));
  }
  for (const [label, command, timeout, explicit] of [
    ['fast timeout', 'ls', 60], ['default timeout', 'fixture_unknown --version', 120],
    ['heavy timeout', 'jadx -d out fixture.apk', 900], ['explicit timeout', 'ls', 31, 31],
    ['ceiling clamp', 'ls', 1800, 999999],
  ]) {
    const run = await dispatch(normal, label, 'bash', { command, ...(explicit === undefined ? {} : { timeout: explicit }) });
    allowed(label, run, timeout);
    check(`${label}: command preserved`, run.captures[0]?.argv.command === command);
  }

  for (const name of ['fixture_nested', 'fixture_nested_twice']) {
    const label = `${name} blocked`;
    const blocked = await dispatch(normal, label, name, { command: 'rm -rf /' });
    denied(label, blocked);
    let inner = blocked.result;
    for (let depth = 0; depth < (name === 'fixture_nested' ? 1 : 2); depth++) {
      inner = (depth === 0 ? inner : inner?.result)?.details?.inner;
    }
    check(`${label}: inner isError asserted`, inner?.isError === true);
    check(`${label}: nested bash lifecycle has parent id`, blocked.execution.some((event) =>
      event.type === 'tool_execution_end' && event.toolName === 'bash' && event.parentToolCallId &&
      event.toolCallId.startsWith(`${blocked.record.modelCallId}/`) && event.isError === true));
    for (const [klass, command, timeout, explicit] of [
      ['fast', 'ls', 60], ['default', 'fixture_unknown --version', 120],
      ['heavy', 'jadx -d out fixture.apk', 900], ['clamp', 'ls', 1800, 999999],
    ]) {
      const timeoutLabel = `${name} ${klass} timeout`;
      const success = await dispatch(normal, timeoutLabel, name,
        { command, ...(explicit === undefined ? {} : { timeout: explicit }) });
      allowed(timeoutLabel, success, timeout);
      check(`${timeoutLabel}: nested argument mutation seen by execute`,
        success.captures[0]?.toolCallId.includes('/') && success.captures[0]?.argv.command === command);
    }
  }
  for (const kind of ['unknown', 'validation', 'throw']) {
    const label = `nested ${kind} error`;
    const run = await dispatch(normal, label, 'fixture_errors', { kind });
    denied(label, run);
    check(`${label}: inner result carries isError`, run.result.details?.inner?.isError === true);
  }
  const throwing = await dispatch(normal, 'direct thrown tool error', 'fixture_throw', {});
  denied('direct thrown tool error', throwing);

  denied('unnamed path', await dispatch(normal, 'unnamed path', 'bash', { command: deletion }));
  for (const source of ['interactive', 'rpc']) {
    const label = `${source} exact user grant`;
    const run = await dispatch(normal, label, 'bash', { command: deletion }, `删除 ${posix}`, { source });
    check(`${label}: permitted only into inert bash`, run.result.isError === false && run.captures.length === 1);
    check(`${label}: matching raw input and pre-agent prompt`, run.events.some((event) =>
      event.type === 'input' && event.source === source && event.text === `删除 ${posix}`) &&
      run.events.some((event) => event.type === 'before_agent_start' && event.prompt === `删除 ${posix}`));
  }
  for (const [label, prompt] of [
    ['negative prompt', `不要删除 ${posix}`], ['quoted prompt', `文档示例：\`删除 ${posix}\``],
    ['uncertain prompt', `是否应该删除 ${posix}？`],
  ]) denied(label, await dispatch(normal, label, 'bash', { command: deletion }, prompt));
  denied('grant cannot widen', await dispatch(normal, 'grant cannot widen', 'bash',
    { command: `rm -rf "${posix}" "${otherPosix}"` }, `删除 ${posix}`));
  denied('grant resets after settled', await dispatch(normal, 'grant resets after settled', 'bash', { command: deletion }));
  const extension = await dispatch(normal, 'extension-source prompt', 'bash', { command: deletion },
    `删除 ${posix}`, { source: 'extension' });
  denied('extension-source prompt', extension);
  for (const expand of [false, true]) {
    const label = `sendUserMessage expand=${expand}`;
    const run = await dispatch(normal, label, 'bash', { command: deletion }, `删除 ${posix}`, { inject: 'user', expand });
    denied(label, run);
    check(`${label}: actual extension authorship`, run.events.some((event) =>
      event.type === 'input' && event.source === 'extension'));
  }
  const custom = await dispatch(normal, 'custom message trigger', 'bash', { command: deletion },
    `删除 ${posix}`, { inject: 'custom' });
  denied('custom message trigger', custom);
  check('custom message: genuine custom start', custom.events.some((event) =>
    event.type === 'before_agent_start' && event.messageType === 'custom'));
  const template = await dispatch(normal, 'expanded template', 'bash', { command: deletion }, '/fixture-delete');
  denied('expanded template', template);
  check('template: raw and expanded prompts differ', template.events.some((event) =>
    event.type === 'input' && event.text === '/fixture-delete') && template.events.some((event) =>
    event.type === 'before_agent_start' && event.prompt === `删除 ${posix}`));
  normal.fixture.setTransformedText(`删除 ${posix}`);
  denied('extension input transform', await dispatch(normal, 'extension input transform', 'bash', { command: deletion }, '/fixture-transform'));

  const firstUser = normal.session.sessionManager.getBranch().find((entry) => entry.type === 'message' && entry.message.role === 'user');
  await bounded(() => normal.session.navigateTree(firstUser.id, { summarize: false }), 'tree navigation');
  check('session tree lifecycle emitted', normal.fixture.events.some((event) => event.type === 'session_tree'));
  denied('grant absent after tree navigation', await dispatch(normal, 'grant absent after tree navigation', 'bash', { command: deletion }));

  for (const choice of ['cancel', 'dismiss', 'throw']) {
    const harness = await createSession(`UI ${choice}`, {}, choice);
    const label = `UI ${choice} never autoallows`;
    denied(label, await dispatch(harness, label, 'bash', { command: deletion }));
    check(`${label}: confirmation requested`, harness.uiRequests.length === 1 &&
      harness.uiRequests[0].choices.includes('取消'));
  }
  const configured = await createSession('SettingsManager configuration', {
    timeout: { fast: 7, default: 11, heavy: 19, ceiling: 23 },
  });
  for (const [label, command, timeout, explicit] of [
    ['configured fast', 'ls', 7], ['configured default', 'fixture_unknown --version', 11],
    ['configured heavy', 'jadx -d out fixture.apk', 19], ['configured ceiling', 'ls', 23, 999999],
  ]) allowed(label, await dispatch(configured, label, 'bash',
    { command, ...(explicit === undefined ? {} : { timeout: explicit }) }), timeout);
  check('normal pi.getSettings exposes merged shellGuard configuration',
    configured.fixture.settingsSeen.every((settings) => settings?.timeout?.ceiling === 23));
  denied('disabled Everything backend', await dispatch(normal, 'disabled Everything backend', 'search_files',
    { query: '^es\\.exe$', regex: true, limit: 200 }));

  const esPath = process.env.PI_SHELL_GUARD_ES;
  if (!esPath) {
    incomplete('live Everything exact executable lookup', 'skipped',
      'PI_SHELL_GUARD_ES not set. No executable was launched; live index remains unverified.');
  } else {
    if (!path.isAbsolute(esPath)) throw new Error('PI_SHELL_GUARD_ES must be an absolute executable path');
    await access(esPath);
    const live = await createSession('opt-in live Everything', { everything: { enabled: true, esPath } });
    const run = await dispatch(live, 'live Everything exact executable lookup', 'search_files',
      { query: '^es\\.exe$', regex: true, limit: 200 }, '检查已配置的 Everything 可执行文件', { deadline: 20000 });
    check('live Everything returns explicit success', run.result.isError === false, run.record.text);
    const data = run.result.details;
    if (run.result.isError === false && Array.isArray(data?.paths)) {
      if (data.paths.length === 0) incomplete('live Everything configured executable is indexed', 'unverified',
        'Index returned zero rows; this does not establish absence or a passing live verification.');
      else {
        const canonical = (filename) => path.resolve(filename).replace(/\\/g, '/').toLowerCase();
        const configuredPath = canonical(esPath);
        const present = data.paths.some((row) => typeof row === 'string' && canonical(row) === configuredPath);
        if (present) check('live Everything configured executable is indexed', true, { count: data.paths.length });
        else if (data.limited || data.truncated) incomplete('live Everything configured executable is indexed', 'unverified',
          'Bounded index rows omit configured executable; result is limited/truncated.');
        else check('live Everything configured executable is indexed', false, { count: data.paths.length });
      }
    } else if (run.result.isError === false) check('live Everything structured paths', false);
  }
  check('all candidate deletions left disposable fixture bytes intact',
    await readFile(sentinel, 'utf8') === 'SDK inert fixture sentinel\n');
  check('no extension runtime errors', extensionErrors.length === 0, extensionErrors);
  check('no network attempts', networkAttempts === 0, { attempts: networkAttempts });
}

// Bound individual SDK operations within a shared budget. Do not race main()
// against cleanup: main must unwind before its owned fixture is removed.
try { await main(); }
catch (error) { fatal = String(error?.message ?? error).slice(0, 1500); }
finally {
  for (const session of sessions) {
    try { session.dispose(); } catch (error) { check('session dispose', false, String(error.message)); }
  }
  if (sourceBefore) {
    try { check('extension source bytes preserved', JSON.stringify(sourceBefore) === JSON.stringify(await sourceManifest())); }
    catch (error) { check('extension source bytes preserved', false, String(error.message)); }
  }
  if (scratch) {
    try {
      // The sole filesystem deletion: this exact mkdtemp return value, never
      // user input, a parent directory, the project, or a command candidate.
      await rm(scratch, { recursive: true, force: true });
      check('owned mkdtemp fixture cleaned in finally', true);
    } catch (error) { check('owned mkdtemp fixture cleaned in finally', false, String(error.message)); }
  }
  globalThis.fetch = nativeFetch;
}
const counts = { passed: 0, failed: 0, skipped: 0, unverified: 0 };
for (const entry of checks) counts[entry.status]++;
const report = {
  ok: !fatal && counts.failed === 0, fullyVerified: !fatal && counts.failed === 0 && counts.skipped === 0 && counts.unverified === 0,
  startedAt, finishedAt: new Date().toISOString(), sdk: SDK_DIR ? path.resolve(SDK_DIR) : null, sdkVersion,
  extension: EXT_ENTRY, counts, fatal: fatal ?? null,
  limits: { perDispatchMilliseconds: 5000, liveDispatchMilliseconds: 20000, sdkOperationBudgetMilliseconds: 50000, liveEverythingProcessMilliseconds: 15000 },
  boundary: 'Real SDK event interception; bash execute is an inert argument recorder. No shell candidate was spawned. Optional live Everything is read-only and opt-in.',
  sourceBefore, networkAttempts, checks, cases,
};
try {
  if (inside(EXT, REPORT)) throw new Error('Report destination is inside extension source; no report was written');
  await mkdir(path.dirname(REPORT), { recursive: true });
  await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  console.error(JSON.stringify({ ok: false, reportWriteError: String(error.message) }));
  process.exitCode = 2;
}
console.log(JSON.stringify({ ok: report.ok, fullyVerified: report.fullyVerified, counts, fatal: report.fatal,
  failedChecks: checks.filter((entry) => entry.status === 'failed'),
  incomplete: checks.filter((entry) => ['skipped', 'unverified'].includes(entry.status)), report: REPORT }, null, 2));
process.exitCode = process.exitCode ?? (report.ok ? 0 : fatal ? 2 : 1);
