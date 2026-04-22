/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssistantMessage } from '../../shared/types';
import { AssistantMessageSerializer } from './AssistantMessageSerializer';

test('AssistantMessageSerializer normalizes and truncates text attachments', () => {
  const serializer = new AssistantMessageSerializer(() => 20);
  const [attachment] = serializer.normalizeAttachments([
    {
      type: 'attachment',
      id: '',
      name: ' notes.md ',
      mimeType: 'text/markdown',
      sizeBytes: 12.8,
      textContent: 'x'.repeat(12_010),
    },
  ]);

  assert.equal(attachment.name, 'notes.md');
  assert.equal(attachment.sizeBytes, 12);
  assert.equal(attachment.textContent?.length, 12_000);
  assert.equal(attachment.truncated, true);
});

test('AssistantMessageSerializer converts image attachments into rich llama parts', () => {
  const serializer = new AssistantMessageSerializer(() => 20);
  const messages = serializer.toLlamaChatMessages([
    {
      id: 'm1',
      threadId: 't1',
      role: 'user',
      createdAt: 1,
      parts: [
        { type: 'text', text: 'look' },
        { type: 'attachment', id: 'a1', name: 'image.png', mimeType: 'image/png', sizeBytes: 10, imageBase64: 'abc' },
      ],
    },
  ]);

  assert.equal(messages[0]?.role, 'user');
  assert.equal(Array.isArray(messages[0]?.content), true);
});

test('AssistantMessageSerializer truncates historical tool result context', () => {
  const serializer = new AssistantMessageSerializer(() => 10);
  const messages: AssistantMessage[] = [
    {
      id: 'm1',
      threadId: 't1',
      role: 'assistant',
      createdAt: 1,
      parts: [
        {
          type: 'tool-get_document_info',
          state: 'output-available',
          toolCallId: 'tool-1',
          output: 'abcdefghijklmnopqrstuvwxyz',
        },
      ],
    },
  ];

  const [llamaMessage] = serializer.toLlamaChatMessages(messages);
  assert.equal(llamaMessage.content, '[Tool Result] get_document_info abcdefghij...(truncated)');
});
