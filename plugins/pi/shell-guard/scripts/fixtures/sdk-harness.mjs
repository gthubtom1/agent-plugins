// Deterministic, in-process SDK fixtures. No shell, child process, or network APIs.
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const bashSchema = object({ command: { type: 'string' }, timeout: { type: 'number' } }, ['command']);
const textResult = (text, details = {}) => ({ content: [{ type: 'text', text }], details });

export function createSdkFixture(ai) {
  let queued;
  let api;
  let sequence = 0;
  let providerRequests = 0;
  const executed = [];
  const events = [];
  const modelCalls = [];
  const settingsSeen = [];
  let blockNextBash = false;

  // Record actual post-preflight arguments without executing them. Even a
  // broken guard cannot start a dangerous process or move files in this fixture.
  async function inertBash(toolCallId, args) {
    const entry = { toolCallId, argv: structuredClone(args), timeout: args.timeout };
    executed.push(entry);
    return textResult('INERT_BASH_CAPTURED', entry);
  }

  const provider = {
    name: 'In-process SDK verification fixture',
    baseUrl: 'http://127.0.0.1:9/never-requested',
    apiKey: 'inert-fixture-value',
    api: 'openai-completions',
    models: [{
      id: 'fixture-model', name: 'Fixture Model', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1024,
    }],
    streamSimple(model) {
      if (++providerRequests > 500) throw new Error('Fixture provider request budget exceeded');
      const stream = ai.createAssistantMessageEventStream();
      const message = {
        role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp: Date.now(),
      };
      const call = queued;
      queued = undefined;
      stream.push({ type: 'start', partial: message });
      if (call) {
        modelCalls.push(structuredClone(call));
        message.content.push(call);
        message.stopReason = 'toolUse';
        stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
        stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: message });
      } else {
        message.content.push({ type: 'text', text: 'FIXTURE_DONE' });
        stream.push({ type: 'text_start', contentIndex: 0, partial: message });
        stream.push({ type: 'text_end', contentIndex: 0, content: 'FIXTURE_DONE', partial: message });
      }
      stream.push({ type: 'done', reason: message.stopReason, message });
      return stream;
    },
  };

  function extension(extensionApi) {
    api = extensionApi;
    for (const name of ['session_start', 'session_tree', 'agent_start', 'agent_end', 'agent_settled']) {
      api.on(name, (event) => { events.push({ type: name, reason: event.reason }); });
    }
    api.on('before_agent_start', (event) => {
      events.push({ type: 'before_agent_start', messageType: event.messageType, prompt: event.prompt });
      settingsSeen.push(api.getSettings().shellGuard);
    });
    api.on('tool_call', (event) => {
      events.push({ type: 'tool_call', toolCallId: event.toolCallId, parentToolCallId: event.parentToolCallId,
        toolName: event.toolName, input: structuredClone(event.input) });
      if (event.toolName === 'bash' && blockNextBash) {
        blockNextBash = false;
        return { block: true, reason: 'FIXTURE_LATER_HANDLER_BLOCK' };
      }
    });
    api.registerTool({ name: 'bash', label: 'Inert bash', description: 'Capture arguments only; never execute commands.',
      parameters: bashSchema, execute: inertBash });

    for (const [name, child] of [['fixture_nested', 'bash'], ['fixture_nested_twice', 'fixture_nested']]) {
      api.registerTool({
        name, label: name, description: 'Exercise real SDK nested tool preflight.', parameters: bashSchema,
        reachesTools: () => [child],
        async execute(_id, args, signal, _onUpdate, ctx) {
          const inner = await ctx.executeTool(child, args, { signal });
          return { ...inner.result, isError: inner.isError === true, details: { inner } };
        },
      });
    }
    api.registerTool({ name: 'fixture_errors', label: 'Nested error contract', description: 'Check SDK error results.',
      parameters: object({ kind: { type: 'string', enum: ['unknown', 'validation', 'throw'] } }, ['kind']),
      async execute(_id, { kind }, signal, _onUpdate, ctx) {
        const inner = await ctx.executeTool(kind === 'unknown' ? 'fixture_missing' : kind === 'throw' ? 'fixture_throw' : 'bash',
          {}, { signal });
        return { ...inner.result, isError: inner.isError === true, details: { inner } };
      },
    });
    api.registerTool({ name: 'fixture_throw', label: 'Throw fixture', description: 'Throw a deterministic error.',
      parameters: object({}), async execute() { throw new Error('FIXTURE_THROW'); } });
  }

  return {
    provider, extension, inertBash, executed, events, modelCalls, settingsSeen,
    get providerRequests() { return providerRequests; },
    queue(name, args) {
      if (queued) throw new Error('Fixture already has a pending call');
      queued = { type: 'toolCall', id: `fixture-${++sequence}`, name, arguments: structuredClone(args) };
      return queued.id;
    },
    clearQueue() { queued = undefined; },
    blockNextBash() { blockNextBash = true; },

  };
}
