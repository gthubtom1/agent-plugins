// Deterministic fake provider extension used by the lifecycle harness.
// It makes no network calls and records normalized request contexts to PI_FIXTURE_CAPTURE.
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const FIXTURE_TEXT = 'FIXTURE_OK';
export const FIXTURE_SUMMARY = '## Goal\nFixture lifecycle summary.\n\n## Constraints & Preferences\n- no network\n\n## Progress\n### Done\n- [x] fixture prompt and compaction\n\n### In Progress\n- [ ] none\n\n### Blocked\n- none\n\n## Key Decisions\n- **Fixture memory**: cancellation remains authoritative.\n\n## Next Steps\n1. Continue fixture validation.\n\n## Critical Context\n- fixture-local';

export function messageText(message) {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n');
}

export function makeProvider(createStream, { onRequest, text = FIXTURE_TEXT, summary = FIXTURE_SUMMARY } = {}) {
  return {
    name: 'Fixture Provider',
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: 'fixture-key',
    api: 'openai-completions',
    models: [{ id: 'fixture-model', name: 'Fixture Model', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 8192 }],
    streamSimple(model, context) {
      const systemText = context.messages.filter((m) => m.role === 'system').map(messageText).join('\n');
      const isSummary = /summar/i.test(systemText);
      const responseText = isSummary ? summary : text;
      if (onRequest) {
        onRequest({
          isSummary,
          model: { provider: model.provider, id: model.id },
          messages: JSON.parse(JSON.stringify(context.messages)),
          responseText,
        });
      }
      const stream = createStream();
      const message = {
        role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'pending', timestamp: Date.now(),
      };
      stream.push({ type: 'start', partial: message });
      message.content.push({ type: 'text', text: '' });
      stream.push({ type: 'text_start', contentIndex: 0, partial: message });
      message.content[0].text = responseText;
      stream.push({ type: 'text_end', contentIndex: 0, content: responseText, partial: message });
      message.stopReason = 'stop';
      stream.push({ type: 'done', reason: 'stop', message });
      return stream;
    },
  };
}

export async function loadFixtureProvider() {
  const modulePath = process.env.PI_FIXTURE_PI_AI;
  if (!modulePath) throw new Error('PI_FIXTURE_PI_AI is required');
  const ai = await import(pathToFileURL(modulePath).href);
  const capture = process.env.PI_FIXTURE_CAPTURE;
  return {
    ai,
    provider: makeProvider(ai.createAssistantMessageEventStream, {
      onRequest(request) {
        if (!capture) return;
        appendFileSync(capture, JSON.stringify({ ...request, at: Date.now() }) + '\n', 'utf8');
      },
    }),
  };
}

// Default export so the CLI can load this file as an extension.
export default async function fixtureProviderExtension(pi) {
  const { provider } = await loadFixtureProvider();
  pi.registerProvider('fixture', provider);
}
