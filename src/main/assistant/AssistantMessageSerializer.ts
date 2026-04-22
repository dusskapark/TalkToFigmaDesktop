/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  AssistantMessage,
  AssistantMessagePart,
  AssistantMessagePartAttachment,
  AssistantMessagePartTool,
} from '../../shared/types';
import type { LlamaChatMessage, LlamaContentPart } from './AssistantLlamaTypes';

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

export class AssistantMessageSerializer {
  constructor(private readonly getHistoryToolResultLimit: () => number) {}

  toLlamaChatMessages(messages: AssistantMessage[]): LlamaChatMessage[] {
    const modelMessages: LlamaChatMessage[] = [];

    for (const message of messages) {
      if (message.role === 'user') {
        const richParts: LlamaContentPart[] = [];
        let hasImagePart = false;

        for (const part of message.parts) {
          if (part.type === 'text') {
            richParts.push({ type: 'text', text: part.text });
            continue;
          }

          if (part.type === 'attachment') {
            const summary = this.formatAttachmentForModelContext(part);
            if (summary) {
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
            richParts.push({
              type: 'text',
              text: this.formatToolPartForModelContext(part),
            });
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
            return this.formatToolPartForModelContext(part);
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

  normalizeAttachments(attachments: AssistantMessagePartAttachment[]): AssistantMessagePartAttachment[] {
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

  formatAttachmentForModelContext(part: AssistantMessagePartAttachment): string {
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

  stringifyForModelContext(value: unknown, maxChars: number): string {
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

  isStandardToolPart(part: AssistantMessagePart): part is AssistantMessagePartTool {
    const type = (part as { type?: unknown }).type;
    if (typeof type !== 'string') return false;
    if (type === 'text' || type === 'attachment' || type === 'tool-call' || type === 'tool-result') return false;
    return this.isToolPartState((part as { state?: unknown }).state);
  }

  upsertToolPart(
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

  private formatToolPartForModelContext(part: AssistantMessagePartTool): string {
    const toolName = part.type.replace(/^tool-/, '');
    if (part.state === 'output-available') {
      return `[Tool Result] ${toolName} ${this.stringifyForModelContext(part.output, this.getHistoryToolResultLimit())}`;
    }
    if (part.state === 'output-error') {
      return `[Tool Result] ${toolName} ${part.errorText ?? 'error'}`;
    }
    return `[Tool Call] ${toolName} ${this.stringifyForModelContext(part.input, 1000)}`;
  }

  private toToolPartType(toolName: string): `tool-${string}` {
    return `tool-${toolName}` as `tool-${string}`;
  }

  private isToolPartState(value: unknown): value is AssistantMessagePartTool['state'] {
    return typeof value === 'string' && VALID_TOOL_PART_STATES.includes(value as AssistantMessagePartTool['state']);
  }
}
