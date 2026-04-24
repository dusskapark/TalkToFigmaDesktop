/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { v4 as uuidv4 } from 'uuid';
import { WebSocketClient } from '../server/shared/websocket-client';
import { createLogger } from '../utils/logger';
import type {
  AssistantMessage,
  AssistantMessagePart,
  AssistantMessagePartAttachment,
  AssistantModelCatalogItem,
  AssistantModelUploadRequest,
  AssistantRunEvent,
  AssistantRuntimeBackend,
  AssistantRuntimeStatus,
  AssistantThread,
  ToolApprovalRequest,
} from '../../shared/types';
import { ModelInstallService } from './ModelInstallService';
import { EmbeddedLlamaRuntimeService } from './EmbeddedLlamaRuntimeService';
import { AssistantRuntimeSettings } from './AssistantRuntimeSettings';
import { AssistantThreadRepository } from './AssistantThreadRepository';
import { AssistantMessageSerializer } from './AssistantMessageSerializer';
import { AssistantToolExecutor } from './AssistantToolExecutor';
import { AssistantRunExecutor, type ChatRuntime } from './AssistantRunExecutor';
import { OllamaRuntimeService } from './OllamaRuntimeService';
import { EmbeddedAssistantBackend } from './EmbeddedAssistantBackend';
import { OllamaAssistantBackend } from './OllamaAssistantBackend';
import type { AssistantRuntimeBackendAdapter } from './AssistantRuntimeBackendAdapter';
import { resolveAssistantActiveModel } from './AssistantActiveModelResolver';
import { AssistantRuntimeBackendCoordinator } from './AssistantRuntimeBackendCoordinator';

interface AssistantEventHandlers {
  onRunEvent?: (event: AssistantRunEvent) => void;
  onToolApprovalRequired?: (request: ToolApprovalRequest) => void;
  onRuntimeStatusChanged?: (status: AssistantRuntimeStatus) => void;
}

interface SendMessageResult {
  success: boolean;
  runId?: string;
  error?: string;
}

export class AssistantRuntimeService {
  private static instance: AssistantRuntimeService | null = null;

  private readonly logger = createLogger('AssistantRuntimeService');
  private readonly wsClient = new WebSocketClient({
    wsPort: 3055,
    autoReconnect: true,
    reconnectDelay: 1500,
    defaultTimeout: 20_000,
    clientType: 'mcp',
  });

  private readonly modelInstallService: ModelInstallService;
  private readonly embeddedRuntimeService: EmbeddedLlamaRuntimeService;
  private readonly ollamaRuntimeService: OllamaRuntimeService;
  private readonly embeddedBackend: EmbeddedAssistantBackend;
  private readonly runtimeBackends: Record<AssistantRuntimeBackend, AssistantRuntimeBackendAdapter>;
  private readonly chatRuntime: ChatRuntime;
  private readonly runtimeSettings: AssistantRuntimeSettings;
  private readonly threadRepository: AssistantThreadRepository;
  private readonly messageSerializer: AssistantMessageSerializer;
  private readonly toolExecutor: AssistantToolExecutor;
  private readonly runExecutor: AssistantRunExecutor;
  private readonly backendCoordinator: AssistantRuntimeBackendCoordinator;

  private handlers: AssistantEventHandlers = {};

