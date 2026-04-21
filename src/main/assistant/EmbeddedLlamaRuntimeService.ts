/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { app } from 'electron';
import { existsSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createLogger } from '../utils/logger';
import { getSetting, setSetting } from '../utils/store';
import { getProcessOnPort, isPortAvailable } from '../utils/port-manager';
import type { AssistantInstalledModel, AssistantRuntimeHealth } from '../../shared/types';
import { ASSISTANT_CONTEXT_LENGTH, STORE_KEYS } from '../../shared/constants';
import {
  type RuntimeBinarySource,
  buildBundledRuntimeCandidates,
  getRuntimeBinaryFileName,
  resolveRuntimePlatformKey,
} from './runtimeBinary';

interface EnsureStartedResult {
  success: boolean;
  error?: string;
}

interface ChatCompletionPayload {
  model: string;
  messages: unknown[];
  tools?: unknown[];
  tool_choice?: 'auto' | 'none';
  stream?: boolean;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

interface LlamaServerErrorPayload {
  error?: {
    code?: number;
    message?: string;
    type?: string;
    n_prompt_tokens?: number;
    n_ctx?: number;
  };
}

export class ExceedContextSizeError extends Error {
  readonly promptTokens: number;
  readonly currentContext: number;

  constructor(message: string, promptTokens: number, currentContext: number) {
    super(message);
    this.name = 'ExceedContextSizeError';
    this.promptTokens = promptTokens;
    this.currentContext = currentContext;
  }
}

const DEFAULT_RUNTIME_PORT = 11435;
const MAX_RUNTIME_PORT = 11455;
const RUNTIME_READY_TIMEOUT_MS = 40_000;
const RUNTIME_POLL_INTERVAL_MS = 500;
const RUNTIME_PORT_RELEASE_TIMEOUT_MS = 5_000;
const RUNTIME_PORT_RELEASE_POLL_MS = 100;

interface RuntimeBinaryStatus {
  ready: boolean;
  source: RuntimeBinarySource;
  path?: string;
}

export class EmbeddedLlamaRuntimeService {
  private readonly logger = createLogger('EmbeddedLlamaRuntimeService');
  private readonly onStateChanged?: () => void;

  private process: ChildProcessWithoutNullStreams | null = null;
  private health: AssistantRuntimeHealth = 'starting';
  private error: string | undefined;
  private currentModelId: string | null = null;
  private currentContextLength: number | null = null;
  private activePort = DEFAULT_RUNTIME_PORT;
  private runtimeModelName = 'local-model';

  constructor(options?: { onStateChanged?: () => void }) {
    this.onStateChanged = options?.onStateChanged;
  }

  getHealth(): AssistantRuntimeHealth {
    return this.health;
  }

  getError(): string | undefined {
    return this.error;
  }

  isReady(): boolean {
    return this.health === 'ready';
  }

  getBaseUrl(): string {
    return `http://127.0.0.1:${this.activePort}`;
  }

  getRuntimeModelName(): string {
    return this.runtimeModelName;
  }

  getRuntimeBinaryStatus(): RuntimeBinaryStatus {
    const binaryPath = this.resolveRuntimeBinaryPath();
    if (!binaryPath) {
      return {
        ready: false,
        source: 'missing',
      };
    }

    return {
      ready: true,
      source: 'bundled',
      path: binaryPath,
    };
  }

