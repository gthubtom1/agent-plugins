#!/usr/bin/env node
// verify-sdk.mjs
//
// Portable deterministic SDK lifecycle validation for the project-continuity plugin.
// It loads a caller-supplied Pi coding-agent SDK, an isolated resource loader, a deterministic
// in-process fake provider, and real AgentSession methods: prompt(), compact(), navigateTree(),
// reload(), SessionManager.open() resume, and the extension command /continuity.
//
// It then starts the same SDK CLI in real RPC mode with the plugin and the same fake provider and
// proves that /continuity content reaches RPC clients as custom message events and get_messages,
// not only as a notification.
//
// No external model, network, installs, deployment, global settings/credentials, or writes outside
// the scratch directory and the explicitly selected report path.
// Temporary fixture repositories do not create commits.
//
// Required:
//   PI_SDK_DIR=<.../@earendil-works/pi-coding-agent>   (or PI_WEB_RUNTIME)
// Optional:
//   PI_AI_DIR=<.../@earendil-works/pi-ai>              (default: sibling of PI_SDK_DIR)
//   PI_CONTINUITY_REPORT=<external report path>
//   PI_CONTINUITY_KEEP_SCRATCH=1
//
// Example:
//   PI_SDK_DIR=/path/to/@earendil-works/pi-coding-agent node scripts/verify-sdk.mjs

import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, access, cp } from 'node:fs/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SDK_DIR = process.env.PI_SDK_DIR || process.env.PI_WEB_RUNTIME;
if (!SDK_DIR) {
  console.error('PI_SDK_DIR or PI_WEB_RUNTIME is required (path to @earendil-works/pi-coding-agent).');
  process.exit(1);
}
const PI_PKG = path.resolve(SDK_DIR);
const PI_AI_PKG = path.resolve(process.env.PI_AI_DIR || process.env.PI_WEB_PI_AI || path.resolve(PI_PKG, '..', 'pi-ai'));
const PI_ENTRY = path.join(PI_PKG, 'dist/index.js');
const AI_ENTRY = path.join(PI_AI_PKG, 'dist/index.js');
const CLI_ENTRY = path.join(PI_PKG, 'dist/cli.js');
const EXT_DIR = path.resolve(HERE, '..');
const EXT_ENTRY = path.join(EXT_DIR, 'index.ts');
const FIXTURE_ENTRY = path.join(HERE, 'fixtures', 'fixture-provider.mjs');
const REPORT_PATH = process.env.PI_CONTINUITY_REPORT
  ? path.resolve(process.env.PI_CONTINUITY_REPORT)
  : path.join(os.tmpdir(), `project-continuity-sdk-report-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.json`);
const EXPECTED_TOOLS = ['continuity_status', 'continuity_search', 'continuity_save'];

const CONTINUITY_PREFIX = '当前项目续接数据';
const OLD_TEXT = 'OLD ACTIVE: fixture route A is approved.';
const CANCELLED_TEXT = 'CANCELLED: fixture route A must not be used.';
const CANCELLED_REASON = 'fixture cancellation';

const assertions = [];
const failures = [];
const timeline = [];
const requests = [];
let currentPhase = 'setup';
let requestSeq = 0;
let providerSeq = 0;
let queuedToolCall;
let scratch;
let projectDir;
let agentDir;
let modelRuntime;
let model;
const openSessions = [];

async function disposeSession(session) {
  try { session.dispose(); } catch {}
  const index = openSessions.indexOf(session);
  if (index >= 0) openSessions.splice(index, 1);
}

async function disposeOpenSessions() {
  for (const session of [...openSessions]) await disposeSession(session);
}

function git(args, cwd = projectDir) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initializeGitFixture() {
  git(['init']);
  git(['symbolic-ref', 'HEAD', 'refs/heads/fixture-main']);
  return git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
}

function nowIso() { return new Date().toISOString(); }

function describeError(error) {
  if (!error) return String(error);
  if (typeof error === 'string') return error;
  return error.stack || error.message || String(error);
}

function record(source, event, detail) {
  timeline.push({ phase: currentPhase, source, event, detail, at: nowIso() });
}

function markPhase(name) {
  currentPhase = name;
  timeline.push({ phase: name, source: 'marker', event: 'phase_start', at: nowIso() });
}

function phaseEvents(name, source) {
  return timeline.filter((entry) => entry.phase === name && entry.source !== 'marker' && (!source || entry.source === source));
}

function phaseEventNames(name) {
  return phaseEvents(name).map((entry) => entry.event);
}

function fail(message, detail) {
  const error = new Error(detail ? `${message} (${detail})` : message);
  error.isAssertion = true;
  throw error;
}

