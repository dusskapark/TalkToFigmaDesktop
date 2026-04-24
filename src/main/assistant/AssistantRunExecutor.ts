/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  AssistantInstalledModel,
  AssistantMessagePart,
  AssistantMessagePartTool,
  AssistantRunEvent,
  AssistantRunFinishReason,
  AssistantRunLog,
  ToolApprovalRequest,
} from '../../shared/types';
import { ASSISTANT_MAX_STEPS } from './constants';
import { ExceedContextSizeError } from './AssistantErrors';
import { AssistantThreadRepository } from './AssistantThreadRepository';
import { AssistantMessageSerializer } from './AssistantMessageSerializer';
import { AssistantToolExecutor } from './AssistantToolExecutor';
import { AssistantRuntimeSettings } from './AssistantRuntimeSettings';
import type { LlamaChatCompletionResponse, LlamaChatMessage, LlamaToolCall } from './AssistantLlamaTypes';

type ApprovalResolver = (approved: boolean) => void;

interface ModelLookup {
  getInstalledModelById(modelId: string): Promise<AssistantInstalledModel | null | undefined> | AssistantInstalledModel | null | undefined;
}

export interface ChatRuntime {
  ensureStarted(model: AssistantInstalledModel): Promise<{ success: boolean; error?: string }>;
  getRuntimeModelName(): string;
  chatCompletions(
    payload: {
      model: string;
      messages: LlamaChatMessage[];
      tools?: unknown[];
      tool_choice?: 'auto' | 'none';
    },
    signal?: AbortSignal,
    onTextDelta?: (textDelta: string) => void,
  ): Promise<LlamaChatCompletionResponse>;
}

interface AssistantRunExecutorOptions {
  modelLookup: ModelLookup;
  runtime: ChatRuntime;
  repository: AssistantThreadRepository;
  serializer: AssistantMessageSerializer;
  toolExecutor: AssistantToolExecutor;
  settings: AssistantRuntimeSettings;
  emitRunEvent: (event: AssistantRunEvent) => void;
  requestToolApproval: (request: ToolApprovalRequest) => void;
  onContextLengthIncreased?: (promptTokens: number, currentContext: number, nextContext: number) => Promise<void> | void;
  logger?: {
    warn: (message: string) => void;
    error: (message: string) => void;
  };
}

export class AssistantRunExecutor {
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly pendingApprovals = new Map<string, Map<string, ApprovalResolver>>();
  private readonly runDedupKeys = new Map<string, Set<string>>();
  private readonly runToolCallLogs = new Map<string, AssistantRunLog['toolCalls']>();

  constructor(private readonly options: AssistantRunExecutorOptions) {}

  startRun(params: { runId: string; threadId: string; modelId: string }): void {
    void this.run(params);
  }

