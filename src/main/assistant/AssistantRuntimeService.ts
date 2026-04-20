/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { v4 as uuidv4 } from 'uuid';
import { allTools } from '../server/tools';
import { WebSocketClient } from '../server/shared/websocket-client';
import { createLogger } from '../utils/logger';
import { getStore } from '../utils/store';
import { isChannelNotRequired, STORE_KEYS } from '../../shared/constants';
import type {
  AssistantMessage,
  AssistantMessagePart,
  AssistantMessagePartAttachment,
  AssistantMessagePartTool,
  AssistantModelCatalogItem,
  AssistantModelUploadRequest,
  AssistantRunEvent,
  AssistantRunLog,
  AssistantRunFinishReason,
  AssistantRuntimeStatus,
  AssistantThread,
  ToolApprovalRequest,
} from '../../shared/types';
import { ASSISTANT_DEFAULT_MODEL, ASSISTANT_LIMITS, ASSISTANT_MAX_STEPS } from './constants';
import { classifyToolSafety } from './ToolSafetyPolicy';
import { ModelInstallService } from './ModelInstallService';
import { EmbeddedLlamaRuntimeService } from './EmbeddedLlamaRuntimeService';

type ApprovalResolver = (approved: boolean) => void;

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

interface LlamaToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface LlamaToolCall {
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

type LlamaContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type LlamaChatMessage =
  | {
      role: 'system' | 'user' | 'assistant';
      content: string | LlamaContentPart[];
      tool_calls?: LlamaToolCall[];
    }
  | {
      role: 'tool';
      tool_call_id: string;
      content: string;
    };

const ASSISTANT_ATTACHMENT_LIMITS = {
  MAX_FILES: 8,
  MAX_TEXT_CHARS: 12_000,
} as const;

const VALID_TOOL_PART_STATES: AssistantMessagePartTool['state'][] = [
  'input-streaming',
  'input-available',
  'output-available',
  'output-error',
];

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

  private handlers: AssistantEventHandlers = {};
  private activeRuns = new Map<string, AbortController>();
  private pendingApprovals = new Map<string, Map<string, ApprovalResolver>>();
  private runDedupKeys = new Map<string, Set<string>>();
  private runToolCallLogs = new Map<string, AssistantRunLog['toolCalls']>();