  private constructor() {
    this.runtimeSettings = new AssistantRuntimeSettings();
    this.threadRepository = new AssistantThreadRepository();
    this.messageSerializer = new AssistantMessageSerializer(() => this.runtimeSettings.getHistoryToolResultLimit());

    this.modelInstallService = new ModelInstallService({
      onStateChanged: () => {
        void this.handleRuntimeStateChanged();
      },
    });

    this.embeddedRuntimeService = new EmbeddedLlamaRuntimeService({
      runtimeSettings: this.runtimeSettings,
      onStateChanged: () => {
        void this.handleRuntimeStateChanged();
      },
    });
    this.ollamaRuntimeService = new OllamaRuntimeService({
      runtimeSettings: this.runtimeSettings,
    });
    this.embeddedBackend = new EmbeddedAssistantBackend({
      modelInstallService: this.modelInstallService,
      embeddedRuntimeService: this.embeddedRuntimeService,
      logger: this.logger,
    });
    this.runtimeBackends = {
      embedded: this.embeddedBackend,
      ollama: new OllamaAssistantBackend({
        ollamaRuntimeService: this.ollamaRuntimeService,
        getRecommendedModel: () => this.modelInstallService.getRecommendedModel(),
      }),
    };
    this.chatRuntime = this.createRuntimeRouter();

    this.toolExecutor = new AssistantToolExecutor(this.wsClient, this.messageSerializer);
    this.runExecutor = new AssistantRunExecutor({
      modelLookup: {
        getInstalledModelById: (modelId) => this.getActiveBackendModelById(modelId),
      },
      runtime: this.chatRuntime,
      repository: this.threadRepository,
      serializer: this.messageSerializer,
      toolExecutor: this.toolExecutor,
      settings: this.runtimeSettings,
      emitRunEvent: (event) => this.emitRunEvent(event),
      requestToolApproval: (request) => this.handlers.onToolApprovalRequired?.(request),
      logger: this.logger,
      onContextLengthIncreased: (_promptTokens, currentContext, nextContext) => {
        this.logger.warn(`Assistant context length increased automatically (${currentContext} -> ${nextContext})`);
      },
    });
    this.backendCoordinator = new AssistantRuntimeBackendCoordinator({
      runtimeSettings: this.runtimeSettings,
      runtimeBackends: this.runtimeBackends,
      shutdownRuns: () => this.runExecutor.shutdown(),
      pruneInvalidThreadModels: () => this.pruneInvalidThreadModels(),
      emitRuntimeStatusChange: (threadId) => this.emitRuntimeStatusChange(threadId),
      getLastOpenedThreadId: () => this.threadRepository.getLastOpenedThreadId(),
    });

    void this.pruneInvalidThreadModels();
  }

  static getInstance(): AssistantRuntimeService {
    if (!AssistantRuntimeService.instance) {
      AssistantRuntimeService.instance = new AssistantRuntimeService();
    }
    return AssistantRuntimeService.instance;
  }

  static async shutdownIfInitialized(): Promise<void> {
    await AssistantRuntimeService.instance?.shutdown();
  }

  setEventHandlers(handlers: AssistantEventHandlers): void {
    this.handlers = handlers;
  }

  async shutdown(): Promise<void> {
    this.logger.info('Shutting down assistant runtime');
    this.runExecutor.shutdown();
    await Promise.all(Object.values(this.runtimeBackends).map((backend) => backend.deactivate()));
  }

  async listModels(): Promise<string[]> {
    return this.getCurrentBackend().listModels();
  }

  async listModelCatalog(): Promise<AssistantModelCatalogItem[]> {
    return this.embeddedBackend.listModelCatalog();
  }

  async downloadModel(modelId: string): Promise<{ success: boolean; error?: string }> {
    const result = await this.getCurrentBackend().downloadModel(modelId);
    await this.pruneInvalidThreadModels();
    await this.emitRuntimeStatusChange(this.threadRepository.getLastOpenedThreadId() ?? undefined);
    return result;
  }

  async cancelModelDownload(): Promise<{ success: boolean; error?: string }> {
    const result = await this.getCurrentBackend().cancelModelDownload();
    await this.emitRuntimeStatusChange(this.threadRepository.getLastOpenedThreadId() ?? undefined);
    return result;
  }

  async uploadModel(payload: AssistantModelUploadRequest): Promise<{ success: boolean; modelId?: string; error?: string }> {
    const result = await this.getCurrentBackend().uploadModel(payload);
    await this.pruneInvalidThreadModels();
    await this.emitRuntimeStatusChange(this.threadRepository.getLastOpenedThreadId() ?? undefined);
    return result;
  }