  async run({
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
      const messages = this.options.serializer.toLlamaChatMessages(this.options.repository.getMessagesForThread(threadId));
      let reachedStepLimit = true;

      for (let step = 0; step < ASSISTANT_MAX_STEPS; step += 1) {
        if (controller.signal.aborted) {
          finishReason = 'cancelled';
          reachedStepLimit = false;
          break;
        }

        const installedModel = await this.options.modelLookup.getInstalledModelById(modelId);
        if (!installedModel) {
          throw new Error('Selected model is not installed anymore');
        }

        const ensureRuntime = await this.options.runtime.ensureStarted(installedModel);
        if (!ensureRuntime.success) {
          throw new Error(ensureRuntime.error ?? 'Embedded runtime is not ready');
        }

        const response = await this.requestChatCompletionWithContextRetry({
          controller,
          installedModel,
          messages,
          runId,
          onTextDelta: (textDelta) => {
            assistantText += textDelta;
          },
        });

        assistantText += response.missingStreamedContent;

        const rawToolCalls = Array.isArray(response.reply?.tool_calls) ? response.reply.tool_calls : [];
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
          content: response.content || '',
          tool_calls: normalizedToolCalls,
        });

        for (const toolCall of normalizedToolCalls) {
          if (controller.signal.aborted) {
            finishReason = 'cancelled';
            reachedStepLimit = false;
            break;
          }

          const toolResult = await this.options.toolExecutor.executeToolCall({
            runId,
            threadId,
            assistantParts,
            toolCall: toolCall as LlamaToolCall & { id: string },
            runDedupeSet: this.runDedupKeys.get(runId),
            requestApproval: (request) => this.requestApproval(request),
            emitToolPartEvent: (eventRunId, part) => this.emitToolPartEvent(eventRunId, part),
            logRunToolCall: (eventRunId, toolLog) => this.logRunToolCall(eventRunId, toolLog),
            updateRunToolCallApproval: (eventRunId, toolCallId, approved) =>
              this.updateRunToolCallApproval(eventRunId, toolCallId, approved),
            updateRunToolCallResult: (eventRunId, toolCallId, ok) =>
              this.updateRunToolCallResult(eventRunId, toolCallId, ok),
          });

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: this.options.serializer.stringifyForModelContext(toolResult, this.options.settings.getCurrentToolResultLimit()),
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
        this.options.logger?.error(`Assistant run failed: ${runError}`);
      }
    } finally {
      const finalText = assistantText || this.getFallbackAssistantText(finishReason, runError);
      const finalParts: AssistantMessagePart[] = [...assistantParts];
      if (finalText) {
        finalParts.push({ type: 'text', text: finalText });
      }

      const messageId = finalParts.length > 0
        ? this.options.repository.appendMessage({
            id: uuidv4(),
            threadId,
            role: 'assistant',
            parts: finalParts,
            createdAt: Date.now(),
          })
        : undefined;

      this.options.repository.touchThread(threadId);
      this.options.repository.persistRunLog(runId, threadId, finishReason, this.runToolCallLogs.get(runId) ?? []);

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

  cancelRun(runId: string): { success: boolean; error?: string } {
    const controller = this.activeRuns.get(runId);
    if (!controller) {
      return { success: false, error: 'Run not found' };
    }
    controller.abort();
    this.resolvePendingApprovals(runId, false);
    return { success: true };
  }

  approveToolCall(runId: string, toolCallId: string): { success: boolean; error?: string } {
    return this.resolveApproval(runId, toolCallId, true);
  }

  rejectToolCall(runId: string, toolCallId: string): { success: boolean; error?: string } {
    return this.resolveApproval(runId, toolCallId, false);
  }

  shutdown(): void {
    for (const controller of this.activeRuns.values()) {
      controller.abort();
    }

    for (const runId of Array.from(this.pendingApprovals.keys())) {
      this.resolvePendingApprovals(runId, false);
    }

    this.activeRuns.clear();
    this.pendingApprovals.clear();
    this.runDedupKeys.clear();
    this.runToolCallLogs.clear();
  }

  private async requestChatCompletionWithContextRetry({
    controller,
    installedModel,
    messages,
    runId,
    onTextDelta,
  }: {
    controller: AbortController;
    installedModel: AssistantInstalledModel;
    messages: LlamaChatMessage[];
    runId: string;
    onTextDelta: (textDelta: string) => void;
  }): Promise<{
    reply: NonNullable<NonNullable<LlamaChatCompletionResponse['choices']>[number]['message']> | undefined;
    content: string;
    missingStreamedContent: string;
  }> {
    let receivedStepText = false;
    let response: LlamaChatCompletionResponse | undefined;
    const attemptedContextLengths = new Set<number>();

    for (;;) {
      try {
        response = await this.options.runtime.chatCompletions(
          {
            model: this.options.runtime.getRuntimeModelName(),
            messages,
            tools: this.options.toolExecutor.buildLlamaTools(),
            tool_choice: 'auto',
          },
          controller.signal,
          (textDelta) => {
            receivedStepText = true;
            onTextDelta(textDelta);
            this.emitRunEvent({
              type: 'token',
              runId,
              textDelta,
            });
          },
        );
        break;
      } catch (error) {
        if (!(error instanceof ExceedContextSizeError)) {
          throw error;
        }

        const nextContextLength = this.options.settings.increaseContextLengthForPrompt(
          error.promptTokens,
          error.currentContext,
        );

        if (!nextContextLength) {
          throw error;
        }

        if (attemptedContextLengths.has(nextContextLength)) {
          throw new Error(
            `Assistant runtime could not restart with a larger context window (${nextContextLength}).`,
          );
        }
        attemptedContextLengths.add(nextContextLength);

        this.options.logger?.warn(
          `Retrying assistant step with larger context window (${error.currentContext} -> ${nextContextLength})`,
        );
        await this.options.onContextLengthIncreased?.(error.promptTokens, error.currentContext, nextContextLength);

        const restartedRuntime = await this.options.runtime.ensureStarted(installedModel);
        if (!restartedRuntime.success) {
          throw new Error(restartedRuntime.error ?? 'Embedded runtime is not ready after resizing context window');
        }
      }
    }

    const choice = response?.choices?.[0];
    const reply = choice?.message;
    const content = typeof reply?.content === 'string' ? reply.content : '';
    return {
      reply,
      content,
      missingStreamedContent: content && !receivedStepText ? content : '',
    };
  }

  private async requestApproval(request: ToolApprovalRequest): Promise<boolean> {
    if (!this.pendingApprovals.has(request.runId)) {
      this.pendingApprovals.set(request.runId, new Map());
    }

    this.options.requestToolApproval(request);

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
    this.options.emitRunEvent(event);
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
}