  private constructor() {
    this.modelInstallService = new ModelInstallService({
      onStateChanged: () => {
        void this.handleRuntimeStateChanged();
      },
    });

    this.embeddedRuntimeService = new EmbeddedLlamaRuntimeService({
      onStateChanged: () => {
        void this.handleRuntimeStateChanged();
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

  setEventHandlers(handlers: AssistantEventHandlers): void {
    this.handlers = handlers;
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
    await this.emitRuntimeStatusChange(this.getLastOpenedThreadId() ?? undefined);
    return result;
  }

  async cancelModelDownload(): Promise<{ success: boolean; error?: string }> {
    const result = this.modelInstallService.cancelDownload();
    await this.emitRuntimeStatusChange(this.getLastOpenedThreadId() ?? undefined);
    return result;
  }

  async uploadModel(payload: AssistantModelUploadRequest): Promise<{ success: boolean; modelId?: string; error?: string }> {
    const result = await this.modelInstallService.uploadModel(payload);
    this.pruneInvalidThreadModels();
    await this.emitRuntimeStatusChange(this.getLastOpenedThreadId() ?? undefined);
    return result;
  }

  async deleteModel(modelId: string): Promise<{ success: boolean; error?: string }> {
    const result = this.modelInstallService.deleteModel(modelId);
    if (result.success) {
      await this.embeddedRuntimeService.stop();
    }
    this.pruneInvalidThreadModels();
    await this.emitRuntimeStatusChange(this.getLastOpenedThreadId() ?? undefined);
    return result;
  }

  async getRuntimeStatus(threadId?: string): Promise<AssistantRuntimeStatus> {
    const installedModelDetails = this.modelInstallService.getInstalledModels();
    const installedModels = installedModelDetails.map((model) => model.id);
    const recommendedModel = this.modelInstallService.getRecommendedModel();
    const thread = threadId ? this.findThreadById(threadId) : null;
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
    const now = Date.now();
    const thread: AssistantThread = {
      id: uuidv4(),
      title: title?.trim() || 'New Chat',
      createdAt: now,
      updatedAt: now,
      activeModel: null,
    };

    const threads = this.getThreads();
    threads.unshift(thread);
    this.saveThreads(threads);
    this.saveMessagesByThread({
      ...this.getMessagesByThread(),
      [thread.id]: [],
    });

    this.setLastOpenedThreadId(thread.id);
    await this.emitRuntimeStatusChange(thread.id);
    return thread;
  }

  async listThreads(): Promise<AssistantThread[]> {
    return this.getThreads().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getThread(threadId: string): Promise<{ thread: AssistantThread | null; messages: AssistantMessage[] }> {
    const thread = this.findThreadById(threadId);
    if (!thread) {
      return { thread: null, messages: [] };
    }
    this.setLastOpenedThreadId(threadId);
    return {
      thread,
      messages: this.getMessagesForThread(threadId),
    };
  }

  async deleteThread(threadId: string): Promise<{ success: boolean; error?: string }> {
    const thread = this.findThreadById(threadId);
    if (!thread) {
      return { success: false, error: 'Thread not found' };
    }

    const nextThreads = this.getThreads().filter((item) => item.id !== threadId);
    this.saveThreads(nextThreads);
    await this.emitRuntimeStatusChange(nextThreads[0]?.id);
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
      const thread = this.findThreadById(normalizedThreadId);
      if (thread) {
        this.updateThread(normalizedThreadId, {
          activeModel: trimmed,
          updatedAt: Date.now(),
        });
      }
    }

    this.setGlobalActiveModel(trimmed);
    await this.emitRuntimeStatusChange(normalizedThreadId || undefined);

    return { success: true };
  }

  async sendMessage(
    threadId: string,
    text: string,
    attachments: AssistantMessagePartAttachment[] = [],
  ): Promise<SendMessageResult> {
    const trimmedText = text.trim();
    const normalizedAttachments = this.normalizeAttachments(attachments);
    if (!trimmedText && normalizedAttachments.length === 0) {
      return { success: false, error: 'Message cannot be empty' };
    }

    const thread = this.findThreadById(threadId);
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
      this.updateThread(threadId, {
        activeModel,
        updatedAt: Date.now(),
      });
    }
    this.setGlobalActiveModel(activeModel);

    const parts: AssistantMessagePart[] = [];
    if (trimmedText) {
      parts.push({ type: 'text', text: trimmedText });
    }
    if (normalizedAttachments.length > 0) {
      parts.push(...normalizedAttachments);
    }

    const message: AssistantMessage = {
      id: uuidv4(),
      threadId,
      role: 'user',
      parts,
      createdAt: Date.now(),
    };
    this.appendMessage(message);
    this.touchThread(threadId);

    if (thread.title === 'New Chat') {
      const inferredTitle = trimmedText || normalizedAttachments[0]?.name || 'New Chat';
      this.updateThread(threadId, {
        title: inferredTitle.slice(0, 60),
      });
    }

    const runId = uuidv4();
    void this.runLoop({
      runId,
      threadId,
      modelId: activeModel,
    });

    return { success: true, runId };
  }

  async cancelRun(runId: string): Promise<{ success: boolean; error?: string }> {
    const controller = this.activeRuns.get(runId);
    if (!controller) {
      return { success: false, error: 'Run not found' };
    }
    controller.abort();
    this.resolvePendingApprovals(runId, false);
    return { success: true };
  }

  async approveToolCall(runId: string, toolCallId: string): Promise<{ success: boolean; error?: string }> {
    return this.resolveApproval(runId, toolCallId, true);
  }

  async rejectToolCall(runId: string, toolCallId: string): Promise<{ success: boolean; error?: string }> {
    return this.resolveApproval(runId, toolCallId, false);
  }

  private async runLoop({
    runId,
    threadId,
    modelId,
  }: {
    runId: string;
    threadId: string;
    modelId: string;
  }): Promise<void> {
    const controller = new AbortController();
    this.activeRuns.set(runId, controller);
    this.pendingApprovals.set(runId, new Map());
    this.runDedupKeys.set(runId, new Set());
    this.runToolCallLogs.set(runId, []);

    this.emitRunEvent({ type: 'run-start', runId, threadId });

    let assistantText = '';
    let finishReason: AssistantRunFinishReason = 'completed';
    let runError: string | undefined;
    const assistantParts: AssistantMessagePart[] = [];

    try {
      const messages = this.toLlamaChatMessages(this.getMessagesForThread(threadId));
      const tools = this.buildLlamaTools();
      let reachedStepLimit = true;

      for (let step = 0; step < ASSISTANT_MAX_STEPS; step += 1) {
        if (controller.signal.aborted) {
          finishReason = 'cancelled';
          reachedStepLimit = false;
          break;
        }

        const installedModel = this.modelInstallService.getInstalledModelById(modelId);
        if (!installedModel) {
          throw new Error('Selected model is not installed anymore');
        }

        const ensureRuntime = await this.embeddedRuntimeService.ensureStarted(installedModel);
        if (!ensureRuntime.success) {
          throw new Error(ensureRuntime.error ?? 'Embedded runtime is not ready');
        }

        const response = await this.embeddedRuntimeService.chatCompletions(
          {
            model: this.embeddedRuntimeService.getRuntimeModelName(),
            messages,
            tools,
            tool_choice: 'auto',
          },
          controller.signal,
        );

        const choice = response.choices?.[0];
        const reply = choice?.message;
        const content = typeof reply?.content === 'string' ? reply.content : '';
        if (content) {
          assistantText += content;
          this.emitRunEvent({
            type: 'token',
            runId,
            textDelta: content,
          });
        }

        const rawToolCalls = Array.isArray(reply?.tool_calls) ? reply.tool_calls : [];
        if (rawToolCalls.length === 0) {
          finishReason = 'completed';
          reachedStepLimit = false;
          break;
        }

        const normalizedToolCalls = rawToolCalls.map((toolCall) => ({
          ...toolCall,
          id: typeof toolCall.id === 'string' && toolCall.id.trim() ? toolCall.id : uuidv4(),
        }));

        messages.push({
          role: 'assistant',
          content: content || '',
          tool_calls: normalizedToolCalls,
        });

        for (const toolCall of normalizedToolCalls) {
          if (controller.signal.aborted) {
            finishReason = 'cancelled';
            reachedStepLimit = false;
            break;
          }

          const toolResult = await this.executeToolCall({
            runId,
            threadId,
            assistantParts,
            toolCall,
          });

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: this.stringifyForModelContext(toolResult, 6000),
          });
        }

        if (finishReason === 'cancelled') {
          break;
        }
      }

      if (finishReason === 'completed' && reachedStepLimit) {
        finishReason = 'max-steps';
      }
    } catch (error) {
      if (controller.signal.aborted) {
        finishReason = 'cancelled';
      } else {
        finishReason = 'error';
        runError = error instanceof Error ? error.message : String(error);
        this.logger.error(`Assistant run failed: ${runError}`);
      }
    } finally {
      const finalText = assistantText || this.getFallbackAssistantText(finishReason, runError);
      const finalParts: AssistantMessagePart[] = [...assistantParts];
      if (finalText) {
        finalParts.push({ type: 'text', text: finalText });
      }

      const messageId = finalParts.length > 0
        ? this.appendMessage({
            id: uuidv4(),
            threadId,
            role: 'assistant',
            parts: finalParts,
            createdAt: Date.now(),
          })
        : undefined;

      this.touchThread(threadId);
      this.persistRunLog(runId, threadId, finishReason);

      this.emitRunEvent({
        type: 'run-end',
        runId,
        finishReason,
        ...(messageId ? { messageId } : {}),
        ...(runError ? { error: runError } : {}),
      });

      this.activeRuns.delete(runId);
      this.resolvePendingApprovals(runId, false);
      this.runDedupKeys.delete(runId);
      this.runToolCallLogs.delete(runId);
    }
  }

  private async executeToolCall({
    runId,
    threadId,
    assistantParts,
    toolCall,
  }: {
    runId: string;
    threadId: string;
    assistantParts: AssistantMessagePart[];
    toolCall: LlamaToolCall & { id: string };
  }): Promise<unknown> {
    const toolName = toolCall.function?.name?.trim() ?? '';
    if (!toolName) {
      return {
        status: 'tool_execution_error',
        error: 'Tool name is missing',
      };
    }

    let parsedInput: unknown = {};
    const rawArguments = toolCall.function?.arguments;
    if (typeof rawArguments === 'string' && rawArguments.trim()) {
      try {
        parsedInput = JSON.parse(rawArguments);
      } catch {
        parsedInput = {
          raw: rawArguments,
        };
      }
    }

    const params = this.normalizeToolArgs(parsedInput);
    const safety = classifyToolSafety(toolName);
    const dedupeKey = this.buildToolDedupeKey(toolName, params);
    const toolCallId = toolCall.id;

    this.logRunToolCall(runId, {
      toolCallId,
      toolName,
      args: params,
      safety,
    });

    const inputToolPart = this.upsertToolPart(assistantParts, {
      toolName,
      toolCallId,
      safety,
      state: 'input-available',
      input: params,
    });
    this.emitToolPartEvent(runId, inputToolPart);

    const runDedupeSet = this.runDedupKeys.get(runId);
    if (runDedupeSet && runDedupeSet.has(dedupeKey)) {
      const duplicateResult = {
        status: 'duplicate_tool_call_blocked',
        message: 'The same tool call was already attempted in this run.',
        toolName,
      };
      const duplicateToolPart = this.upsertToolPart(assistantParts, {
        toolName,
        toolCallId,
        safety,
        state: 'output-error',
        input: params,
        output: duplicateResult,
        errorText: duplicateResult.message,
      });
      this.emitToolPartEvent(runId, duplicateToolPart);
      this.updateRunToolCallResult(runId, toolCallId, false);
      return duplicateResult;
    }
    runDedupeSet?.add(dedupeKey);

    if (!allTools.some((definition) => definition.name === toolName)) {
      const result = {
        status: 'tool_not_found',
        message: `Unknown tool: ${toolName}`,
        toolName,
      };
      const errorPart = this.upsertToolPart(assistantParts, {
        toolName,
        toolCallId,
        safety,
        state: 'output-error',
        input: params,
        output: result,
        errorText: result.message,
      });
      this.emitToolPartEvent(runId, errorPart);
      this.updateRunToolCallResult(runId, toolCallId, false);
      return result;
    }

    if (safety === 'write') {
      const approved = await this.requestApproval({
        runId,
        threadId,
        toolCallId,
        toolName,
        args: params,
        safety,
        requestedAt: Date.now(),
      });

      this.updateRunToolCallApproval(runId, toolCallId, approved);

      if (!approved) {
        const deniedResult = {
          status: 'tool_execution_rejected',
          message: 'tool execution rejected',
          toolName,
        };
        const deniedToolPart = this.upsertToolPart(assistantParts, {
          toolName,
          toolCallId,
          safety,
          state: 'output-error',
          input: params,
          output: deniedResult,
          errorText: deniedResult.message,
        });
        this.emitToolPartEvent(runId, deniedToolPart);
        this.updateRunToolCallResult(runId, toolCallId, false);
        return deniedResult;
      }
    }

    const commandResult = await this.executeFigmaTool(toolName, params);
    if (commandResult.ok) {
      const successToolPart = this.upsertToolPart(assistantParts, {
        toolName,
        toolCallId,
        safety,
        state: 'output-available',
        input: params,
        ...(commandResult.result !== undefined ? { output: commandResult.result } : {}),
      });
      this.emitToolPartEvent(runId, successToolPart);
      this.updateRunToolCallResult(runId, toolCallId, true);
      return commandResult.result;
    }

    const errorToolPart = this.upsertToolPart(assistantParts, {
      toolName,
      toolCallId,
      safety,
      state: 'output-error',
      input: params,
      errorText: commandResult.error ?? 'Unknown tool execution error',
    });
    this.emitToolPartEvent(runId, errorToolPart);
    this.updateRunToolCallResult(runId, toolCallId, false);

    return {
      status: 'tool_execution_error',
      error: commandResult.error,
      toolName,
    };
  }

  private buildLlamaTools(): LlamaToolDefinition[] {
    return allTools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown>,
      },
    }));
  }

  private async executeFigmaTool(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    try {
      if (toolName === 'join_channel') {
        const channel = typeof params.channel === 'string' ? params.channel.trim() : '';
        if (!channel) {
          return {
            ok: false,
            error: 'Channel name is required',
          };
        }

        await this.wsClient.joinChannel(channel);
        return {
          ok: true,
          result: {
            status: 'joined',
            channel,
            message: `Successfully joined channel: ${channel}`,
          },
        };
      }

      if (!isChannelNotRequired(toolName)) {
        await this.ensureAssistantConnection();

        const currentChannel = this.wsClient.getCurrentChannel();
        if (!currentChannel) {
          return {
            ok: true,
            result: {
              status: 'channel_required',
              title: 'No channel joined',
              message: 'Call join_channel first with the target Figma channel, then retry.',
              nextActions: [
                'Call join_channel with your target channel ID',
                `Retry ${toolName}`,
              ],
            },
          };
        }

        const diagnostics = await this.wsClient.sendCommand('connection_diagnostics', {});
        const figmaConnected = Boolean((diagnostics as { figmaPlugin?: { connected?: boolean } } | null)?.figmaPlugin?.connected);

        if (!figmaConnected) {
          return {
            ok: true,
            result: {
              status: 'figma_disconnected',
              title: 'Figma plugin is not connected',
              message: 'Please start the server and open TalkToFigma plugin in Figma.',
              nextActions: [
                'Start TalkToFigma server',
                'Open TalkToFigma plugin in Figma',
                'Retry your request',
              ],
            },
          };
        }
      }

      const result = await this.wsClient.sendCommand(toolName, params);
      return { ok: true, result };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async ensureAssistantConnection(): Promise<void> {
    if (!this.wsClient.isWebSocketConnected()) {
      await this.wsClient.connect();
    }
  }

  private async requestApproval(request: ToolApprovalRequest): Promise<boolean> {
    if (!this.pendingApprovals.has(request.runId)) {
      this.pendingApprovals.set(request.runId, new Map());
    }

    this.handlers.onToolApprovalRequired?.(request);

    return await new Promise<boolean>((resolve) => {
      const runApprovals = this.pendingApprovals.get(request.runId);
      if (!runApprovals) {
        resolve(false);
        return;
      }
      runApprovals.set(request.toolCallId, resolve);
    });
  }

  private resolveApproval(runId: string, toolCallId: string, approved: boolean): { success: boolean; error?: string } {
    const runApprovals = this.pendingApprovals.get(runId);
    if (!runApprovals) {
      return { success: false, error: 'Run approval queue not found' };
    }

    const resolver = runApprovals.get(toolCallId);
    if (!resolver) {
      return { success: false, error: 'Tool call approval request not found' };
    }

    runApprovals.delete(toolCallId);
    resolver(approved);
    return { success: true };
  }

  private resolvePendingApprovals(runId: string, approved: boolean): void {
    const runApprovals = this.pendingApprovals.get(runId);
    if (runApprovals) {
      for (const resolver of runApprovals.values()) {
        resolver(approved);
      }
    }
    this.pendingApprovals.delete(runId);
  }

  private emitRunEvent(event: AssistantRunEvent): void {
    this.handlers.onRunEvent?.(event);
  }

  private emitToolPartEvent(runId: string, part: AssistantMessagePartTool): void {
    if (!part.toolCallId) {
      return;
    }

    this.emitRunEvent({
      type: 'tool-part',
      runId,
      part: {
        ...part,
        toolCallId: part.toolCallId,
      },
    });
  }

  private async emitRuntimeStatusChange(threadId?: string): Promise<void> {
    const status = await this.getRuntimeStatus(threadId);
    this.handlers.onRuntimeStatusChanged?.(status);
  }

  private async handleRuntimeStateChanged(): Promise<void> {
    await this.emitRuntimeStatusChange(this.getLastOpenedThreadId() ?? undefined);
  }

  private resolveActiveModel(thread: AssistantThread | null, installedModels: string[]): string | null {
    if (thread?.activeModel && installedModels.includes(thread.activeModel)) {
      return thread.activeModel;
    }

    const globalModel = this.getGlobalActiveModel();
    if (globalModel && installedModels.includes(globalModel)) {
      return globalModel;
    }

    if (installedModels.includes(ASSISTANT_DEFAULT_MODEL)) {
      return ASSISTANT_DEFAULT_MODEL;
    }

    return installedModels[0] ?? null;
  }

  private toLlamaChatMessages(messages: AssistantMessage[]): LlamaChatMessage[] {
    const modelMessages: LlamaChatMessage[] = [];

    for (const message of messages) {
      if (message.role === 'user') {
        const textParts: string[] = [];
        const richParts: LlamaContentPart[] = [];
        let hasImagePart = false;

        for (const part of message.parts) {
          if (part.type === 'text') {
            textParts.push(part.text);
            richParts.push({ type: 'text', text: part.text });
            continue;
          }

          if (part.type === 'attachment') {
            const summary = this.formatAttachmentForModelContext(part);
            if (summary) {
              textParts.push(summary);
              richParts.push({ type: 'text', text: summary });
            }

            if (part.imageBase64 && part.mimeType.toLowerCase().startsWith('image/')) {
              hasImagePart = true;
              richParts.push({
                type: 'image_url',
                image_url: {
                  url: `data:${part.mimeType};base64,${part.imageBase64}`,
                },
              });
            }
            continue;
          }

          if (this.isStandardToolPart(part)) {
            const toolName = part.type.replace(/^tool-/, '');
            if (part.state === 'output-available') {
              textParts.push(`[Tool Result] ${toolName} ${this.stringifyForModelContext(part.output, 2000)}`);
              continue;
            }
            if (part.state === 'output-error') {
              textParts.push(`[Tool Result] ${toolName} ${part.errorText ?? 'error'}`);
              continue;
            }
            textParts.push(`[Tool Call] ${toolName} ${this.stringifyForModelContext(part.input, 1000)}`);
          }
        }

        if (richParts.length === 0) {
          continue;
        }

        if (!hasImagePart && richParts.length === 1 && richParts[0]?.type === 'text') {
          modelMessages.push({
            role: 'user',
            content: richParts[0].text,
          });
        } else {
          modelMessages.push({
            role: 'user',
            content: richParts,
          });
        }
        continue;
      }

      const content = message.parts
        .map((part) => {
          if (part.type === 'text') {
            return part.text;
          }
          if (part.type === 'attachment') {
            return this.formatAttachmentForModelContext(part);
          }
          if (this.isStandardToolPart(part)) {
            const toolName = part.type.replace(/^tool-/, '');
            if (part.state === 'output-available') {
              return `[Tool Result] ${toolName} ${this.stringifyForModelContext(part.output, 2000)}`;
            }
            if (part.state === 'output-error') {
              return `[Tool Result] ${toolName} ${part.errorText ?? 'error'}`;
            }
            return `[Tool Call] ${toolName} ${this.stringifyForModelContext(part.input, 1000)}`;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');

      if (!content.trim()) {
        continue;
      }

      if (message.role === 'assistant') {
        modelMessages.push({ role: 'assistant', content });
      } else {
        modelMessages.push({ role: 'system', content });
      }
    }

    return modelMessages;
  }

  private normalizeAttachments(attachments: AssistantMessagePartAttachment[]): AssistantMessagePartAttachment[] {
    if (!Array.isArray(attachments)) {
      return [];
    }

    const normalized: AssistantMessagePartAttachment[] = [];

    for (const attachment of attachments.slice(0, ASSISTANT_ATTACHMENT_LIMITS.MAX_FILES)) {
      if (!attachment || attachment.type !== 'attachment') {
        continue;
      }

      const name = typeof attachment.name === 'string' ? attachment.name.trim() : '';
      if (!name) {
        continue;
      }

      const mimeTypeRaw = typeof attachment.mimeType === 'string' ? attachment.mimeType.trim() : '';
      const mimeType = mimeTypeRaw || 'application/octet-stream';
      const sizeBytes = Number.isFinite(attachment.sizeBytes)
        ? Math.max(0, Math.floor(attachment.sizeBytes))
        : 0;
      const rawTextContent = typeof attachment.textContent === 'string' ? attachment.textContent : '';
      const hasTextContent = rawTextContent.trim().length > 0;
      const textContent = hasTextContent
        ? rawTextContent.slice(0, ASSISTANT_ATTACHMENT_LIMITS.MAX_TEXT_CHARS)
        : undefined;
      const rawImageBase64 = typeof attachment.imageBase64 === 'string' ? attachment.imageBase64.trim() : '';
      const imageBase64 = mimeType.startsWith('image/') && rawImageBase64 ? rawImageBase64 : undefined;
      const truncated =
        Boolean(attachment.truncated) || rawTextContent.length > ASSISTANT_ATTACHMENT_LIMITS.MAX_TEXT_CHARS;

      normalized.push({
        type: 'attachment',
        id: typeof attachment.id === 'string' && attachment.id.trim() ? attachment.id.trim() : uuidv4(),
        name,
        mimeType,
        sizeBytes,
        ...(imageBase64 ? { imageBase64 } : {}),
        ...(textContent ? { textContent } : {}),
        ...(truncated ? { truncated: true } : {}),
      });
    }

    return normalized;
  }

  private formatAttachmentForModelContext(part: AssistantMessagePartAttachment): string {
    const sizeLabel = part.sizeBytes > 0 ? `${part.sizeBytes} bytes` : 'size unknown';
    const prefix = part.imageBase64 && part.mimeType.toLowerCase().startsWith('image/')
      ? '[Image Attachment]'
      : '[Attachment]';
    const summary = `${prefix} ${part.name} (${part.mimeType}, ${sizeLabel})`;

    if (!part.textContent) {
      return summary;
    }

    return `${summary}\n${part.textContent}${part.truncated ? '\n[Attachment content truncated]' : ''}`;
  }

  private stringifyForModelContext(value: unknown, maxChars: number): string {
    let text: string;
    if (typeof value === 'string') {
      text = value;
    } else {
      try {
        text = JSON.stringify(value);
      } catch {
        text = String(value);
      }
    }

    if (text.length <= maxChars) {
      return text;
    }

    return `${text.slice(0, maxChars)}...(truncated)`;
  }

  private toToolPartType(toolName: string): `tool-${string}` {
    return `tool-${toolName}` as `tool-${string}`;
  }

  private isToolPartState(value: unknown): value is AssistantMessagePartTool['state'] {
    return typeof value === 'string' && VALID_TOOL_PART_STATES.includes(value as AssistantMessagePartTool['state']);
  }

  private isStandardToolPart(part: AssistantMessagePart): part is AssistantMessagePartTool {
    const type = (part as { type?: unknown }).type;
    if (typeof type !== 'string') return false;
    if (type === 'text' || type === 'attachment' || type === 'tool-call' || type === 'tool-result') return false;
    return this.isToolPartState((part as { state?: unknown }).state);
  }

  private upsertToolPart(
    assistantParts: AssistantMessagePart[],
    part: {
      toolName: string;
      toolCallId: string;
      safety?: 'read' | 'write';
      state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error';
      input?: Record<string, unknown>;
      output?: unknown;
      errorText?: string;
    },
  ): AssistantMessagePartTool {
    const existing = assistantParts.find((current): current is AssistantMessagePartTool =>
      this.isStandardToolPart(current) && current.toolCallId === part.toolCallId,
    );

    if (existing) {
      existing.state = part.state;
      existing.safety = part.safety;
      existing.input = part.input;
      existing.output = part.output;
      existing.errorText = part.errorText;
      return existing;
    }

    const nextPart: AssistantMessagePartTool = {
      type: this.toToolPartType(part.toolName),
      state: part.state,
      toolCallId: part.toolCallId,
      ...(part.safety ? { safety: part.safety } : {}),
      ...(part.input ? { input: part.input } : {}),
      ...(part.output !== undefined ? { output: part.output } : {}),
      ...(part.errorText ? { errorText: part.errorText } : {}),
    };
    assistantParts.push(nextPart);
    return nextPart;
  }

  private normalizeToolArgs(input: unknown): Record<string, unknown> {
    if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
      return input as Record<string, unknown>;
    }
    return {};
  }

  private buildToolDedupeKey(toolName: string, args: Record<string, unknown>): string {
    return `${toolName}:${this.stableStringify(args)}`;
  }

  private stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${this.stableStringify(val)}`);
    return `{${entries.join(',')}}`;
  }

  private getFallbackAssistantText(finishReason: AssistantRunFinishReason, error?: string): string {
    if (finishReason === 'cancelled') {
      return 'Response generation was cancelled.';
    }
    if (finishReason === 'max-steps') {
      return 'Reached the maximum number of tool steps for this request.';
    }
    if (finishReason === 'error') {
      return `The assistant run failed${error ? `: ${error}` : '.'}`;
    }
    return '';
  }

  private logRunToolCall(runId: string, toolCall: AssistantRunLog['toolCalls'][number]): void {
    const current = this.runToolCallLogs.get(runId) ?? [];
    current.push(toolCall);
    this.runToolCallLogs.set(runId, current);
  }

  private updateRunToolCallApproval(runId: string, toolCallId: string, approved: boolean): void {
    const calls = this.runToolCallLogs.get(runId);
    if (!calls) return;
    const target = calls.find((call) => call.toolCallId === toolCallId);
    if (target) {
      target.approved = approved;
    }
  }

  private updateRunToolCallResult(runId: string, toolCallId: string, ok: boolean): void {
    const calls = this.runToolCallLogs.get(runId);
    if (!calls) return;
    const target = calls.find((call) => call.toolCallId === toolCallId);
    if (target) {
      target.ok = ok;
    }
  }

  private persistRunLog(runId: string, threadId: string, finishReason: AssistantRunFinishReason): void {
    const runLogs = this.getRunLogs();
    const toolCalls = this.runToolCallLogs.get(runId) ?? [];
    runLogs.unshift({
      runId,
      threadId,
      finishReason,
      toolCalls,
      createdAt: Date.now(),
    });
    this.saveRunLogs(runLogs);
  }

  private appendMessage(message: AssistantMessage): string {
    const messagesByThread = this.getMessagesByThread();
    const threadMessages = messagesByThread[message.threadId] ?? [];
    threadMessages.push(message);
    messagesByThread[message.threadId] = threadMessages.slice(-ASSISTANT_LIMITS.MESSAGES_PER_THREAD);
    this.saveMessagesByThread(messagesByThread);
    return message.id;
  }

  private touchThread(threadId: string): void {
    this.updateThread(threadId, { updatedAt: Date.now() });
  }

  private updateThread(threadId: string, patch: Partial<AssistantThread>): void {
    const threads = this.getThreads();
    const index = threads.findIndex((thread) => thread.id === threadId);
    if (index < 0) return;
    threads[index] = {
      ...threads[index],
      ...patch,
    };
    this.saveThreads(threads);
  }

  private findThreadById(threadId: string): AssistantThread | null {
    return this.getThreads().find((thread) => thread.id === threadId) ?? null;
  }

  private getMessagesForThread(threadId: string): AssistantMessage[] {
    const messages = this.getMessagesByThread()[threadId] ?? [];
    return messages.map((message) => ({
      ...message,
      parts: [...message.parts],
    }));
  }

  private getStoreValue<T>(key: string, fallback: T): T {
    const store = getStore();
    const value = store.get(key);
    return value === undefined ? fallback : value as T;
  }

  private getThreads(): AssistantThread[] {
    return this.getStoreValue<AssistantThread[]>(STORE_KEYS.ASSISTANT_THREADS, []);
  }

  private saveThreads(threads: AssistantThread[]): void {
    const deduped = Array.from(new Map(threads.map((thread) => [thread.id, thread])).values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, ASSISTANT_LIMITS.THREADS);
    const activeThreadIds = new Set(deduped.map((thread) => thread.id));
    const store = getStore();
    store.set(STORE_KEYS.ASSISTANT_THREADS, deduped);

    const lastOpenedThreadId = this.getStoreValue<string | null>(STORE_KEYS.ASSISTANT_LAST_OPENED_THREAD_ID, null);
    if (lastOpenedThreadId && !activeThreadIds.has(lastOpenedThreadId)) {
      store.set(STORE_KEYS.ASSISTANT_LAST_OPENED_THREAD_ID, deduped[0]?.id ?? null);
    }

    const messagesByThread = this.getMessagesByThread();
    const prunedMessagesByThread: Record<string, AssistantMessage[]> = {};
    for (const thread of deduped) {
      const messages = messagesByThread[thread.id];
      if (messages) {
        prunedMessagesByThread[thread.id] = messages;
      }
    }
    this.saveMessagesByThread(prunedMessagesByThread);
  }

  private getMessagesByThread(): Record<string, AssistantMessage[]> {
    return this.getStoreValue<Record<string, AssistantMessage[]>>(STORE_KEYS.ASSISTANT_MESSAGES, {});
  }

  private saveMessagesByThread(messagesByThread: Record<string, AssistantMessage[]>): void {
    const activeThreadIds = new Set(this.getThreads().map((thread) => thread.id));
    const trimmed: Record<string, AssistantMessage[]> = {};
    for (const [threadId, messages] of Object.entries(messagesByThread)) {
      if (!activeThreadIds.has(threadId)) {
        continue;
      }
      trimmed[threadId] = messages.slice(-ASSISTANT_LIMITS.MESSAGES_PER_THREAD);
    }
    const store = getStore();
    store.set(STORE_KEYS.ASSISTANT_MESSAGES, trimmed);
  }

  private getRunLogs(): AssistantRunLog[] {
    return this.getStoreValue<AssistantRunLog[]>(STORE_KEYS.ASSISTANT_RUN_LOGS, []);
  }

  private saveRunLogs(runLogs: AssistantRunLog[]): void {
    const store = getStore();
    store.set(STORE_KEYS.ASSISTANT_RUN_LOGS, runLogs.slice(0, ASSISTANT_LIMITS.RUN_LOGS));
  }

  private getGlobalActiveModel(): string | null {
    return this.getStoreValue<string | null>(STORE_KEYS.ASSISTANT_ACTIVE_MODEL, null);
  }

  private setGlobalActiveModel(model: string | null): void {
    const store = getStore();
    store.set(STORE_KEYS.ASSISTANT_ACTIVE_MODEL, model);
  }

  private setLastOpenedThreadId(threadId: string): void {
    const store = getStore();
    store.set(STORE_KEYS.ASSISTANT_LAST_OPENED_THREAD_ID, threadId);
  }

  private getLastOpenedThreadId(): string | null {
    const value = this.getStoreValue<string | null>(STORE_KEYS.ASSISTANT_LAST_OPENED_THREAD_ID, null);
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
  }

  private pruneInvalidThreadModels(): void {
    const installedIds = new Set(this.modelInstallService.getInstalledModels().map((model) => model.id));
    const threads = this.getThreads();
    let changed = false;

    const patched = threads.map((thread) => {
      if (thread.activeModel && !installedIds.has(thread.activeModel)) {
        changed = true;
        return {
          ...thread,
          activeModel: null,
        };
      }
      return thread;
    });

    if (changed) {
      this.saveThreads(patched);
    }

    const globalModel = this.getGlobalActiveModel();
    if (globalModel && !installedIds.has(globalModel)) {
      this.setGlobalActiveModel(null);
    }
  }
}
