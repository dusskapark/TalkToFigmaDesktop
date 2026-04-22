/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

export interface LlamaToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlamaToolCall {
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

export type LlamaContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type LlamaChatMessage =
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

export interface LlamaChatCompletionResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: LlamaToolCall[];
    };
    finish_reason?: string | null;
  }>;
}
