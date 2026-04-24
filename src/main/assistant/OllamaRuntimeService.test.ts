/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OllamaRuntimeService } from './OllamaRuntimeService';

function createSettings() {
  return {
    getContextLength: () => 8192,
  } as any;
}

function createJsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

async function* streamParts(parts: Array<Record<string, unknown>>) {
  for (const part of parts) {
    yield part as any;
  }
}

test('OllamaRuntimeService maps Ollama tags into assistant model records', async () => {
  const service = new OllamaRuntimeService({
    runtimeSettings: createSettings(),
    fetch: async () => createJsonResponse({
      models: [{
        name: 'llama3.2:latest',
        modified_at: '2026-04-24T00:00:00Z',
        size: 1234,
        digest: 'sha256:abc',
        details: {
          family: 'llama',
          parameter_size: '3.2B',
          quantization_level: 'Q4_K_M',
        },
      }],
    }),
  });

  const snapshot = await service.getSnapshot();

  assert.equal(snapshot.daemonReachable, true);
  assert.equal(snapshot.models.length, 1);
  assert.equal(snapshot.models[0].id, 'llama3.2:latest');
  assert.equal(snapshot.models[0].source, 'ollama');
  assert.equal(snapshot.models[0].version, '3.2B Q4_K_M');
});

test('OllamaRuntimeService reports daemon errors without throwing', async () => {
  const service = new OllamaRuntimeService({
    runtimeSettings: createSettings(),
    fetch: async () => {
      throw new Error('connection refused');
    },
  });

  const snapshot = await service.getSnapshot();

  assert.equal(snapshot.daemonReachable, false);
  assert.equal(snapshot.models.length, 0);
  assert.match(snapshot.error ?? '', /Ollama is not reachable/);
});

test('OllamaRuntimeService streams text and captures tool calls without executing tools', async () => {
  const deltas: string[] = [];
  let receivedOptions: Record<string, unknown> | null = null;
  const service = new OllamaRuntimeService({
    runtimeSettings: createSettings(),
    createProvider: () => ({
      chat: (modelId: string, settings: unknown) => ({ modelId, settings }),
    } as any),
    streamText: (options) => {
      receivedOptions = options;
      return {
        fullStream: streamParts([
          { type: 'text-delta', text: 'Done' },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'get_document_info',
            input: { depth: 1 },
          },
          { type: 'finish', rawFinishReason: 'tool_calls' },
        ]),
      };
    },
    fetch: async () => createJsonResponse({ models: [] }),
  });

  const response = await service.chatCompletions(
    {
      model: 'llama3.2:latest',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_document_info',
          description: 'Read Figma document info',
          parameters: { type: 'object', properties: { depth: { type: 'number' } } },
        },
      }],
      tool_choice: 'auto',
    },
    undefined,
    (delta) => deltas.push(delta),
  );

  assert.deepEqual(deltas, ['Done']);
  assert.equal(response.choices?.[0]?.message?.content, 'Done');
  assert.equal(response.choices?.[0]?.finish_reason, 'tool_calls');
  assert.deepEqual(response.choices?.[0]?.message?.tool_calls, [{
    id: 'call-1',
    type: 'function',
    function: {
      name: 'get_document_info',
      arguments: '{"depth":1}',
    },
  }]);
  assert.ok(receivedOptions);
  const options = receivedOptions as Record<string, unknown>;
  assert.equal(Boolean((options.tools as Record<string, unknown> | undefined)?.get_document_info), true);
});
