/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { dynamicTool, jsonSchema, stepCountIs, streamText, type ModelMessage, type TextPart, type ImagePart } from 'ai';
import { ollama } from 'ai-sdk-ollama';
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
  AssistantRunEvent,
  AssistantRunLog,
  AssistantRunFinishReason,
  AssistantThread,
  OllamaRuntimeStatus,
  OllamaSetupGuide,
  ToolApprovalRequest,
} from '../../shared/types';
import { ASSISTANT_DEFAULT_MODEL, ASSISTANT_LIMITS, ASSISTANT_MAX_STEPS } from './constants';
import { OllamaGuideService } from './OllamaGuideService';
import { OllamaRuntimeProbe } from './OllamaRuntimeProbe';
import { classifyToolSafety } from './ToolSafetyPolicy';

type ApprovalResolver = (approved: boolean) => void;

interface AssistantEventHandlers {
  onRunEvent?: (event: AssistantRunEvent) => void;
  onToolApprovalRequired?: (request: ToolApprovalRequest) => void;
  onRuntimeStatusChanged?: (status: OllamaRuntimeStatus) => void;
}

interface SendMessageResult {
  success: boolean;
  runId?: string;
  error?: string;
}

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
  private readonly probe = new OllamaRuntimeProbe();
  private readonly guideService = new OllamaGuideService();
  private readonly wsClient = new WebSocketClient({
    wsPort: 3055,
    autoReconnect: true,
    reconnectDelay: 1500,
    defaultTimeout: 20_000,
    clientType: 'mcp',
  });

  private handlers: AssistantEventHandlers = {};
  private activeRuns = new Map<string, AbortController>();
  private pendingApprovals = new Map<string, Map<string, ApprovalResolver>>();
  private runDedupKeys = new Map<string, Set<string>>();
  private runToolCallLogs = new Map<string, AssistantRunLog['toolCalls']>();

  static getInstance(): AssistantRuntimeService {
    if (!AssistantRuntimeService.instance) {
      AssistantRuntimeService.instance = new AssistantRuntimeService();
    }
    return AssistantRuntimeService.instance;
  }

  setEventHandlers(handlers: AssistantEventHandlers): void {
    this.handlers = handlers;
  }

  async getSetupGuide(): Promise<OllamaSetupGuide> {
    return this.guideService.getSetupGuide();
  }

  async listModels(): Promise<string[]> {
    return this.probe.listInstalledModels();
  }

  async getRuntimeStatus(threadId?: string): Promise<OllamaRuntimeStatus> {
    const threadModel = threadId ? this.findThreadById(threadId)?.activeModel ?? null : null;
    const activeModel = threadModel ?? this.getGlobalActiveModel();
    const status = await this.probe.getRuntimeStatus(activeModel);
    return status;
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

    const thread = this.findThreadById(threadId);
    if (!thread) {
      return { success: false, error: 'Thread not found' };
    }

    this.updateThread(threadId, {
      activeModel: trimmed,
      updatedAt: Date.now(),
    });
    this.setGlobalActiveModel(trimmed);
    await this.emitRuntimeStatusChange(threadId);

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
    if (!status.daemonReachable) {
      return { success: false, error: 'OLLAMA_NOT_READY' };
    }

    let activeModel = this.resolveActiveModel(thread, status);
    if (!activeModel) {
      return { success: false, error: 'MODEL_SELECTION_REQUIRED' };
    }

    // Keep default model explicit when available and no model is selected on thread.
    if (!thread.activeModel && status.defaultModelInstalled) {
      await this.setActiveModel(threadId, ASSISTANT_DEFAULT_MODEL);
      activeModel = ASSISTANT_DEFAULT_MODEL;
    }

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
      model: activeModel,
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
    model,
  }: {
    runId: string;
    threadId: string;
    model: string;
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
      const messages = this.toModelMessages(this.getMessagesForThread(threadId));
      const tools = this.buildDynamicTools(runId, threadId, assistantParts);

      const result = streamText({
        model: ollama(model),
        messages,
        tools,
        stopWhen: stepCountIs(ASSISTANT_MAX_STEPS),
        abortSignal: controller.signal,
        onChunk: async ({ chunk }) => {
          if (chunk.type === 'text-delta') {
            assistantText += chunk.text;
            this.emitRunEvent({
              type: 'token',
              runId,
              textDelta: chunk.text,
            });
          }
        },
      });

      const finalText = await result.text;
      if (!assistantText && finalText) {
        assistantText = finalText;
      }

      const steps = await result.steps;
      if (controller.signal.aborted) {
        finishReason = 'cancelled';
      } else if (steps.length >= ASSISTANT_MAX_STEPS) {
        finishReason = 'max-steps';
      } else {
        finishReason = 'completed';
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

  private buildDynamicTools(
    runId: string,
    threadId: string,
    assistantParts: AssistantMessagePart[],
  ): Record<string, ReturnType<typeof dynamicTool>> {
    const toolMap: Record<string, ReturnType<typeof dynamicTool>> = {};

    for (const toolDefinition of allTools) {
      toolMap[toolDefinition.name] = dynamicTool({
        description: toolDefinition.description,
        inputSchema: jsonSchema(toolDefinition.inputSchema as Record<string, unknown>),
        execute: async (input: unknown, options): Promise<unknown> => {
          const toolCallId = String((options as { toolCallId?: string } | undefined)?.toolCallId ?? uuidv4());
          const params = this.normalizeToolArgs(input);
          const safety = classifyToolSafety(toolDefinition.name);
          const dedupeKey = this.buildToolDedupeKey(toolDefinition.name, params);

          this.logRunToolCall(runId, {
            toolCallId,
            toolName: toolDefinition.name,
            args: params,
            safety,
          });
          const inputToolPart = this.upsertToolPart(assistantParts, {
            toolName: toolDefinition.name,
            toolCallId,
            safety,
            state: 'input-available',
            input: params,
          });
          this.emitToolPartEvent(runId, inputToolPart);

          // Dedupe repeated tool calls in the same run.
          const runDedupeSet = this.runDedupKeys.get(runId);
          if (runDedupeSet && runDedupeSet.has(dedupeKey)) {
            const duplicateResult = {
              status: 'duplicate_tool_call_blocked',
              message: 'The same tool call was already attempted in this run.',
              toolName: toolDefinition.name,
            };
            const duplicateToolPart = this.upsertToolPart(assistantParts, {
              toolName: toolDefinition.name,
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

          if (safety === 'write') {
            const approved = await this.requestApproval({
              runId,
              threadId,
              toolCallId,
              toolName: toolDefinition.name,
              args: params,
              safety,
              requestedAt: Date.now(),
            });

            this.updateRunToolCallApproval(runId, toolCallId, approved);

            if (!approved) {
              const deniedResult = {
                status: 'tool_execution_rejected',
                message: 'tool execution rejected',
                toolName: toolDefinition.name,
              };
              const deniedToolPart = this.upsertToolPart(assistantParts, {
                toolName: toolDefinition.name,
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

          const commandResult = await this.executeFigmaTool(toolDefinition.name, params);
          if (commandResult.ok) {
            const successToolPart = this.upsertToolPart(assistantParts, {
              toolName: toolDefinition.name,
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
            toolName: toolDefinition.name,
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
            toolName: toolDefinition.name,
          };
        },
      });
    }

    return toolMap;
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

  private resolveActiveModel(thread: AssistantThread, status: OllamaRuntimeStatus): string | null {
    if (thread.activeModel && status.installedModels.includes(thread.activeModel)) {
      return thread.activeModel;
    }

    const globalModel = this.getGlobalActiveModel();
    if (globalModel && status.installedModels.includes(globalModel)) {
      return globalModel;
    }

    if (status.defaultModelInstalled) {
      return ASSISTANT_DEFAULT_MODEL;
    }

    return null;
  }

  private toModelMessages(messages: AssistantMessage[]): ModelMessage[] {
    const modelMessages: ModelMessage[] = [];

    for (const message of messages) {
      if (message.role === 'user') {
        const userParts: Array<TextPart | ImagePart> = [];

        for (const part of message.parts) {
          if (part.type === 'text') {
            userParts.push({ type: 'text', text: part.text });
            continue;
          }

          if (part.type === 'attachment') {
            const summary = this.formatAttachmentForModelContext(part);
            if (summary) {
              userParts.push({ type: 'text', text: summary });
            }

            if (part.imageBase64 && part.mimeType.toLowerCase().startsWith('image/')) {
              userParts.push({
                type: 'image',
                image: part.imageBase64,
                ...(part.mimeType ? { mediaType: part.mimeType } : {}),
              });
            }
            continue;
          }

          if (this.isStandardToolPart(part)) {
            const toolName = part.type.replace(/^tool-/, '');
            if (part.state === 'output-available') {
              userParts.push({
                type: 'text',
                text: `[Tool Result] ${toolName} ${this.stringifyForModelContext(part.output, 2000)}`,
              });
              continue;
            }
            if (part.state === 'output-error') {
              userParts.push({
                type: 'text',
                text: `[Tool Result] ${toolName} ${part.errorText ?? 'error'}`,
              });
              continue;
            }
            userParts.push({
              type: 'text',
              text: `[Tool Call] ${toolName} ${this.stringifyForModelContext(part.input, 1000)}`,
            });
          }
        }

        if (userParts.length === 0) {
          continue;
        }

        if (userParts.length === 1 && userParts[0]?.type === 'text') {
          modelMessages.push({
            role: 'user',
            content: userParts[0].text,
          });
        } else {
          modelMessages.push({
            role: 'user',
            content: userParts,
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

    return `${text.slice(0, maxChars)}…(truncated)`;
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
}
