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
  AssistantRuntimeStatus,
  AssistantThread,
  ToolApprovalRequest,
} from '../../shared/types';
import { ASSISTANT_DEFAULT_MODEL } from './constants';
import { ModelInstallService } from './ModelInstallService';
import { EmbeddedLlamaRuntimeService } from './EmbeddedLlamaRuntimeService';
import { AssistantRuntimeSettings } from './AssistantRuntimeSettings';
import { AssistantThreadRepository } from './AssistantThreadRepository';
import { AssistantMessageSerializer } from './AssistantMessageSerializer';
import { AssistantToolExecutor } from './AssistantToolExecutor';
import { AssistantRunExecutor, type ChatRuntime } from './AssistantRunExecutor';
import { AiSdkLlamaRuntimeAdapter } from './AiSdkLlamaRuntimeAdapter';

const ASSISTANT_RUNTIME_ADAPTER_ENV = 'TALK_TO_FIGMA_ASSISTANT_RUNTIME';
const AI_SDK_RUNTIME_ADAPTER_VALUE = 'ai-sdk';

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
  private readonly chatRuntime: ChatRuntime;
  private readonly runtimeSettings: AssistantRuntimeSettings;
  private readonly threadRepository: AssistantThreadRepository;
  private readonly messageSerializer: AssistantMessageSerializer;
  private readonly toolExecutor: AssistantToolExecutor;
  private readonly runExecutor: AssistantRunExecutor;

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
    this.chatRuntime = this.createChatRuntime();

    this.toolExecutor = new AssistantToolExecutor(this.wsClient, this.messageSerializer);
    this.runExecutor = new AssistantRunExecutor({
      modelLookup: this.modelInstallService,
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

    this.pruneInvalidThreadModels();
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
    await this.embeddedRuntimeService.stop();
  }

  async listModels(): Promise<string[]> {
    return this.modelInstallService.getInstalledModels().map((model) => model.id);
  }

  async listModelCatalog(): Promise<AssistantModelCatalogItem[]> {
    return this.modelInstallService.getCatalog();
  }

  async downloadModel(modelId: string): Promise<{ success: boolean; error?: string }> {
    const result = await this.modelInstallService.downloadModel(modelId);
    this.pruneInvalidThreadModels();
    await this.emitRuntimeStatusChange(this.threadRepository.getLastOpenedThreadId() ?? undefined);
    return result;
  }

  async cancelModelDownload(): Promise<{ success: boolean; error?: string }> {
    const result = this.modelInstallService.cancelDownload();
    await this.emitRuntimeStatusChange(this.threadRepository.getLastOpenedThreadId() ?? undefined);
    return result;
  }

  async uploadModel(payload: AssistantModelUploadRequest): Promise<{ success: boolean; modelId?: string; error?: string }> {
    const result = await this.modelInstallService.uploadModel(payload);
    this.pruneInvalidThreadModels();
    await this.emitRuntimeStatusChange(this.threadRepository.getLastOpenedThreadId() ?? undefined);
    return result;
  }

  async deleteModel(modelId: string): Promise<{ success: boolean; error?: string }> {
    const result = this.modelInstallService.deleteModel(modelId);
    if (result.success) {
      await this.embeddedRuntimeService.stop();
    }
    this.pruneInvalidThreadModels();
    await this.emitRuntimeStatusChange(this.threadRepository.getLastOpenedThreadId() ?? undefined);
    return result;
  }

  async getRuntimeStatus(threadId?: string): Promise<AssistantRuntimeStatus> {
    const installedModelDetails = this.modelInstallService.getInstalledModels();
    const installedModels = installedModelDetails.map((model) => model.id);
    const recommendedModel = this.modelInstallService.getRecommendedModel();
    const thread = threadId ? this.threadRepository.findThreadById(threadId) : null;
    const activeModel = this.resolveActiveModel(thread, installedModels);
    const activeModelDetail = installedModelDetails.find((model) => model.id === activeModel) ?? null;
    const downloadSnapshot = this.modelInstallService.getDownloadSnapshot();
    const runtimeBinaryStatus = this.embeddedRuntimeService.getRuntimeBinaryStatus();

    const modelInstalled = installedModels.length > 0;
    const health = modelInstalled && runtimeBinaryStatus.ready ? this.embeddedRuntimeService.getHealth() : 'error';

    let error = downloadSnapshot.error ?? this.embeddedRuntimeService.getError();
    if (!modelInstalled && downloadSnapshot.state !== 'downloading' && downloadSnapshot.state !== 'verifying') {
      error ??= 'No model is installed yet. Download the recommended model or upload GGUF files in Settings > Model.';
    } else if (modelInstalled && !runtimeBinaryStatus.ready) {
      error ??= 'Bundled llama-server runtime is missing. Reinstall the app or rebuild the package.';
    }

    return {
      backend: 'embedded',
      health,
      modelInstalled,
      runtimeBinaryReady: runtimeBinaryStatus.ready,
      runtimeBinarySource: runtimeBinaryStatus.source,
      ...(runtimeBinaryStatus.path ? { runtimeBinaryPath: runtimeBinaryStatus.path } : {}),
      activeModel,
      installedModels,
      installedModelDetails,
      defaultModel: ASSISTANT_DEFAULT_MODEL,
      recommendedModel,
      supportsVision: Boolean(activeModelDetail?.supportsVision),
      downloadState: downloadSnapshot.state,
      ...(downloadSnapshot.progress ? { downloadProgress: downloadSnapshot.progress } : {}),
      ...(error ? { error } : {}),
    };
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

    const installed = this.modelInstallService.getInstalledModelById(trimmed);
    if (!installed) {
      return { success: false, error: 'Model is not installed' };
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
      return { success: false, error: 'RUNTIME_BINARY_MISSING' };
    }

    const activeModel = this.resolveActiveModel(thread, status.installedModels);
    if (!activeModel) {
      return { success: false, error: 'MODEL_SELECTION_REQUIRED' };
    }

    const modelRecord = this.modelInstallService.getInstalledModelById(activeModel);
    if (!modelRecord) {
      return { success: false, error: 'MODEL_SELECTION_REQUIRED' };
    }

    const ensureRuntime = await this.embeddedRuntimeService.ensureStarted(modelRecord);
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
    if (thread?.activeModel && installedModels.includes(thread.activeModel)) {
      return thread.activeModel;
    }

    const globalModel = this.threadRepository.getGlobalActiveModel();
    if (globalModel && installedModels.includes(globalModel)) {
      return globalModel;
    }

    if (installedModels.includes(ASSISTANT_DEFAULT_MODEL)) {
      return ASSISTANT_DEFAULT_MODEL;
    }

    return installedModels[0] ?? null;
  }

  private pruneInvalidThreadModels(): void {
    this.threadRepository.pruneInvalidThreadModels(
      this.modelInstallService.getInstalledModels().map((model) => model.id),
    );
  }

  private createChatRuntime(): ChatRuntime {
    if (process.env[ASSISTANT_RUNTIME_ADAPTER_ENV] === AI_SDK_RUNTIME_ADAPTER_VALUE) {
      this.logger.warn('Assistant AI SDK llama runtime adapter enabled for local PoC');
      return new AiSdkLlamaRuntimeAdapter(this.embeddedRuntimeService);
    }

    return this.embeddedRuntimeService;
  }
}