  async deleteModel(modelId: string): Promise<{ success: boolean; error?: string }> {
    const result = await this.getCurrentBackend().deleteModel(modelId);
    await this.pruneInvalidThreadModels();
    await this.emitRuntimeStatusChange(this.threadRepository.getLastOpenedThreadId() ?? undefined);
    return result;
  }

  async getRuntimeStatus(threadId?: string): Promise<AssistantRuntimeStatus> {
    const thread = threadId ? this.threadRepository.findThreadById(threadId) : null;
    return this.getCurrentBackend().getRuntimeStatus({
      thread,
      resolveActiveModel: (installedModels) => this.resolveActiveModel(thread, installedModels),
    });
  }

  async createThread(title?: string): Promise<AssistantThread> {
    const thread = this.threadRepository.createThread(title);
    await this.emitRuntimeStatusChange(thread.id);
    return thread;
  }

  async listThreads(): Promise<AssistantThread[]> {
    return this.threadRepository.listThreads();
  }

  async getThread(threadId: string): Promise<{ thread: AssistantThread | null; messages: AssistantMessage[] }> {
    return this.threadRepository.getThread(threadId);
  }

  async deleteThread(threadId: string): Promise<{ success: boolean; error?: string }> {
    const deleted = this.threadRepository.deleteThread(threadId);
    if (!deleted) {
      return { success: false, error: 'Thread not found' };
    }

    await this.emitRuntimeStatusChange(this.threadRepository.listThreads()[0]?.id);
    return { success: true };
  }

  async setActiveModel(threadId: string, model: string): Promise<{ success: boolean; error?: string }> {
    const trimmed = model.trim();
    if (!trimmed) {
      return { success: false, error: 'Model cannot be empty' };
    }

    const installed = await this.getActiveBackendModelById(trimmed);
    if (!installed) {
      return { success: false, error: 'Model is not available for the selected runtime' };
    }

    const normalizedThreadId = threadId.trim();
    if (normalizedThreadId) {
      const thread = this.threadRepository.findThreadById(normalizedThreadId);
      if (thread) {
        this.threadRepository.updateThread(normalizedThreadId, {
          activeModel: trimmed,
          updatedAt: Date.now(),
        });
      }
    }

    this.threadRepository.setGlobalActiveModel(trimmed);
    await this.emitRuntimeStatusChange(normalizedThreadId || undefined);

    return { success: true };
  }

  async setRuntimeBackend(backend: AssistantRuntimeBackend): Promise<{ success: boolean; error?: string }> {
    return this.backendCoordinator.setRuntimeBackend(backend);
  }

