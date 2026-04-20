/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { app } from 'electron';
import { existsSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createLogger } from '../utils/logger';
import type { AssistantInstalledModel, AssistantRuntimeHealth } from '../../shared/types';
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

const DEFAULT_RUNTIME_PORT = 11435;
const RUNTIME_READY_TIMEOUT_MS = 40_000;
const RUNTIME_POLL_INTERVAL_MS = 500;

interface RuntimeBinaryStatus {
  ready: boolean;
  source: RuntimeBinarySource;
  path?: string;
}

export class EmbeddedLlamaRuntimeService {
  private readonly logger = createLogger('EmbeddedLlamaRuntimeService');
  private readonly onStateChanged?: () => void;
  private readonly port = DEFAULT_RUNTIME_PORT;

  private process: ChildProcessWithoutNullStreams | null = null;
  private health: AssistantRuntimeHealth = 'starting';
  private error: string | undefined;
  private currentModelId: string | null = null;
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
    return `http://127.0.0.1:${this.port}`;
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
    if (this.process && this.currentModelId === model.id && this.isReady()) {
      return { success: true };
    }

    if (this.process) {
      await this.stop();
    }

    const binaryPath = this.resolveRuntimeBinaryPath();
    if (!binaryPath) {
      const error = 'Bundled llama-server runtime is missing. Reinstall the app or rebuild the package.';
      this.setHealth('error', error);
      return { success: false, error };
    }

    const args = [
      '--host', '127.0.0.1',
      '--port', String(this.port),
      '-m', model.modelPath,
      '-c', '8192',
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
  }

  async chatCompletions(payload: ChatCompletionPayload, signal?: AbortSignal): Promise<ChatCompletionResponse> {
    const response = await fetch(`${this.getBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`llama-server chat completion failed: HTTP ${response.status} ${text}`);
    }

    return await response.json() as ChatCompletionResponse;
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
