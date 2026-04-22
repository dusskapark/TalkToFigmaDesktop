/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  jsonSchema,
  streamText,
  tool,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import type { AssistantInstalledModel } from '../../shared/types';
import { ExceedContextSizeError } from './AssistantErrors';
import type { ChatRuntime } from './AssistantRunExecutor';
import { EmbeddedLlamaRuntimeService } from './EmbeddedLlamaRuntimeService';
import type {
  LlamaChatCompletionResponse,
  LlamaChatMessage,
  LlamaContentPart,
  LlamaToolCall,
  LlamaToolDefinition,
} from './AssistantLlamaTypes';

interface ChatCompletionPayload {
  model: string;
  messages: LlamaChatMessage[];
  tools?: unknown[];
  tool_choice?: 'auto' | 'none';
}

type AiSdkStreamPart =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-input-start'; id: string; toolName: string }
  | { type: 'tool-input-delta'; id: string; delta: string }
  | { type: 'tool-input-end'; id: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'finish-step'; rawFinishReason?: string; finishReason?: string }
  | { type: 'finish'; rawFinishReason?: string; finishReason?: string }
  | { type: 'error'; error: unknown };

interface AiSdkStreamTextResult {
  fullStream: AsyncIterable<AiSdkStreamPart>;
}

type AiSdkStreamText = (options: Record<string, unknown>) => AiSdkStreamTextResult;

type AiSdkProvider = {
  (modelId: string): unknown;
  chatModel?: (modelId: string) => unknown;
};

type AiSdkProviderFactory = (options: {
  name: string;
  baseURL: string;
  includeUsage?: boolean;
}) => AiSdkProvider;

interface AiSdkLlamaRuntimeAdapterOptions {
  streamText?: AiSdkStreamText;
  createProvider?: AiSdkProviderFactory;
}

interface PendingToolInput {
  toolName: string;
  argumentText: string;
}

const defaultStreamText = streamText as unknown as AiSdkStreamText;
const defaultCreateProvider = createOpenAICompatible as unknown as AiSdkProviderFactory;

export class AiSdkLlamaRuntimeAdapter implements ChatRuntime {
  private readonly streamText: AiSdkStreamText;
  private readonly createProvider: AiSdkProviderFactory;

  constructor(
    private readonly embeddedRuntime: EmbeddedLlamaRuntimeService,
    options: AiSdkLlamaRuntimeAdapterOptions = {},
  ) {
    this.streamText = options.streamText ?? defaultStreamText;
    this.createProvider = options.createProvider ?? defaultCreateProvider;
  }

  async ensureStarted(model: AssistantInstalledModel): Promise<{ success: boolean; error?: string }> {
    return this.embeddedRuntime.ensureStarted(model);
  }

  getRuntimeModelName(): string {
    return this.embeddedRuntime.getRuntimeModelName();
  }

  async chatCompletions(
    payload: ChatCompletionPayload,
    signal?: AbortSignal,
    onTextDelta?: (textDelta: string) => void,
  ): Promise<LlamaChatCompletionResponse> {
    try {
      const provider = this.createProvider({
        name: 'talktofigmaLlama',
        baseURL: `${this.embeddedRuntime.getBaseUrl()}/v1`,
        includeUsage: true,
      });

      const result = this.streamText({
        model: this.resolveModel(provider, payload.model),
        messages: this.toModelMessages(payload.messages),
        tools: this.toAiSdkTools(payload.tools),
        toolChoice: payload.tool_choice ?? 'auto',
        maxRetries: 0,
        abortSignal: signal,
      });

      return await this.toLlamaCompletionResponse(result.fullStream, onTextDelta);
    } catch (error) {
      const contextError = toExceedContextSizeError(error);
      if (contextError) {
        throw contextError;
      }
      throw error;
    }
  }

  private resolveModel(provider: AiSdkProvider, modelId: string): unknown {
    return provider.chatModel?.(modelId) ?? provider(modelId);
  }

  private async toLlamaCompletionResponse(
    fullStream: AsyncIterable<AiSdkStreamPart>,
    onTextDelta?: (textDelta: string) => void,
  ): Promise<LlamaChatCompletionResponse> {
    let content = '';
    let finishReason: string | null = null;
    const toolCalls = new Map<string, LlamaToolCall & { id: string }>();
    const pendingToolInputs = new Map<string, PendingToolInput>();

    for await (const part of fullStream) {
      if (part.type === 'text-delta') {
        content += part.text;
        onTextDelta?.(part.text);
        continue;
      }

      if (part.type === 'tool-input-start') {
        pendingToolInputs.set(part.id, {
          toolName: part.toolName,
          argumentText: '',
        });
        continue;
      }

      if (part.type === 'tool-input-delta') {
        const pending = pendingToolInputs.get(part.id) ?? {
          toolName: '',
          argumentText: '',
        };
        pending.argumentText += part.delta;
        pendingToolInputs.set(part.id, pending);
        continue;
      }

      if (part.type === 'tool-call') {
        toolCalls.set(part.toolCallId, {
          id: part.toolCallId,
          type: 'function',
          function: {
            name: part.toolName,
            arguments: stringifyToolInput(part.input),
          },
        });
        continue;
      }

      if (part.type === 'finish-step' || part.type === 'finish') {
        finishReason = part.rawFinishReason ?? part.finishReason ?? finishReason;
        continue;
      }

      if (part.type === 'error') {
        throw normalizeStreamError(part.error);
      }
    }

    for (const [toolCallId, pending] of pendingToolInputs.entries()) {
      if (toolCalls.has(toolCallId) || !pending.toolName) {
        continue;
      }
      toolCalls.set(toolCallId, {
        id: toolCallId,
        type: 'function',
        function: {
          name: pending.toolName,
          arguments: pending.argumentText || '{}',
        },
      });
    }

    return {
      choices: [
        {
          message: {
            role: 'assistant',
            content,
            ...(toolCalls.size > 0 ? { tool_calls: Array.from(toolCalls.values()) } : {}),
          },
          finish_reason: finishReason,
        },
      ],
    };
  }