  async ensureStarted(model: AssistantInstalledModel): Promise<EnsureStartedResult> {
    const contextLength = this.getConfiguredContextLength();
    if (
      this.process
      && this.currentModelId === model.id
      && this.currentContextLength === contextLength
      && this.isReady()
    ) {
      return { success: true };
    }

    if (this.process) {
      await this.stop();
    }

    const nextPort = await this.resolveRuntimePort();
    if (!nextPort) {
      const processInfo = await getProcessOnPort(DEFAULT_RUNTIME_PORT);
      const processLabel = processInfo ? `${processInfo.name} (PID ${processInfo.pid})` : 'another process';
      const error = `Assistant runtime could not find an open port near ${DEFAULT_RUNTIME_PORT}. Default port is currently used by ${processLabel}.`;
      this.setHealth('error', error);
      return { success: false, error };
    }
    this.activePort = nextPort;

    const binaryPath = this.resolveRuntimeBinaryPath();
    if (!binaryPath) {
      const error = 'Bundled llama-server runtime is missing. Reinstall the app or rebuild the package.';
      this.setHealth('error', error);
      return { success: false, error };
    }

    const args = [
      '--host', '127.0.0.1',
      '--port', String(this.activePort),
      '-m', model.modelPath,
      '-c', String(contextLength),
      '--jinja',
    ];

    if (model.mmprojPath) {
      args.push('--mmproj', model.mmprojPath);
    }

    this.logger.info(`Starting llama-server: ${binaryPath} ${args.join(' ')}`);
    this.setHealth('starting');

    this.process = spawn(binaryPath, args, {
      stdio: 'pipe',
      env: process.env,
    });

    this.process.on('error', (error) => {
      this.process = null;
      this.currentModelId = null;
      this.currentContextLength = null;
      this.setHealth('error', `Failed to launch llama-server: ${error.message}`);
    });

    this.process.stdout.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) {
        this.logger.debug(`[llama-server] ${text}`);
      }
    });
    this.process.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) {
        this.logger.debug(`[llama-server][stderr] ${text}`);
      }
    });

    this.process.on('exit', (code, signal) => {
      this.process = null;
      this.currentModelId = null;
      this.currentContextLength = null;
      if (this.health !== 'error') {
        this.setHealth('error', `llama-server exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      }
    });

    const ready = await this.waitUntilReady();
    if (!ready.success) {
      this.setHealth('error', ready.error);
      return ready;
    }

    this.currentModelId = model.id;
    this.currentContextLength = contextLength;
    this.setHealth('ready');
    return { success: true };
  }

  async stop(): Promise<void> {
    const proc = this.process;
    if (!proc) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // no-op
        }
        resolve();
      }, 3000);

      proc.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      try {
        proc.kill('SIGTERM');
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    });

    this.process = null;
    this.currentModelId = null;
    this.currentContextLength = null;
    await this.waitUntilPortAvailable(this.activePort, RUNTIME_PORT_RELEASE_TIMEOUT_MS);
  }

  async chatCompletions(
    payload: ChatCompletionPayload,
    signal?: AbortSignal,
    onTextDelta?: (textDelta: string) => void,
  ): Promise<ChatCompletionResponse> {
    const response = await fetch(`${this.getBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...payload,
        stream: true,
      }),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      const parsedError = this.parseLlamaServerError(text);
      const promptTokens = parsedError?.error?.n_prompt_tokens;
      const currentContext = parsedError?.error?.n_ctx;
      if (
        parsedError?.error?.type === 'exceed_context_size_error'
        && typeof promptTokens === 'number'
        && typeof currentContext === 'number'
      ) {
        throw new ExceedContextSizeError(
          parsedError.error.message ?? `Request exceeds available context size (${currentContext})`,
          promptTokens,
          currentContext,
        );
      }
      throw new Error(`llama-server chat completion failed: HTTP ${response.status} ${text}`);
    }

    if (!response.body) {
      throw new Error('llama-server chat completion failed: response body is missing');
    }

    return await this.readStreamingChatCompletion(response.body, onTextDelta);
  }

  private resolveRuntimeBinaryPath(): string | null {
    const candidates = this.getBundledRuntimeCandidates();
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  private getBundledRuntimeCandidates(): string[] {
    const platformKey = resolveRuntimePlatformKey(process.platform, process.arch);
    const binaryFileName = getRuntimeBinaryFileName(process.platform);
    return buildBundledRuntimeCandidates({
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      platformKey,
      binaryFileName,
    });
  }

  private getConfiguredContextLength(): number {
    const value = getSetting<number>(STORE_KEYS.ASSISTANT_CONTEXT_LENGTH);
    return this.normalizeContextLength(value);
  }

  increaseContextLengthForPrompt(promptTokens: number, currentContext: number): number | null {
    const configured = this.getConfiguredContextLength();
    const requiredWithHeadroom = Math.max(promptTokens + 2_048, configured);
    const nextContextLength = ASSISTANT_CONTEXT_LENGTH.OPTIONS.find((option) => option >= requiredWithHeadroom) ?? null;

    if (!nextContextLength || nextContextLength <= currentContext) {
      return null;
    }

    setSetting(STORE_KEYS.ASSISTANT_CONTEXT_LENGTH, nextContextLength);
    this.logger.warn(
      `Increasing assistant context length from ${currentContext} to ${nextContextLength} after exceed_context_size_error (${promptTokens} prompt tokens)`,
    );
    return nextContextLength;
  }

  private normalizeContextLength(value: unknown): number {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      return ASSISTANT_CONTEXT_LENGTH.DEFAULT;
    }

    const rounded = Math.round(numeric);
    return ASSISTANT_CONTEXT_LENGTH.OPTIONS.includes(rounded as typeof ASSISTANT_CONTEXT_LENGTH.OPTIONS[number])
      ? rounded
      : ASSISTANT_CONTEXT_LENGTH.DEFAULT;
  }

  private parseLlamaServerError(text: string): LlamaServerErrorPayload | null {
    try {
      return JSON.parse(text) as LlamaServerErrorPayload;
    } catch {
      return null;
    }
  }

  private async resolveRuntimePort(): Promise<number | null> {
    const preferredPort = this.activePort;

    if (await this.waitUntilPortAvailable(preferredPort, RUNTIME_PORT_RELEASE_TIMEOUT_MS)) {
      return preferredPort;
    }

    for (let port = DEFAULT_RUNTIME_PORT; port <= MAX_RUNTIME_PORT; port += 1) {
      if (await isPortAvailable(port)) {
        if (port !== preferredPort) {
          this.logger.warn(`Assistant runtime port ${preferredPort} is unavailable, switching to ${port}`);
        }
        return port;
      }
    }

    return null;
  }

  private async waitUntilPortAvailable(port: number, timeoutMs: number): Promise<boolean> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      if (await isPortAvailable(port)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, RUNTIME_PORT_RELEASE_POLL_MS));
    }

    return await isPortAvailable(port);
  }

  private async readStreamingChatCompletion(
    body: ReadableStream<Uint8Array>,
    onTextDelta?: (textDelta: string) => void,
  ): Promise<ChatCompletionResponse> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const toolCalls: NonNullable<NonNullable<NonNullable<ChatCompletionResponse['choices']>[0]['message']>['tool_calls']> = [];
    const message: NonNullable<NonNullable<ChatCompletionResponse['choices']>[0]['message']> = {
      role: 'assistant',
      content: '',
    };
    let finishReason: string | null = null;
    let sawDone = false;

    const ensureToolCall = (index: number) => {
      if (!toolCalls[index]) {
        toolCalls[index] = {
          id: '',
          type: 'function',
          function: {
            name: '',
            arguments: '',
          },
        };
      }
      return toolCalls[index]!;
    };

    const applyChunk = (chunk: ChatCompletionChunk) => {
      const choice = chunk.choices?.[0];
      if (!choice) {
        return;
      }

      finishReason = choice.finish_reason ?? finishReason;
      const delta = choice.delta;
      if (!delta) {
        return;
      }

      if (typeof delta.role === 'string' && delta.role.trim().length > 0) {
        message.role = delta.role;
      }

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        message.content = `${message.content ?? ''}${delta.content}`;
        onTextDelta?.(delta.content);
      }

      if (!Array.isArray(delta.tool_calls)) {
        return;
      }

      for (const partialToolCall of delta.tool_calls) {
        const index = typeof partialToolCall.index === 'number'
          ? partialToolCall.index
          : toolCalls.length;
        const toolCall = ensureToolCall(index);

        if (typeof partialToolCall.id === 'string' && partialToolCall.id.length > 0) {
          toolCall.id = partialToolCall.id;
        }
        if (partialToolCall.type) {
          toolCall.type = partialToolCall.type;
        }

        if (!toolCall.function) {
          toolCall.function = {
            name: '',
            arguments: '',
          };
        }

        if (typeof partialToolCall.function?.name === 'string' && partialToolCall.function.name.length > 0) {
          toolCall.function.name = `${toolCall.function.name ?? ''}${partialToolCall.function.name}`;
        }
        if (
          typeof partialToolCall.function?.arguments === 'string'
          && partialToolCall.function.arguments.length > 0
        ) {
          toolCall.function.arguments = `${toolCall.function.arguments ?? ''}${partialToolCall.function.arguments}`;
        }
      }
    };

    const processEvent = (rawEvent: string) => {
      const data = rawEvent
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
        .trim();

      if (!data) {
        return;
      }

      if (data === '[DONE]') {
        sawDone = true;
        return;
      }

      const parsed = JSON.parse(data) as ChatCompletionChunk;
      applyChunk(parsed);
    };

    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');

      let boundaryIndex = buffer.indexOf('\n\n');
      while (boundaryIndex >= 0) {
        const rawEvent = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);
        if (rawEvent.trim().length > 0) {
          processEvent(rawEvent);
        }
        boundaryIndex = buffer.indexOf('\n\n');
      }

      if (done) {
        break;
      }
    }

    if (!sawDone && buffer.trim().length > 0) {
      processEvent(buffer);
    }

    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    return {
      choices: [
        {
          message,
          finish_reason: finishReason,
        },
      ],
    };
  }

  private async waitUntilReady(): Promise<EnsureStartedResult> {
    const start = Date.now();

    while (Date.now() - start < RUNTIME_READY_TIMEOUT_MS) {
      if (!this.process) {
        return {
          success: false,
          error: this.error ?? 'llama-server exited before becoming ready',
        };
      }

      try {
        const response = await fetch(`${this.getBaseUrl()}/v1/models`);
        if (response.ok) {
          const data = await response.json() as { data?: Array<{ id?: string }> };
          const modelName = data?.data?.[0]?.id;
          if (typeof modelName === 'string' && modelName.trim().length > 0) {
            this.runtimeModelName = modelName;
          }
          return { success: true };
        }
      } catch {
        // Runtime is still booting.
      }
      await new Promise((resolve) => setTimeout(resolve, RUNTIME_POLL_INTERVAL_MS));
    }

    return { success: false, error: 'llama-server did not become ready in time' };
  }

  private setHealth(nextHealth: AssistantRuntimeHealth, error?: string): void {
    this.health = nextHealth;
    this.error = error;
    this.onStateChanged?.();
  }
}
