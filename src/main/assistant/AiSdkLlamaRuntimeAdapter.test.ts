/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExceedContextSizeError } from './AssistantErrors';
import {
  AiSdkLlamaRuntimeAdapter,
  toExceedContextSizeError,
} from './AiSdkLlamaRuntimeAdapter';

function createRuntime() {
  return {
    ensureStarted: async () => ({ success: true }),
    getRuntimeModelName: () => 'local-model',
    getBaseUrl: () => 'http://127.0.0.1:11435',
  } as any;
}

function createProviderFactory() {
  return () => {
    const provider = (modelId: string) => ({ modelId });
    provider.chatModel = (modelId: string) => ({ modelId, chat: true });
    return provider;
  };
}

async function* streamParts(parts: Array<Record<string, unknown>>) {
  for (const part of parts) {
    yield part as any;
  }
}

test('AiSdkLlamaRuntimeAdapter streams text deltas and captures final tool calls without executing tools', async () => {
  const deltas: string[] = [];
  let receivedOptions: Record<string, unknown> | null = null;
  const adapter = new AiSdkLlamaRuntimeAdapter(createRuntime(), {
    createProvider: createProviderFactory(),
    streamText: (options) => {
      receivedOptions = options;
      return {
        fullStream: streamParts([
          { type: 'text-delta', text: 'Hello' },
          { type: 'text-delta', text: ' there' },
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
  });

  const response = await adapter.chatCompletions(
    {
      model: 'local-model',
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

  assert.deepEqual(deltas, ['Hello', ' there']);
  assert.equal(response.choices?.[0]?.message?.content, 'Hello there');
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

test('AiSdkLlamaRuntimeAdapter accumulates streamed tool input chunks', async () => {
  const adapter = new AiSdkLlamaRuntimeAdapter(createRuntime(), {
    createProvider: createProviderFactory(),
    streamText: () => ({
      fullStream: streamParts([
        { type: 'tool-input-start', id: 'call-1', toolName: 'set_fill_color' },
        { type: 'tool-input-delta', id: 'call-1', delta: '{"nodeId":"' },
        { type: 'tool-input-delta', id: 'call-1', delta: '1:2"}' },
        { type: 'tool-input-end', id: 'call-1' },
        { type: 'finish', finishReason: 'tool-calls' },
      ]),
    }),
  });

  const response = await adapter.chatCompletions({
    model: 'local-model',
    messages: [{ role: 'user', content: 'change color' }],
    tools: [{
      type: 'function',
      function: {
        name: 'set_fill_color',
        description: 'Set fill',
        parameters: { type: 'object', properties: { nodeId: { type: 'string' } } },
      },
    }],
    tool_choice: 'auto',
  });

  assert.equal(response.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments, '{"nodeId":"1:2"}');
});

test('AiSdkLlamaRuntimeAdapter forwards abort signals into streamText', async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const adapter = new AiSdkLlamaRuntimeAdapter(createRuntime(), {
    createProvider: createProviderFactory(),
    streamText: (options) => {
      receivedSignal = options.abortSignal as AbortSignal;
      throw new Error('aborted');
    },
  });

  controller.abort();
  await assert.rejects(
    () => adapter.chatCompletions({ model: 'local-model', messages: [{ role: 'user', content: 'hello' }] }, controller.signal),
    /aborted/,
  );
  assert.equal(receivedSignal, controller.signal);
});

test('AiSdkLlamaRuntimeAdapter maps llama context-size provider errors', async () => {
  const error = toExceedContextSizeError({
    responseBody: JSON.stringify({
      error: {
        type: 'exceed_context_size_error',
        message: 'too many prompt tokens',
        n_prompt_tokens: 9000,
        n_ctx: 4096,
      },
    }),
  });

  assert.ok(error instanceof ExceedContextSizeError);
  assert.equal(error.promptTokens, 9000);
  assert.equal(error.currentContext, 4096);
});

test('AiSdkLlamaRuntimeAdapter preserves generic provider errors', async () => {
  const adapter = new AiSdkLlamaRuntimeAdapter(createRuntime(), {
    createProvider: createProviderFactory(),
    streamText: () => {
      throw new Error('provider offline');
    },
  });

  await assert.rejects(
    () => adapter.chatCompletions({ model: 'local-model', messages: [{ role: 'user', content: 'hello' }] }),
    /provider offline/,
  );
});
