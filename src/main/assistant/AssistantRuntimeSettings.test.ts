/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASSISTANT_CONTEXT_LENGTH, ASSISTANT_TOOL_RESULT_LIMITS, STORE_KEYS } from '../../shared/constants';
import { AssistantRuntimeSettings, normalizeContextLength, normalizeToolResultLimit } from './AssistantRuntimeSettings';

test('normalizeContextLength accepts only configured context options', () => {
  assert.equal(normalizeContextLength(ASSISTANT_CONTEXT_LENGTH.OPTIONS[0]), ASSISTANT_CONTEXT_LENGTH.OPTIONS[0]);
  assert.equal(normalizeContextLength('not-a-number'), ASSISTANT_CONTEXT_LENGTH.DEFAULT);
  assert.equal(normalizeContextLength(12345), ASSISTANT_CONTEXT_LENGTH.DEFAULT);
});

test('normalizeToolResultLimit accepts only configured tool result options', () => {
  assert.equal(normalizeToolResultLimit(ASSISTANT_TOOL_RESULT_LIMITS.OPTIONS[1], 4096), ASSISTANT_TOOL_RESULT_LIMITS.OPTIONS[1]);
  assert.equal(normalizeToolResultLimit('bad', 4096), 4096);
  assert.equal(normalizeToolResultLimit(12345, 4096), 4096);
});

test('AssistantRuntimeSettings increases context length with headroom', () => {
  const values = new Map<string, unknown>([
    [STORE_KEYS.ASSISTANT_CONTEXT_LENGTH, 4096],
  ]);
  const settings = new AssistantRuntimeSettings(
    <T>(key: string) => values.get(key) as T | undefined,
    <T>(key: string, value: T) => {
      values.set(key, value);
    },
  );

  const next = settings.increaseContextLengthForPrompt(7000, 4096);

  assert.equal(next, 16384);
  assert.equal(values.get(STORE_KEYS.ASSISTANT_CONTEXT_LENGTH), 16384);
});

test('AssistantRuntimeSettings returns null when no larger context option exists', () => {
  const values = new Map<string, unknown>([
    [STORE_KEYS.ASSISTANT_CONTEXT_LENGTH, ASSISTANT_CONTEXT_LENGTH.OPTIONS.at(-1)],
  ]);
  const settings = new AssistantRuntimeSettings(
    <T>(key: string) => values.get(key) as T | undefined,
    <T>(key: string, value: T) => {
      values.set(key, value);
    },
  );

  assert.equal(settings.increaseContextLengthForPrompt(1_000_000, 262144), null);
});