  async sendMessage(
    threadId: string,
    text: string,
    attachments: AssistantMessagePartAttachment[] = [],
  ): Promise<SendMessageResult> {
    const trimmedText = text.trim();
    const normalizedAttachments = this.messageSerializer.normalizeAttachments(attachments);
    if (!trimmedText && normalizedAttachments.length === 0) {
      return { success: false, error: 'Message cannot be empty' };
    }

    const thread = this.threadRepository.findThreadById(threadId);
    if (!thread) {
      return { success: false, error: 'Thread not found' };
    }

    const status = await this.getRuntimeStatus(threadId);
    if (!status.modelInstalled) {
      return { success: false, error: 'MODEL_NOT_INSTALLED' };
    }
    if (!status.runtimeBinaryReady) {
      return { success: false, error: status.backend === 'ollama' ? 'OLLAMA_UNAVAILABLE' : 'RUNTIME_BINARY_MISSING' };
    }

    const activeModel = this.resolveActiveModel(thread, status.installedModels);
    if (!activeModel) {
      return { success: false, error: 'MODEL_SELECTION_REQUIRED' };
    }

    const modelRecord = await this.getActiveBackendModelById(activeModel);
    if (!modelRecord) {
      return { success: false, error: 'MODEL_SELECTION_REQUIRED' };
    }

    const ensureRuntime = await this.chatRuntime.ensureStarted(modelRecord);
    if (!ensureRuntime.success) {
      await this.emitRuntimeStatusChange(threadId);
      return { success: false, error: ensureRuntime.error ?? 'RUNTIME_NOT_READY' };
    }

    if (thread.activeModel !== activeModel) {
      this.threadRepository.updateThread(threadId, {
        activeModel,
        updatedAt: Date.now(),
      });
    }
    this.threadRepository.setGlobalActiveModel(activeModel);

    const parts: AssistantMessagePart[] = [];
    if (trimmedText) {
      parts.push({ type: 'text', text: trimmedText });
    }
    if (normalizedAttachments.length > 0) {
      parts.push(...normalizedAttachments);
    }

    this.threadRepository.appendMessage({
      id: uuidv4(),
      threadId,
      role: 'user',
      parts,
      createdAt: Date.now(),
    });
    this.threadRepository.touchThread(threadId);

    if (thread.title === 'New Chat') {
      const inferredTitle = trimmedText || normalizedAttachments[0]?.name || 'New Chat';
      this.threadRepository.updateThread(threadId, {
        title: inferredTitle.slice(0, 60),
      });
    }

    const runId = uuidv4();
    this.runExecutor.startRun({
      runId,
      threadId,
      modelId: activeModel,
    });

    return { success: true, runId };
  }

  async cancelRun(runId: string): Promise<{ success: boolean; error?: string }> {
    return this.runExecutor.cancelRun(runId);
  }

  async approveToolCall(runId: string, toolCallId: string): Promise<{ success: boolean; error?: string }> {
    return this.runExecutor.approveToolCall(runId, toolCallId);
  }

  async rejectToolCall(runId: string, toolCallId: string): Promise<{ success: boolean; error?: string }> {
    return this.runExecutor.rejectToolCall(runId, toolCallId);
  }

  private emitRunEvent(event: AssistantRunEvent): void {
    this.handlers.onRunEvent?.(event);
  }

  private async emitRuntimeStatusChange(threadId?: string): Promise<void> {
    const status = await this.getRuntimeStatus(threadId);
    this.handlers.onRuntimeStatusChanged?.(status);
  }

  private async handleRuntimeStateChanged(): Promise<void> {
    await this.emitRuntimeStatusChange(this.threadRepository.getLastOpenedThreadId() ?? undefined);
  }

  private resolveActiveModel(thread: AssistantThread | null, installedModels: string[]): string | null {
    return resolveAssistantActiveModel({
      thread,
      globalModel: this.threadRepository.getGlobalActiveModel(),
      installedModels,
    });
  }

  private async pruneInvalidThreadModels(): Promise<void> {
    if (this.runtimeSettings.getRuntimeBackend() === 'embedded') {
      this.threadRepository.pruneInvalidThreadModels(
        await this.runtimeBackends.embedded.listModels(),
      );
    }
  }

  private createRuntimeRouter(): ChatRuntime {
    return {
      ensureStarted: (model) => this.getCurrentChatRuntime().ensureStarted(model),
      getRuntimeModelName: () => this.getCurrentChatRuntime().getRuntimeModelName(),
      chatCompletions: (payload, signal, onTextDelta) =>
        this.getCurrentChatRuntime().chatCompletions(payload, signal, onTextDelta),
    };
  }

  private getCurrentChatRuntime(): ChatRuntime {
    return this.getCurrentBackend();
  }

  private getCurrentBackend(): AssistantRuntimeBackendAdapter {
    return this.runtimeBackends[this.runtimeSettings.getRuntimeBackend()];
  }

  private async getActiveBackendModelById(modelId: string): Promise<ReturnType<ModelInstallService['getInstalledModelById']>> {
    return this.getCurrentBackend().getModelById(modelId);
  }
}