  private toModelMessages(messages: LlamaChatMessage[]): ModelMessage[] {
    const toolNamesByCallId = new Map<string, string>();
    return messages.map((message) => {
      if (message.role === 'tool') {
        return {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: message.tool_call_id,
              toolName: toolNamesByCallId.get(message.tool_call_id) ?? 'unknown_tool',
              output: { type: 'text', value: message.content },
            },
          ],
        } as ModelMessage;
      }

      if (message.role === 'assistant') {
        const contentParts: unknown[] = [];
        const text = stringifyMessageContent(message.content);
        if (text) {
          contentParts.push({ type: 'text', text });
        }

        for (const toolCall of message.tool_calls ?? []) {
          const toolCallId = toolCall.id?.trim();
          const toolName = toolCall.function?.name?.trim();
          if (!toolCallId || !toolName) {
            continue;
          }
          toolNamesByCallId.set(toolCallId, toolName);
          contentParts.push({
            type: 'tool-call',
            toolCallId,
            toolName,
            input: parseToolArguments(toolCall.function?.arguments),
          });
        }

        return {
          role: 'assistant',
          content: contentParts.length > 0 ? contentParts : '',
        } as ModelMessage;
      }

      if (message.role === 'user') {
        return {
          role: 'user',
          content: toUserContent(message.content),
        } as ModelMessage;
      }

      return {
        role: 'system',
        content: stringifyMessageContent(message.content),
      } as ModelMessage;
    });
  }

  private toAiSdkTools(tools: unknown[] | undefined): ToolSet | undefined {
    const definitions = (tools ?? []).filter(isLlamaToolDefinition);
    if (definitions.length === 0) {
      return undefined;
    }

    const aiTools: ToolSet = {};
    for (const definition of definitions) {
      aiTools[definition.function.name] = tool({
        description: definition.function.description,
        inputSchema: jsonSchema(definition.function.parameters),
      }) as ToolSet[string];
    }
    return aiTools;
  }
}

export function toExceedContextSizeError(error: unknown): ExceedContextSizeError | null {
  const payload = findLlamaServerErrorPayload(error);
  const promptTokens = payload?.error?.n_prompt_tokens;
  const currentContext = payload?.error?.n_ctx;
  if (
    payload?.error?.type !== 'exceed_context_size_error'
    || typeof promptTokens !== 'number'
    || typeof currentContext !== 'number'
  ) {
    return null;
  }

  return new ExceedContextSizeError(
    payload.error.message ?? `Request exceeds available context size (${currentContext})`,
    promptTokens,
    currentContext,
  );
}

function toUserContent(content: string | LlamaContentPart[]): unknown {
  if (typeof content === 'string') {
    return content;
  }

  return content.map((part) => {
    if (part.type === 'image_url') {
      return {
        type: 'image',
        image: part.image_url.url,
      };
    }

    return {
      type: 'text',
      text: part.text,
    };
  });
}

function stringifyMessageContent(content: string | LlamaContentPart[]): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .map((part) => (part.type === 'text' ? part.text : `[image: ${part.image_url.url}]`))
    .join('\n')
    .trim();
}

function parseToolArguments(rawArguments: string | undefined): unknown {
  if (!rawArguments) {
    return {};
  }

  try {
    return JSON.parse(rawArguments);
  } catch {
    return { rawArguments };
  }
}

function stringifyToolInput(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }

  if (input === undefined) {
    return '{}';
  }

  return JSON.stringify(input);
}

function normalizeStreamError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === 'string' ? error : JSON.stringify(error));
}

function isLlamaToolDefinition(value: unknown): value is LlamaToolDefinition {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<LlamaToolDefinition>;
  return (
    candidate.type === 'function'
    && typeof candidate.function?.name === 'string'
    && typeof candidate.function.description === 'string'
    && Boolean(candidate.function.parameters)
  );
}

function findLlamaServerErrorPayload(error: unknown): {
  error?: {
    message?: string;
    type?: string;
    n_prompt_tokens?: number;
    n_ctx?: number;
  };
} | null {
  const visited = new WeakSet<object>();

  const visit = (value: unknown, depth: number): ReturnType<typeof findLlamaServerErrorPayload> => {
    if (depth > 4 || value == null) {
      return null;
    }

    if (typeof value === 'string') {
      try {
        return visit(JSON.parse(value), depth + 1);
      } catch {
        return null;
      }
    }

    if (typeof value !== 'object') {
      return null;
    }

    if (visited.has(value)) {
      return null;
    }
    visited.add(value);

    const candidate = value as {
      error?: {
        message?: unknown;
        type?: unknown;
        n_prompt_tokens?: unknown;
        n_ctx?: unknown;
      };
    };
    if (
      candidate.error
      && typeof candidate.error === 'object'
      && typeof candidate.error.type === 'string'
    ) {
      return value as ReturnType<typeof findLlamaServerErrorPayload>;
    }

    for (const key of ['data', 'cause', 'responseBody', 'body', 'payload', 'value']) {
      const nested = visit((value as Record<string, unknown>)[key], depth + 1);
      if (nested) {
        return nested;
      }
    }

    return null;
  };

  return visit(error, 0);
}
