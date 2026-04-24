/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { createOllama } from 'ai-sdk-ollama';
import {
  jsonSchema,
  streamText,
  tool,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import type { AssistantInstalledModel } from '../../shared/types';
import type { ChatRuntime } from './AssistantRunExecutor';
import type { AssistantRuntimeSettings } from './AssistantRuntimeSettings';
import type {
  LlamaChatCompletionResponse,
  LlamaChatMessage,
  LlamaContentPart,
  LlamaToolCall,
  LlamaToolDefinition,
} from './AssistantLlamaTypes';

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

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
type OllamaProvider = ReturnType<typeof createOllama>;
type OllamaProviderFactory = (options: { baseURL: string }) => OllamaProvider;
type RuntimeFetch = typeof fetch;

interface PendingToolInput {
  toolName: string;
  argumentText: string;
}

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
    modified_at?: string;
    size?: number;
    digest?: string;
    details?: {
      family?: string;
      families?: string[];
      parameter_size?: string;
      quantization_level?: string;
    };
  }>;
}

export interface OllamaRuntimeSnapshot {
  daemonReachable: boolean;
  models: AssistantInstalledModel[];
  error?: string;
}

interface OllamaRuntimeServiceOptions {
  runtimeSettings: AssistantRuntimeSettings;
  baseUrl?: string;
  streamText?: AiSdkStreamText;
  createProvider?: OllamaProviderFactory;
  fetch?: RuntimeFetch;
}

const defaultStreamText = streamText as unknown as AiSdkStreamText;

export class OllamaRuntimeService implements ChatRuntime {
  private readonly runtimeSettings: AssistantRuntimeSettings;
  private readonly baseUrl: string;
  private readonly streamText: AiSdkStreamText;
  private readonly createProvider: OllamaProviderFactory;
  private readonly fetchImpl: RuntimeFetch;
  private activeModelName = '';

  constructor(options: OllamaRuntimeServiceOptions) {
    this.runtimeSettings = options.runtimeSettings;
    this.baseUrl = options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL;
    this.streamText = options.streamText ?? defaultStreamText;
    this.createProvider = options.createProvider ?? ((providerOptions) => createOllama(providerOptions));
    this.fetchImpl = options.fetch ?? fetch;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async getSnapshot(): Promise<OllamaRuntimeSnapshot> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) {
        return {
          daemonReachable: false,
          models: [],
          error: `Ollama daemon returned HTTP ${response.status}.`,
        };
      }

      const payload = await response.json() as OllamaTagsResponse;
      return {
        daemonReachable: true,
        models: (payload.models ?? []).map(toInstalledModel).sort((a, b) => b.installedAt - a.installedAt),
      };
    } catch (error) {
      return {
        daemonReachable: false,
        models: [],
        error: `Ollama is not reachable at ${this.baseUrl}. Start Ollama, then refresh models.`,
      };
    }
  }

  async ensureStarted(model: AssistantInstalledModel): Promise<{ success: boolean; error?: string }> {
    const snapshot = await this.getSnapshot();
    if (!snapshot.daemonReachable) {
      return { success: false, error: snapshot.error ?? `Ollama is not reachable at ${this.baseUrl}.` };
    }

    const modelExists = snapshot.models.some((candidate) => candidate.id === model.id);
    if (!modelExists) {
      return { success: false, error: `Ollama model "${model.id}" is not available. Run "ollama pull ${model.id}" and refresh.` };
    }

    this.activeModelName = model.id;
    return { success: true };
  }

  getRuntimeModelName(): string {
    return this.activeModelName;
  }

  async chatCompletions(
    payload: ChatCompletionPayload,
    signal?: AbortSignal,
    onTextDelta?: (textDelta: string) => void,
  ): Promise<LlamaChatCompletionResponse> {
    const provider = this.createProvider({ baseURL: this.baseUrl });
    const result = this.streamText({
      model: provider.chat(payload.model, {
        keep_alive: '5m',
        reliableToolCalling: false,
        options: {
          num_ctx: this.runtimeSettings.getContextLength(),
        },
      }),
      messages: this.toModelMessages(payload.messages),
      tools: this.toAiSdkTools(payload.tools),
      toolChoice: payload.tool_choice ?? 'auto',
      maxRetries: 0,
      abortSignal: signal,
    });

    return await this.toLlamaCompletionResponse(result.fullStream, onTextDelta);
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

function toInstalledModel(model: NonNullable<OllamaTagsResponse['models']>[number]): AssistantInstalledModel {
  const name = model.name ?? model.model ?? 'unknown';
  const modifiedAt = model.modified_at ? Date.parse(model.modified_at) : NaN;
  const family = model.details?.family ?? 'ollama';
  const parameterSize = model.details?.parameter_size;
  const quantization = model.details?.quantization_level;
  return {
    id: name,
    displayName: name,
    version: [parameterSize, quantization].filter(Boolean).join(' ') || family,
    source: 'ollama',
    supportsVision: false,
    modelPath: name,
    modelSha256: model.digest ?? name,
    modelSizeBytes: model.size ?? 0,
    installedAt: Number.isFinite(modifiedAt) ? modifiedAt : Date.now(),
  };
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
