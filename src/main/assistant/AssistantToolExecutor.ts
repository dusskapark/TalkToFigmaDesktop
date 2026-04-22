/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { allTools } from '../server/tools';
import { WebSocketClient } from '../server/shared/websocket-client';
import { isChannelNotRequired } from '../../shared/constants';
import type { AssistantMessagePart, AssistantMessagePartTool, AssistantRunLog, ToolApprovalRequest } from '../../shared/types';
import { classifyToolSafety } from './ToolSafetyPolicy';
import type { LlamaToolCall, LlamaToolDefinition } from './AssistantLlamaTypes';
import { AssistantMessageSerializer } from './AssistantMessageSerializer';

interface ExecuteToolCallOptions {
  runId: string;
  threadId: string;
  assistantParts: AssistantMessagePart[];
  toolCall: LlamaToolCall & { id: string };
  runDedupeSet?: Set<string>;
  requestApproval: (request: ToolApprovalRequest) => Promise<boolean>;
  emitToolPartEvent: (runId: string, part: AssistantMessagePartTool) => void;
  logRunToolCall: (runId: string, toolCall: AssistantRunLog['toolCalls'][number]) => void;
  updateRunToolCallApproval: (runId: string, toolCallId: string, approved: boolean) => void;
  updateRunToolCallResult: (runId: string, toolCallId: string, ok: boolean) => void;
}

export class AssistantToolExecutor {
  constructor(
    private readonly wsClient: WebSocketClient,
    private readonly serializer: AssistantMessageSerializer,
  ) {}

  buildLlamaTools(): LlamaToolDefinition[] {
    return allTools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown>,
      },
    }));
  }

  async executeToolCall({
    runId,
    threadId,
    assistantParts,
    toolCall,
    runDedupeSet,
    requestApproval,
    emitToolPartEvent,
    logRunToolCall,
    updateRunToolCallApproval,
    updateRunToolCallResult,
  }: ExecuteToolCallOptions): Promise<unknown> {
    const toolName = toolCall.function?.name?.trim() ?? '';
    if (!toolName) {
      return {
        status: 'tool_execution_error',
        error: 'Tool name is missing',
      };
    }

    const params = this.normalizeToolArgs(this.parseToolArguments(toolCall.function?.arguments));
    const safety = classifyToolSafety(toolName);
    const dedupeKey = this.buildToolDedupeKey(toolName, params);
    const toolCallId = toolCall.id;

    logRunToolCall(runId, {
      toolCallId,
      toolName,
      args: params,
      safety,
    });

    const inputToolPart = this.serializer.upsertToolPart(assistantParts, {
      toolName,
      toolCallId,
      safety,
      state: 'input-available',
      input: params,
    });
    emitToolPartEvent(runId, inputToolPart);

    if (runDedupeSet && runDedupeSet.has(dedupeKey)) {
      const duplicateResult = {
        status: 'duplicate_tool_call_blocked',
        message: 'The same tool call was already attempted in this run.',
        toolName,
      };
      const duplicateToolPart = this.serializer.upsertToolPart(assistantParts, {
        toolName,
        toolCallId,
        safety,
        state: 'output-error',
        input: params,
        output: duplicateResult,
        errorText: duplicateResult.message,
      });
      emitToolPartEvent(runId, duplicateToolPart);
      updateRunToolCallResult(runId, toolCallId, false);
      return duplicateResult;
    }
    runDedupeSet?.add(dedupeKey);

    if (!allTools.some((definition) => definition.name === toolName)) {
      const result = {
        status: 'tool_not_found',
        message: `Unknown tool: ${toolName}`,
        toolName,
      };
      const errorPart = this.serializer.upsertToolPart(assistantParts, {
        toolName,
        toolCallId,
        safety,
        state: 'output-error',
        input: params,
        output: result,
        errorText: result.message,
      });
      emitToolPartEvent(runId, errorPart);
      updateRunToolCallResult(runId, toolCallId, false);
      return result;
    }

    if (safety === 'write') {
      const approved = await requestApproval({
        runId,
        threadId,
        toolCallId,
        toolName,
        args: params,
        safety,
        requestedAt: Date.now(),
      });

      updateRunToolCallApproval(runId, toolCallId, approved);

      if (!approved) {
        const deniedResult = {
          status: 'tool_execution_rejected',
          message: 'tool execution rejected',
          toolName,
        };
        const deniedToolPart = this.serializer.upsertToolPart(assistantParts, {
          toolName,
          toolCallId,
          safety,
          state: 'output-error',
          input: params,
          output: deniedResult,
          errorText: deniedResult.message,
        });
        emitToolPartEvent(runId, deniedToolPart);
        updateRunToolCallResult(runId, toolCallId, false);
        return deniedResult;
      }
    }

    const commandResult = await this.executeFigmaTool(toolName, params);
    if (commandResult.ok) {
      const successToolPart = this.serializer.upsertToolPart(assistantParts, {
        toolName,
        toolCallId,
        safety,
        state: 'output-available',
        input: params,
        ...(commandResult.result !== undefined ? { output: commandResult.result } : {}),
      });
      emitToolPartEvent(runId, successToolPart);
      updateRunToolCallResult(runId, toolCallId, true);
      return commandResult.result;
    }

    const errorToolPart = this.serializer.upsertToolPart(assistantParts, {
      toolName,
      toolCallId,
      safety,
      state: 'output-error',
      input: params,
      errorText: commandResult.error ?? 'Unknown tool execution error',
    });
    emitToolPartEvent(runId, errorToolPart);
    updateRunToolCallResult(runId, toolCallId, false);

    return {
      status: 'tool_execution_error',
      error: commandResult.error,
      toolName,
    };
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

  private parseToolArguments(rawArguments: string | undefined): unknown {
    if (typeof rawArguments === 'string' && rawArguments.trim()) {
      try {
        return JSON.parse(rawArguments);
      } catch {
        return {
          raw: rawArguments,
        };
      }
    }
    return {};
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
}