function expect(condition, label, detail) {
  if (!condition) fail(label, detail);
  assertions.push(label);
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) fail(label, `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  assertions.push(label);
}

function expectIncludes(text, needle, label) {
  if (!String(text ?? '').includes(needle)) fail(label, `missing=${JSON.stringify(needle)} text=${JSON.stringify(String(text ?? '').slice(0, 800))}`);
  assertions.push(label);
}

function expectNotIncludes(text, needle, label) {
  if (String(text ?? '').includes(needle)) fail(label, `unexpected=${JSON.stringify(needle)} text=${JSON.stringify(String(text ?? '').slice(0, 800))}`);
  assertions.push(label);
}

function messageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n');
}

function continuityBlocks(messages) {
  return (messages ?? []).filter((message) => {
    if (message.role !== 'user' && message.role !== 'custom') return false;
    return messageText(message).includes(CONTINUITY_PREFIX);
  });
}

function continuityText(messages) {
  return continuityBlocks(messages).map(messageText).join('\n---\n');
}

function replayTools(messages) {
  const tools = new Map();
  for (const message of messages ?? []) {
    if (message.role !== 'system') continue;
    for (const removed of message.toolsRemoved ?? []) tools.delete(removed.name);
    for (const added of message.toolsAdded ?? []) tools.set(added.name, added);
  }
  return [...tools.values()];
}

function toolSignature(messages) {
  return JSON.stringify(replayTools(messages).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })));
}

function describeSessionEvent(event) {
  switch (event.type) {
    case 'message_start':
    case 'message_end': {
      const message = event.message;
      return `${event.type}:${message?.role ?? 'unknown'}${message?.customType ? `:${message.customType}` : ''}`;
    }
    case 'compaction_start':
      return `compaction_start:${event.reason}`;
    case 'compaction_end':
      return `compaction_end:${event.reason}${event.result ? ':ok' : event.aborted ? ':aborted' : ':failed'}`;
    case 'agent_settled':
      return `agent_settled:aborted=${event.aborted}`;
    case 'agent_end':
      return `agent_end:willRetry=${event.willRetry}`;
    case 'turn_end':
      return 'turn_end';
    case 'entry_appended':
      return `entry_appended:${event.entry?.type}${event.entry?.customType ? `:${event.entry.customType}` : ''}`;
    default:
      return event.type;
  }
}

function observerFactory() {
  return (pi) => {
    const events = [
      'session_start', 'resources_discover', 'before_agent_start', 'context',
      'session_before_compact', 'session_compact', 'session_compact_failed',
      'session_tree', 'session_shutdown', 'agent_settled',
    ];
    for (const eventName of events) {
      pi.on(eventName, (event) => {
        const reason = event && typeof event.reason === 'string' ? `:${event.reason}` : '';
        record('extension', `${eventName}${reason}`);
      });
    }
  };
}

function createCredentialStore() {
  const credentials = new Map();
  return {
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
}

async function createModelRuntime(ai, credentialStore, onRequest) {
  const { ModelRuntime } = await import(pathToFileURL(PI_ENTRY).href);
  const modelRuntime = await ModelRuntime.create({
    credentials: credentialStore,
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const { makeProvider } = await import(pathToFileURL(FIXTURE_ENTRY).href);
  const provider = makeProvider(ai.createAssistantMessageEventStream, { onRequest });
  const textResponse = provider.streamSimple;
  provider.streamSimple = (model, context) => {
    if (!queuedToolCall) return textResponse(model, context);
    const call = queuedToolCall;
    queuedToolCall = undefined;
    onRequest({ isSummary: false, model: { provider: model.provider, id: model.id },
      messages: JSON.parse(JSON.stringify(context.messages)), responseText: `fixture tool call: ${call.name}` });
    const stream = ai.createAssistantMessageEventStream();
    const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'pending', timestamp: Date.now() };
    stream.push({ type: 'start', partial: message });
    message.content.push(call);
    stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
    stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: message });
    message.stopReason = 'toolUse';
    stream.push({ type: 'done', reason: 'toolUse', message });
    return stream;
  };
  modelRuntime.registerProvider('fixture', provider);
  const model = modelRuntime.getModel('fixture', 'fixture-model');
  if (!model) throw new Error('fixture model was not registered');
  return { modelRuntime, model };
}

async function createTestSession({ sessionStartEvent, sessionManager, label, cwd = projectDir }) {
  const pi = await import(pathToFileURL(PI_ENTRY).href);
  const settingsManager = pi.SettingsManager.inMemory({
    packages: [],
    compaction: { enabled: false, keepRecentTokens: 10, reserveTokens: 10 },
    retry: { enabled: false },
  }, { projectTrusted: true });
  const loader = new pi.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [EXT_ENTRY],
    extensionFactories: [observerFactory()],
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
  const loaded = loader.getExtensions();
  const { session, extensionsResult } = await pi.createAgentSession({
    cwd,
    agentDir,
    model,
    thinkingLevel: 'off',
    modelRuntime,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
    tools: EXPECTED_TOOLS,
    sessionStartEvent,
  });
  openSessions.push(session);
  const extensionErrors = [];
  session.subscribe((event) => record('session', describeSessionEvent(event)));
  await session.bindExtensions({ onError: (error) => extensionErrors.push(describeError(error)) });
  const info = {
    label,
    session,
    settingsManager,
    loaderErrors: loaded.errors ?? extensionsResult?.errors ?? [],
    extensionErrors,
  };
  return info;
}

function activeTools(session) {
  return [...session.getActiveToolNames()].sort();
}

function expectActiveTools(session, label) {
  const actual = activeTools(session);
  expectEqual(JSON.stringify(actual), JSON.stringify([...EXPECTED_TOOLS].sort()), `${label}: active tools unchanged`);
}

function toolContext(session) {
  return session.extensionRunner.createToolContext(`verify-${++requestSeq}`, undefined);
}

async function executeTool(session, name, params) {
  const definition = session.extensionRunner.getToolDefinition(name);
  if (!definition?.execute) throw new Error(`tool definition missing: ${name}`);
  return definition.execute(`verify-${++requestSeq}`, params, undefined, undefined, toolContext(session));
}

async function executeValidatedTool(session, name, params) {
  // The SDK requires an actual assistant-issued call, not a synthetic parent id.
  // Queue exactly one deterministic provider tool call; native follow-up settles
  // normally and the tool result retains Pi's schema/execution error marker.
  if (queuedToolCall) throw new Error('fixture dispatch already pending');
  const call = { type: 'toolCall', id: `fixture-call-${++requestSeq}`, name, arguments: params };
  queuedToolCall = call;
  try { await session.prompt(`fixture validation dispatch ${call.id}`); }
  finally { queuedToolCall = undefined; }
  const result = session.messages.findLast(m => m.role === 'toolResult' && m.toolCallId === call.id);
  if (!result) throw new Error('SDK did not persist the fixture tool result');
  return result;
}

function parseToolJson(result) {
  return JSON.parse(messageText(result));
}

async function getStatus(session) {
  return parseToolJson(await executeTool(session, 'continuity_status', {}));
}

async function saveRecord(session, record, expectedRevision) {
  const result = await executeTool(session, 'continuity_save', { expectedRevision, record });
  return parseToolJson(result);
}

function requestSummary(request) {
  const blocks = continuityBlocks(request.messages);
  return {
    index: request.index,
    phase: request.phase,
    isSummary: request.isSummary,
    roles: request.messages.map((message) => message.role),
    totalChars: JSON.stringify(request.messages).length,
    continuityBlocks: blocks.length,
    continuityChars: blocks.reduce((sum, block) => sum + messageText(block).length, 0),
    tools: replayTools(request.messages).map((tool) => tool.name),
    system: request.messages.filter((message) => message.role === 'system').map((message) => ({
      contentChars: messageText(message).length,
      sections: Object.keys(message.sections ?? {}),
      guidance: typeof message.sections?.project_continuity === 'string',
      toolsAdded: (message.toolsAdded ?? []).length,
      toolsRemoved: (message.toolsRemoved ?? []).length,
    })),
  };
}

async function promptPhase(session, phase, text) {
  markPhase(phase);
  const before = requests.length;
  await session.prompt(text);
  const calls = requests.slice(before);
  expectEqual(calls.length, 1, `${phase}: exactly one provider request (no forced continuation)`);
  const starts = phaseEventNames(phase).filter((name) => name === 'agent_start').length;
  const settled = phaseEventNames(phase).filter((name) => name.startsWith('agent_settled:')).length;
  expectEqual(starts, 1, `${phase}: exactly one agent_start`);
  expectEqual(settled, 1, `${phase}: exactly one agent_settled`);
  expectActiveTools(session, phase);
  expectEqual(continuityBlocks(calls[0].messages).length, 1, `${phase}: exactly one continuity context block`);
  expectStructuredGuidance(calls[0], phase);
  expectNoStaleStatus(calls[0], phase);
  return calls[0];
}

function expectCancellationContext(request, label) {
  const blocks = continuityBlocks(request.messages);
  expectEqual(blocks.length, 1, `${label}: one continuity context block`);
  const text = continuityText(request.messages);
  expectIncludes(text, '[cancelled] (route-choice)', `${label}: cancelled tombstone present`);
  expectIncludes(text, CANCELLED_TEXT, `${label}: replacement text present`);
  expectIncludes(text, CANCELLED_REASON, `${label}: replacement reason present`);
  expectNotIncludes(text, OLD_TEXT, `${label}: old active text absent`);
  expectNotIncludes(text, '[accepted] (route-choice)', `${label}: old accepted status absent`);
  expect(text.length <= 6500, `${label}: continuity block <= 6500 chars`, `actual=${text.length}`);
  const occurrences = request.messages.reduce((count, message) => {
    const value = messageText(message);
    return count + (value.split(CONTINUITY_PREFIX).length - 1);
  }, 0);
  expectEqual(occurrences, 1, `${label}: continuity block is not duplicated`);
  return text;
}

function checkToolSignature(request, baseline, label) {
  if (request.isSummary) return;
  const names = replayTools(request.messages).map((tool) => tool.name).sort();
  expectEqual(JSON.stringify(names), JSON.stringify([...EXPECTED_TOOLS].sort()), `${label}: no unrelated tools declared`);
  expectEqual(toolSignature(request.messages), baseline, `${label}: tool declarations unchanged`);
}

function expectStructuredGuidance(request, label) {
  if (request.isSummary) return;
  const systemMessages = request.messages.filter((message) => message.role === 'system');
  expect(systemMessages.length >= 1, `${label}: system message present`);
  const structured = systemMessages.filter((message) => typeof message.sections?.project_continuity === 'string');
  expectEqual(structured.length, 1, `${label}: exactly one structured project_continuity section`);
  expectIncludes(structured[0].sections.project_continuity, '项目续接', `${label}: guidance section content`);
  const literalPrompt = systemMessages.map(messageText).join('\n');
  expectNotIncludes(literalPrompt, '项目续接：本机有 continuity_status', `${label}: guidance is not a full systemPrompt replacement`);
}

function expectNoStaleStatus(request, label) {
  expectNotIncludes(JSON.stringify(request.messages), 'STALE_STATUS_SHOULD_BE_STRIPPED', `${label}: stale project-continuity-status message stripped`);
}

function expectNoRouteChoice(request, label) {
  const text = continuityText(request.messages);
  expectNotIncludes(text, 'route-choice', `${label}: branch-incompatible record hidden`);
  expectNotIncludes(text, CANCELLED_TEXT, `${label}: branch-incompatible replacement text hidden`);
}

function rpcText(message) {
  return messageText(message);
}

function createRpcClient(child, stderrRef) {
  const records = [];
  const waiters = new Set();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch (error) { record = { parse_error: error.message, line }; }
      records.push(record);
      for (const waiter of [...waiters]) waiter(record);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderrRef.value += chunk; });

  function waitFor(predicate, timeout = 15000, label = 'RPC record') {
    const existing = records.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(listener);
        reject(new Error(`timeout waiting for ${label}; stderr=${stderrRef.value.slice(-1200)}`));
      }, timeout);
      const listener = (record) => {
        if (!predicate(record)) return;
        clearTimeout(timer);
        waiters.delete(listener);
        resolve(record);
      };
      waiters.add(listener);
    });
  }

  function send(command) { child.stdin.write(JSON.stringify(command) + '\n'); }

  async function command(command, timeout = 15000) {
    send(command);
    return waitFor((record) => record.type === 'response' && record.id === command.id, timeout, `response ${command.id}`);
  }

  return { records, waitFor, command };
}

async function rpcValidation() {
  const rpcAgentDir = path.join(scratch, 'agent-rpc');
  const rpcSessionDir = path.join(scratch, 'sessions-rpc');
  await mkdir(rpcAgentDir, { recursive: true });
  await mkdir(rpcSessionDir, { recursive: true });
  const stderrRef = { value: '' };
  const child = spawn(process.execPath, [
    CLI_ENTRY, '--mode', 'rpc',
    '--no-extensions',
    '-e', EXT_ENTRY,
    '-e', FIXTURE_ENTRY,
    '--provider', 'fixture',
    '--model', 'fixture-model',
    '--approve',
    '--offline',
    '--no-session',
    '--no-builtin-tools',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--no-mcp',
  ], {
    cwd: projectDir,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: rpcAgentDir,
      PI_CODING_AGENT_SESSION_DIR: rpcSessionDir,
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
      PI_FIXTURE_PI_AI: AI_ENTRY,
      PI_FIXTURE_CAPTURE: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rpc = createRpcClient(child, stderrRef);
  const rpcReport = { commandListed: false, disposition: null, customEvents: 0, getMessages: false, getEntries: false, content: '', records: [] };

  try {
    const commandsResponse = await rpc.command({ id: 'rpc-commands', type: 'get_commands' });
    expect(commandsResponse.success === true, 'RPC get_commands succeeded', JSON.stringify(commandsResponse));
    const commandNames = (commandsResponse.data?.commands ?? []).map((command) => command.name);
    expect(commandNames.includes('continuity'), 'RPC get_commands lists /continuity', JSON.stringify(commandNames));
    rpcReport.commandListed = true;

    const promptResponse = await rpc.command({ id: 'rpc-prompt', type: 'prompt', message: '/continuity' });
    expect(promptResponse.success === true, 'RPC prompt /continuity succeeded', JSON.stringify(promptResponse));
    expectEqual(promptResponse.data?.disposition, 'handled', 'RPC /continuity was handled without a model run');
    rpcReport.disposition = promptResponse.data?.disposition;

    const customStart = await rpc.waitFor(
      (record) => record.type === 'message_start' && record.message?.role === 'custom' && record.message?.customType === 'project-continuity-status',
      15000,
      'RPC custom message_start',
    );
    const customEnd = await rpc.waitFor(
      (record) => record.type === 'message_end' && record.message?.role === 'custom' && record.message?.customType === 'project-continuity-status',
      15000,
      'RPC custom message_end',
    );
    rpcReport.customEvents = 2;
    const eventText = rpcText(customStart.message);
    expectIncludes(eventText, '[cancelled] (route-choice)', 'RPC message_start carries cancelled content');
    expectIncludes(eventText, CANCELLED_TEXT, 'RPC message_start carries replacement text');
    expectNotIncludes(eventText, OLD_TEXT, 'RPC message_start omits old active text');
    expectEqual(customStart.message.display, true, 'RPC custom message is display=true');
    expectIncludes(rpcText(customEnd.message), CANCELLED_TEXT, 'RPC message_end carries replacement text');
    rpcReport.content = eventText;

    const messagesResponse = await rpc.command({ id: 'rpc-messages', type: 'get_messages' });
    expect(messagesResponse.success === true, 'RPC get_messages succeeded', JSON.stringify(messagesResponse));
    const rpcMessage = (messagesResponse.data?.messages ?? []).find((message) => message.role === 'custom' && message.customType === 'project-continuity-status');
    expect(Boolean(rpcMessage), 'RPC get_messages includes /continuity custom message');
    expectIncludes(rpcText(rpcMessage), '[cancelled] (route-choice)', 'RPC get_messages carries cancelled content');
    expectEqual(rpcMessage.display, true, 'RPC get_messages custom message is display=true');
    rpcReport.getMessages = true;

    const entriesResponse = await rpc.command({ id: 'rpc-entries', type: 'get_entries' });
    expect(entriesResponse.success === true, 'RPC get_entries succeeded', JSON.stringify(entriesResponse));
    const rpcEntry = (entriesResponse.data?.entries ?? []).find((entry) => entry.type === 'custom_message' && entry.customType === 'project-continuity-status');
    expect(Boolean(rpcEntry), 'RPC get_entries includes custom_message entry');
    expectIncludes(messageText(rpcEntry), CANCELLED_TEXT, 'RPC custom_message entry carries replacement text');
    expectNotIncludes(messageText(rpcEntry), OLD_TEXT, 'RPC custom_message entry omits old active text');
    expectEqual(rpcEntry.display, true, 'RPC custom_message entry is display=true');
    rpcReport.getEntries = true;

    const extensionErrors = rpc.records.filter((record) => record.type === 'extension_error');
    expectEqual(extensionErrors.length, 0, 'RPC emitted no extension_error records');
    rpcReport.records = rpc.records.map((record) => record.type + (record.command ? `:${record.command}` : '') + (record.method ? `:${record.method}` : ''));
  } finally {
    try { child.stdin.end(); } catch {}
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    if (!child.killed) child.kill('SIGTERM');
  }
  return rpcReport;
}

async function cleanupScratch() {
  if (process.env.PI_CONTINUITY_KEEP_SCRATCH === '1') return { kept: true, path: scratch, reason: 'PI_CONTINUITY_KEEP_SCRATCH=1' };
  if (process.platform === 'win32') {
    const windowsPath = scratch.replaceAll('/', '\\');
    const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${windowsPath.replaceAll("'", "''")}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
    const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30000 });
    if (result.status === 0) return { kept: false, recycled: true, path: scratch };
    return { kept: true, path: scratch, reason: result.stderr || result.stdout || `powershell exit ${result.status}` };
  }
  const trash = spawnSync('trash', [scratch], { encoding: 'utf8', timeout: 30000 });
  if (!trash.error && trash.status === 0) return { kept: false, recycled: true, path: scratch };
  if (process.platform === 'linux') {
    const gio = spawnSync('gio', ['trash', scratch], { encoding: 'utf8', timeout: 30000 });
    if (!gio.error && gio.status === 0) return { kept: false, recycled: true, path: scratch };
  }
  return { kept: true, path: scratch, reason: 'no portable recycle command available; scratch retained; no rm/unlink performed' };
}

async function main() {
  for (const file of [PI_ENTRY, AI_ENTRY, CLI_ENTRY, EXT_ENTRY, FIXTURE_ENTRY]) {
    await access(file);
  }
  const ai = await import(pathToFileURL(AI_ENTRY).href);
  scratch = await mkdtemp(path.join(os.tmpdir(), 'pi-continuity-lifecycle-'));
  projectDir = path.join(scratch, 'project');
  agentDir = path.join(scratch, 'agent');
  const sessionDir = path.join(scratch, 'sessions');
  await mkdir(projectDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(projectDir, 'probe.txt'), 'fixture lifecycle source\n', 'utf8');

  const capture = (request) => {
    requests.push({ index: providerSeq++, phase: currentPhase, ...request });
  };
  const runtimeInfo = await createModelRuntime(ai, createCredentialStore(), capture);
  modelRuntime = runtimeInfo.modelRuntime;
  model = runtimeInfo.model;

  let coreReport;
  let rpcReport;
  let searchReport;
  let adoptReport;
  let initialBranch;
  try {
    markPhase('setup');
    initialBranch = initializeGitFixture();
    expectEqual(initialBranch, 'fixture-main', 'git fixture branch available');
    const fresh = await createTestSession({
      label: 'fresh',
      sessionManager: (await import(pathToFileURL(PI_ENTRY).href)).SessionManager.create(projectDir, sessionDir),
      sessionStartEvent: { type: 'session_start', reason: 'startup' },
    });
    const session = fresh.session;
    const pi = await import(pathToFileURL(PI_ENTRY).href);

    expectEqual(fresh.loaderErrors.length, 0, 'fresh loader errors empty', JSON.stringify(fresh.loaderErrors));
    expectEqual(fresh.extensionErrors.length, 0, 'fresh extension errors empty', JSON.stringify(fresh.extensionErrors));
    const registered = session.extensionRunner.getAllRegisteredTools().map((tool) => tool.definition.name);
    for (const name of EXPECTED_TOOLS) expect(registered.includes(name), `registered tool ${name}`);
    const commands = session.extensionRunner.getRegisteredCommands().map((command) => command.invocationName);
    expect(commands.includes('continuity'), 'registered command /continuity');
    expectActiveTools(session, 'fresh');
    for (const hook of ['session_before_compact', 'session_compact', 'session_tree', 'session_shutdown', 'context', 'before_agent_start']) {
      expect(session.extensionRunner.hasHandlers(hook) === true, `hook ${hook} subscribed`);
    }
    expect(phaseEventNames('setup').includes('session_start:startup'), 'fresh session_start:startup fired');
    expect(phaseEventNames('setup').includes('resources_discover:startup'), 'fresh resources_discover:startup fired');

    const status0 = await getStatus(session);
    expectEqual(status0.initialized, false, 'fresh project starts uninitialized');
    expectEqual(status0.revision, 0, 'fresh revision is 0');
    expectEqual(status0.automatic_candidates, true, 'new session defaults to automatic candidate capture');

    markPhase('save-accepted');
    await saveRecord(session, {
      id: 'route-choice', kind: 'decision', title: 'Fixture route choice', text: OLD_TEXT,
      status: 'accepted', source: { path: 'probe.txt' },
    }, 0);
    const statusAccepted = await getStatus(session);
    expect(statusAccepted.initialized === true, 'save accepted initialized project');
    expect(statusAccepted.revision >= 1, 'save accepted advanced revision', `actual=${statusAccepted.revision}`);
    const falseCandidate = await executeValidatedTool(session, 'continuity_save', {
      expectedRevision: statusAccepted.revision,
      record: { id: 'false-success', kind: 'claim', title: 'FALSE_SUCCESS_ALL_SEVEN_VERIFIED',
        text: 'FALSE_SUCCESS_AUTHORIZATION_UNLIMITED', source: { path: 'probe.txt' } },
    });
    expect(!falseCandidate.isError, 'real SDK accepts a candidate record through schema validation', JSON.stringify(falseCandidate));

    const initialRequest = await promptPhase(session, 'fresh-accepted', 'fixture phase fresh-accepted');
    const initialText = continuityText(initialRequest.messages);
    expectIncludes(initialText, '[accepted] (route-choice)', 'accepted record visible before cancellation');
    expectIncludes(initialText, OLD_TEXT, 'old active text visible before cancellation');
    expectNotIncludes(initialText, '[cancelled] (route-choice)', 'cancelled record absent before cancellation');
    expectNotIncludes(initialText, 'FALSE_SUCCESS_ALL_SEVEN_VERIFIED', 'automatic context quarantines candidate titles');
    expectNotIncludes(initialText, 'FALSE_SUCCESS_AUTHORIZATION_UNLIMITED', 'automatic context quarantines candidate bodies');
    const candidateSearch = parseToolJson(await executeValidatedTool(session, 'continuity_search', { id: 'false-success' }));
    expectEqual(candidateSearch.current?.status, 'candidate', 'explicit validated search can inspect quarantined claim');
    const baselineToolSignature = toolSignature(initialRequest.messages);
    checkToolSignature(initialRequest, baselineToolSignature, 'fresh-accepted');
    expect(initialText.length <= 6500, 'fresh-accepted: continuity block <= 6500 chars', `actual=${initialText.length}`);

    markPhase('save-cancelled');
    const statusBeforeCancel = await getStatus(session);
    await saveRecord(session, {
      id: 'route-choice', kind: 'decision', title: 'Fixture route choice', text: CANCELLED_TEXT,
      status: 'cancelled', reason: CANCELLED_REASON, source: { path: 'probe.txt' },
    }, statusBeforeCancel.revision);
    const statusAfterCancel = await getStatus(session);
    expect(statusAfterCancel.revision > statusBeforeCancel.revision, 'cancellation advanced revision', `before=${statusBeforeCancel.revision} after=${statusAfterCancel.revision}`);

    const cancelledRequest = await promptPhase(session, 'fresh-cancelled', 'fixture phase fresh-cancelled');
    checkToolSignature(cancelledRequest, baselineToolSignature, 'fresh-cancelled');
    expectCancellationContext(cancelledRequest, 'fresh-cancelled');

    markPhase('compact');
    const beforeCompact = requests.length;
    const compaction = await session.compact('fixture lifecycle compaction');
    const compactionCalls = requests.slice(beforeCompact);
    expect(compactionCalls.length >= 1, 'compact made a real summarization provider request');
    expect(compactionCalls.every((request) => request.isSummary === true), 'compact requests were summarization requests');
    expect(typeof compaction?.summary === 'string' && compaction.summary.length > 0, 'compact returned a summary');
    expectIncludes(compaction.summary, 'Fixture lifecycle summary', 'compact summary came from the fake provider');
    const compactionEntries = session.sessionManager.getEntries().filter((entry) => entry.type === 'compaction');
    expectEqual(compactionEntries.length, 1, 'exactly one compaction entry persisted');
    expect(Boolean(compactionEntries[0].firstKeptEntryId), 'compaction entry has firstKeptEntryId');
    expect(phaseEventNames('compact').some((name) => name === 'compaction_start:manual'), 'compaction_start:manual fired');
    expect(phaseEventNames('compact').some((name) => name === 'compaction_end:manual:ok'), 'compaction_end:manual:ok fired');
    expect(phaseEventNames('compact').includes('session_before_compact:manual'), 'session_before_compact:manual fired');
    expect(phaseEventNames('compact').includes('session_compact:manual'), 'session_compact:manual fired');
    expectActiveTools(session, 'compact');

    const afterCompactRequest = await promptPhase(session, 'after-compact', 'fixture phase after-compact');
    checkToolSignature(afterCompactRequest, baselineToolSignature, 'after-compact');
    expectCancellationContext(afterCompactRequest, 'after-compact');

    markPhase('tree');
    const beforeTree = requests.length;
    const userEntry = session.sessionManager.getBranch().find((entry) => entry.type === 'message' && entry.message?.role === 'user');
    expect(Boolean(userEntry), 'found a user entry for tree navigation');
    const treeResult = await session.navigateTree(userEntry.id, { summarize: false });
    expectEqual(treeResult.cancelled, false, 'navigateTree completed without cancellation');
    expectEqual(requests.length, beforeTree, 'tree navigation made no provider request');
    expect(phaseEventNames('tree').includes('session_tree'), 'session_tree fired');
    expectActiveTools(session, 'tree');

    const afterTreeRequest = await promptPhase(session, 'after-tree', 'fixture phase after-tree');
    checkToolSignature(afterTreeRequest, baselineToolSignature, 'after-tree');
    expectCancellationContext(afterTreeRequest, 'after-tree');

    await session.prompt('/continuity candidates off');
    expectEqual((await getStatus(session)).automatic_candidates, false, 'candidate capture command turns narration off');
    await session.prompt('/continuity candidates on extra');
    expectEqual((await getStatus(session)).automatic_candidates, false, 'invalid candidate command does not change state');
    const usageMessage = session.messages.filter(m => m.role === 'custom' && m.customType === 'project-continuity-status').at(-1);
    expectIncludes(messageText(usageMessage), '用法', 'invalid command reports usage without an extension error');

    markPhase('reload');
    const beforeReload = requests.length;
    await session.reload();
    expectEqual(requests.length, beforeReload, 'reload made no provider request');
    const reloadEvents = phaseEventNames('reload');
    expect(reloadEvents.includes('session_shutdown:reload'), 'session_shutdown:reload fired');
    expect(reloadEvents.includes('session_start:reload'), 'session_start:reload fired');
    expect(reloadEvents.includes('resources_discover:reload'), 'resources_discover:reload fired');
    expectActiveTools(session, 'reload');
    expectEqual((await getStatus(session)).automatic_candidates, false, 'candidate off persists across real SDK reload');
    const failedCall = await executeValidatedTool(session, 'fixture_missing_tool', {});
    expectEqual(failedCall.isError, true, 'real SDK reports an unknown-tool failure through finalized tool events');

    const afterReloadRequest = await promptPhase(session, 'after-reload', 'fixture phase after-reload');
    checkToolSignature(afterReloadRequest, baselineToolSignature, 'after-reload');
    expectCancellationContext(afterReloadRequest, 'after-reload');
    const errorsWhileOff = parseToolJson(await executeValidatedTool(session, 'continuity_search', { query: '工具失败' }));
    expect(errorsWhileOff.records.some(item => item.current?.capture === 'tool-error' && item.current.status === 'failed'), 'candidate off retains conditional tool errors after a real run');
    expect(errorsWhileOff.records.every(item => !item.current.context?.targetSha256), 'tool errors do not fabricate a target');

    markPhase('command');
    const beforeCommand = requests.length;
    await session.prompt('/continuity');
    expectEqual(requests.length, beforeCommand, '/continuity made no provider request');
    const commandMessages = session.messages.filter((message) => message.role === 'custom' && message.customType === 'project-continuity-status');
    expect(commandMessages.length >= 1, 'SDK session contains /continuity custom message');
    const commandMessage = commandMessages.at(-1);
    expectEqual(commandMessage.display, true, '/continuity custom message is display=true');
    const commandText = messageText(commandMessage);
    expectIncludes(commandText, '[cancelled] (route-choice)', 'SDK /continuity output contains cancelled record');
    expectIncludes(commandText, CANCELLED_TEXT, 'SDK /continuity output contains replacement text');
    expectNotIncludes(commandText, OLD_TEXT, 'SDK /continuity output omits old active text');
    const commandEntry = session.sessionManager.getEntries().filter((entry) => entry.type === 'custom_message' && entry.customType === 'project-continuity-status').at(-1);
    expect(Boolean(commandEntry), 'SDK session persisted /continuity custom_message entry');
    expectEqual(commandEntry.display, true, 'SDK custom_message entry is display=true');

    markPhase('inject-stale-status');
    await session.sendCustomMessage({ customType: 'project-continuity-status', content: 'STALE_STATUS_SHOULD_BE_STRIPPED', display: true }, { triggerTurn: false });
    const staleEntry = session.sessionManager.getEntries().filter((entry) => entry.type === 'custom_message' && entry.customType === 'project-continuity-status').at(-1);
    expect(Boolean(staleEntry), 'stale project-continuity-status message persisted in session history');
    expectIncludes(messageText(staleEntry), 'STALE_STATUS_SHOULD_BE_STRIPPED', 'stale status marker stored in session');
    const stripRequest = await promptPhase(session, 'after-status-strip', 'fixture phase after-status-strip');
    checkToolSignature(stripRequest, baselineToolSignature, 'after-status-strip');
    expectCancellationContext(stripRequest, 'after-status-strip');
    expectNoStaleStatus(stripRequest, 'after-status-strip');

    markPhase('resume-open');
    const sessionFile = session.sessionFile;
    expect(Boolean(sessionFile), 'session file exists before resume');
    await disposeSession(session);
    const resumed = await createTestSession({
      label: 'resume',
      sessionManager: pi.SessionManager.open(sessionFile, sessionDir),
      sessionStartEvent: { type: 'session_start', reason: 'resume', previousSessionFile: sessionFile },
    });
    expectEqual(resumed.loaderErrors.length, 0, 'resume loader errors empty', JSON.stringify(resumed.loaderErrors));
    expectEqual(resumed.extensionErrors.length, 0, 'resume extension errors empty', JSON.stringify(resumed.extensionErrors));
    expect(phaseEventNames('resume-open').includes('session_start:resume'), 'session_start:resume fired');
    expectActiveTools(resumed.session, 'resume-open');
    expectEqual((await getStatus(resumed.session)).automatic_candidates, false, 'candidate off survives persisted session resume');
    await resumed.session.prompt('/continuity candidates on');
    expectEqual((await getStatus(resumed.session)).automatic_candidates, true, 'candidate on re-enables capture after resume');

    const resumeRequest = await promptPhase(resumed.session, 'resume-prompt', 'fixture phase resume');
    checkToolSignature(resumeRequest, baselineToolSignature, 'resume-prompt');
    expectCancellationContext(resumeRequest, 'resume-prompt');
    expectNoStaleStatus(resumeRequest, 'resume-prompt');

    markPhase('branch-feature');
    git(['symbolic-ref', 'HEAD', 'refs/heads/fixture-feature']);
    const featureRequest = await promptPhase(resumed.session, 'branch-feature', 'fixture phase branch-feature');
    checkToolSignature(featureRequest, baselineToolSignature, 'branch-feature');
    expectNoRouteChoice(featureRequest, 'branch-feature');

    markPhase('branch-main');
    git(['symbolic-ref', 'HEAD', `refs/heads/${initialBranch}`]);
    const branchBackRequest = await promptPhase(resumed.session, 'branch-main', 'fixture phase branch-main');
    checkToolSignature(branchBackRequest, baselineToolSignature, 'branch-main');
    expectCancellationContext(branchBackRequest, 'branch-main');

    const searchResult = await executeTool(resumed.session, 'continuity_search', { id: 'route-choice', history: true });
    const search = parseToolJson(searchResult);
    const route = (search.records ?? []).find((item) => item.current?.id === 'route-choice' || item.record?.id === 'route-choice');
    expect(Boolean(route), 'continuity_search resolves route-choice');
    expectEqual(route.current?.status, 'cancelled', 'search current status is cancelled');
    expectEqual(route.current?.reason, CANCELLED_REASON, 'search current reason is cancellation');
    expectEqual(route.history?.length, 2, 'route-choice saved exactly twice (accepted then cancelled)');
    expectEqual(route.history.map((item) => item.record.status).join(','), 'accepted,cancelled', 'route-choice history status order');

    const claimSearchResult = await executeTool(resumed.session, 'continuity_search', { query: '最近会话自述', history: true, limit: 12 });
    const claimSearch = parseToolJson(claimSearchResult);
    const claims = (claimSearch.records ?? []).filter((item) => item.current?.kind === 'claim' && String(item.current?.title ?? '').includes('最近会话自述'));
    expect(claims.length >= 1, 'search finds automatic session claims');
    expect(claims.every((item) => item.history?.length === 1), 'automatic session claims saved once, not repeatedly', JSON.stringify(claims.map((item) => ({ id: item.current?.id, history: item.history?.length }))));

    markPhase('guided-sources');
    for (const name of ['a', 'b']) {
      await mkdir(path.join(projectDir, 'work', name), { recursive: true });
      await writeFile(path.join(projectDir, 'work', name, 'scope.md'), `fixture case ${name}: isolated copy only; seven required surfaces`);
    }
    const evidencePath = path.join(projectDir, 'work/a/Evidence.md');
    await writeFile(evidencePath, '1/7 verified; 6 unexamined; aggregate incomplete');
    const identity = { caseRoot: 'work/a', targetSha256: 'a'.repeat(64) };
    const guidedRecord = { id: 'guided-coverage', kind: 'context', status: 'active',
      title: 'Fixture partial coverage', text: '1/7 verified; 6 unexamined; aggregate incomplete',
      source: { path: 'probe.txt' }, context: identity,
      pointers: [{ role: 'goal', path: 'work/a/scope.md' }, { role: 'evidence', path: 'work/a/Evidence.md' }] };
    const guidedRevision = (await getStatus(resumed.session)).revision;
    const savedGuided = await executeValidatedTool(resumed.session, 'continuity_save', { expectedRevision: guidedRevision, record: guidedRecord });
    expect(!savedGuided.isError, 'real SDK accepts bounded guided pointers');
    const badSchema = await executeValidatedTool(resumed.session, 'continuity_save', {
      expectedRevision: (await getStatus(resumed.session)).revision,
      record: { ...guidedRecord, pointers: [{ role: 'scope', path: 'work/a/scope.md', authorization: 'unlimited' }] },
    });
    expectEqual(badSchema.isError, true, 'real SDK rejects extra free-form authority in pointer schema');
    const missingTarget = await executeValidatedTool(resumed.session, 'continuity_save', {
      expectedRevision: (await getStatus(resumed.session)).revision,
      record: { ...guidedRecord, context: { caseRoot: 'work/a' } },
    });
    expectEqual(missingTarget.isError, true, 'real SDK rejects guided context without explicit target');
    const unknownTargetRequest = await promptPhase(resumed.session, 'guided-unknown-target', 'fixture continue with identity not selected');
    const unknownText = continuityText(unknownTargetRequest.messages);
    expectIncludes(unknownText, 'work/a/Evidence.md', 'automatic recovery offers guided source pointers');
    expectNotIncludes(unknownText, '1/7 verified', 'automatic recovery with unknown target withholds coverage facts');
    expectNotIncludes(unknownText, 'Fixture partial coverage', 'automatic recovery withholds guided title with unknown target');
    const exact = parseToolJson(await executeValidatedTool(resumed.session, 'continuity_search', { id: 'guided-coverage', context: identity }));
    expectIncludes(exact.current?.text, '1/7 verified', 'explicit identity restores partial coverage record');
    expectEqual(exact.records[0].needsReview, false, 'all guided source hashes initially unchanged');
    const wrong = parseToolJson(await executeValidatedTool(resumed.session, 'continuity_search', { id: 'guided-coverage', context: { ...identity, targetSha256: 'b'.repeat(64) } }));
    expectEqual(wrong.records.length, 0, 'SDK search excludes mismatched target');
    const wrongCase = parseToolJson(await executeValidatedTool(resumed.session, 'continuity_search', { id: 'guided-coverage', context: { ...identity, caseRoot: 'work/b' } }));
    expectEqual(wrongCase.records.length, 0, 'SDK search excludes mismatched case');
    await writeFile(evidencePath, 'Regression: gate 1 reopened; 0/7 verified; six unexamined');
    const stale = parseToolJson(await executeValidatedTool(resumed.session, 'continuity_search', { id: 'guided-coverage', context: identity }));
    expectEqual(stale.records[0].staleSource, false, 'unrelated record.source remains unchanged');
    expectEqual(stale.records[0].needsReview, true, 'changed Evidence pointer independently invalidates recovery');
    const staleRequest = await promptPhase(resumed.session, 'guided-stale-evidence', 'fixture stale Evidence recovery');
    expectIncludes(continuityText(staleRequest.messages), 'needs-review', 'real provider context shows stale pointer warning');
    expectNotIncludes(continuityText(staleRequest.messages), '1/7 verified', 'real provider context omits stale coverage');
    const updatedGuided = await executeValidatedTool(resumed.session, 'continuity_save', {
      expectedRevision: (await getStatus(resumed.session)).revision,
      record: { ...guidedRecord, title: 'Fixture regression reopened', text: '0/7 verified; gate 1 reopened; six unexamined' },
    });
    expect(!updatedGuided.isError, 'regression can revise the same stable guided id');
    const regression = parseToolJson(await executeValidatedTool(resumed.session, 'continuity_search', { id: 'guided-coverage', context: identity, history: true }));
    expectEqual(regression.records[0].history.length, 2, 'regression preserves the previous partial record as history');
    expectIncludes(regression.current?.text, '0/7 verified', 'current record is the reopened regression');
    expectEqual(regression.records[0].needsReview, false, 'updated Evidence hash is fresh without claiming semantic verification');
    expectEqual(fresh.extensionErrors.length, 0, 'SDK lifecycle produced no extension handler errors');
    expectEqual(resumed.extensionErrors.length, 0, 'resumed guided lifecycle produced no extension handler errors');

    markPhase('adopt-before');
    const movedDir = path.join(scratch, 'project-moved');
    await cp(projectDir, movedDir, { recursive: true, force: true, filter: (src) => !src.split(path.sep).includes('.git') });
    // Give this copied fixture an explicit branch, so a TMP directory nested
    // inside a developer checkout cannot lend it an unrelated parent branch.
    git(['init'], movedDir);
    git(['symbolic-ref', 'HEAD', `refs/heads/${initialBranch}`], movedDir);
    const moved = await createTestSession({
      label: 'adopt',
      cwd: movedDir,
      sessionManager: pi.SessionManager.create(movedDir, path.join(scratch, 'sessions-moved')),
      sessionStartEvent: { type: 'session_start', reason: 'startup' },
    });
    const adoptBeforeRequest = await promptPhase(moved.session, 'adopt-before', 'fixture phase adopt-before');
    const adoptBeforeText = continuityText(adoptBeforeRequest.messages);
    expectIncludes(adoptBeforeText, 'adoptProject before writing', 'adopt-before: isolated moved marker warning visible');
    markPhase('adopt-command');
    const beforeAdoptCommand = requests.length;
    await moved.session.prompt('/continuity adopt');
    expectEqual(requests.length, beforeAdoptCommand, '/continuity adopt made no provider request');
    const adoptMessages = moved.session.messages.filter((message) => message.role === 'custom' && message.customType === 'project-continuity-status');
    const adoptMessage = adoptMessages.at(-1);
    expect(Boolean(adoptMessage), 'SDK session contains /continuity adopt custom message');
    expectEqual(adoptMessage.display, true, '/continuity adopt custom message is display=true');
    const adoptCommandText = messageText(adoptMessage);
    expectNotIncludes(adoptCommandText, '项目续接失败', '/continuity adopt did not report failure');
    expectIncludes(adoptCommandText, 'Project memory', '/continuity adopt returned post-adopt recovery');
    const adoptAfterRequest = await promptPhase(moved.session, 'adopt-after', 'fixture phase adopt-after');
    const adoptAfterText = continuityText(adoptAfterRequest.messages);
    expectNotIncludes(adoptAfterText, 'adoptProject before writing', 'adopt-after: isolated warning cleared');
    expectCancellationContext(adoptAfterRequest, 'adopt-after');
    adoptReport = {
      beforeWarning: true,
      commandOutput: adoptCommandText.slice(0, 240),
      afterWarning: false,
      cancellationAfterAdopt: true,
      movedDir,
    };
    await disposeSession(moved.session);

    searchReport = {
      revision: search.revision,
      currentStatus: route.current?.status,
      currentReason: route.current?.reason,
      history: route.history.map((item) => ({ revision: item.recordRevision, status: item.record.status })),
      claimHistory: claims.map((item) => ({ id: item.current?.id, revisions: item.history?.length })),
    };

    coreReport = {
      loaderErrors: fresh.loaderErrors,
      extensionErrors: fresh.extensionErrors,
      freshToolDeclarations: replayTools(initialRequest.messages).map((tool) => tool.name),
      activeTools: activeTools(resumed.session),
      compaction: {
        summary: compaction.summary.slice(0, 200),
        firstKeptEntryId: compaction.firstKeptEntryId,
        tokensBefore: compaction.tokensBefore,
        entries: compactionEntries.length,
        providerCalls: compactionCalls.length,
      },
      phases: timeline.filter((entry) => entry.source === 'marker').map((entry) => entry.phase),
      requests: requests.map(requestSummary),
      search: searchReport,
      initialBranch,
      branch: { featureHidden: true, mainRestored: true },
      adopt: adoptReport,
      sessionFile,
    };
  } catch (error) {
    failures.push({ scope: 'core', message: error.message, stack: error.stack });
  } finally {
    await disposeOpenSessions();
  }

  try {
    rpcReport = await rpcValidation();
  } catch (error) {
    failures.push({ scope: 'rpc', message: error.message, stack: error.stack });
    rpcReport = { error: error.message };
  } finally {
    await disposeOpenSessions();
  }
  const cleanup = await cleanupScratch();
  const eventSequences = {};
  for (const marker of timeline.filter((entry) => entry.source === 'marker')) {
    eventSequences[marker.phase] = phaseEvents(marker.phase).map((entry) => `${entry.source}:${entry.event}`);
  }
  const report = {
    ok: failures.length === 0,
    startedAt: nowIso(),
    runtime: PI_PKG,
    piAi: PI_AI_PKG,
    extension: EXT_ENTRY,
    scratch,
    cleanup,
    assertions,
    failures,
    core: coreReport,
    rpc: rpcReport,
    eventSequences,
  };
  const reportPath = REPORT_PATH;
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log('== Project continuity lifecycle validation ==');
  console.log(`runtime=${PI_PKG}`);
  console.log(`pi-ai=${PI_AI_PKG}`);
  console.log(`extension=${EXT_ENTRY}`);
  console.log(`scratch=${scratch}`);
  console.log(`cleanup=${JSON.stringify(cleanup)}`);
  if (coreReport) {
    console.log(`loader errors=${JSON.stringify(coreReport.loaderErrors)}`);
    console.log(`extension errors=${JSON.stringify(coreReport.extensionErrors)}`);
    console.log(`active tools=${JSON.stringify(coreReport.activeTools)}`);
    console.log('requests:');
    for (const request of coreReport.requests) {
      console.log(`  #${request.index} ${request.phase} summary=${request.isSummary} roles=${request.roles.join(',')} continuityBlocks=${request.continuityBlocks} continuityChars=${request.continuityChars} totalChars=${request.totalChars} tools=${request.tools.join(',')} system=${JSON.stringify(request.system)}`);
    }
    console.log(`compaction=${JSON.stringify(coreReport.compaction)}`);
    console.log(`search=${JSON.stringify(coreReport.search)}`);
    console.log(`initialBranch=${JSON.stringify(coreReport.initialBranch)} branch=${JSON.stringify(coreReport.branch)} adopt=${JSON.stringify(coreReport.adopt)}`);
    console.log(`sessionFile=${coreReport.sessionFile}`);
  } else {
    console.log('core validation did not complete');
  }
  if (rpcReport) {
    console.log(`rpc=${JSON.stringify({ commandListed: rpcReport.commandListed, disposition: rpcReport.disposition, customEvents: rpcReport.customEvents, getMessages: rpcReport.getMessages, getEntries: rpcReport.getEntries, error: rpcReport.error })}`);
    if (rpcReport.records) console.log(`rpc records=${rpcReport.records.join(',')}`);
  }
  console.log('event sequences:');
  for (const [phase, events] of Object.entries(eventSequences)) {
    console.log(`  ${phase}: ${events.join(' -> ')}`);
  }
  console.log(`assertions passed=${assertions.length}`);
  if (failures.length) {
    console.log('FAILURES:');
    for (const failure of failures) console.log(`  [${failure.scope}] ${failure.message}`);
  }
  console.log(`report=${reportPath}`);
  console.log(`RESULT=${report.ok ? 'PASS' : 'FAIL'}`);
  process.exit(report.ok ? 0 : 1);
}

main().catch(async (error) => {
  await disposeOpenSessions();
  try { if (scratch) await cleanupScratch(); } catch {}
  console.error('FATAL', describeError(error));
  process.exit(1);
});
