/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssistantThread } from '../../shared/types';
import { resolveAssistantActiveModel } from './AssistantActiveModelResolver';

const thread: AssistantThread = {
  id: 'thread-1',
  title: 'Thread',
  createdAt: 1,
  updatedAt: 1,
  activeModel: 'thread-model',
};

test('resolveAssistantActiveModel prefers thread model over global and defaults', () => {
  assert.equal(
    resolveAssistantActiveModel({
      thread,
      globalModel: 'global-model',
      installedModels: ['gemma4:e4b', 'global-model', 'thread-model'],
    }),
    'thread-model',
  );
});

test('resolveAssistantActiveModel falls back to global model, default model, first model, then null', () => {
  assert.equal(
    resolveAssistantActiveModel({
      thread,
      globalModel: 'global-model',
      installedModels: ['gemma4:e4b', 'global-model'],
    }),
    'global-model',
  );
  assert.equal(
    resolveAssistantActiveModel({
      thread: null,
      globalModel: 'missing-global',
      installedModels: ['custom-model', 'gemma4:e4b'],
    }),
    'gemma4:e4b',
  );
  assert.equal(
    resolveAssistantActiveModel({
      thread: null,
      globalModel: null,
      installedModels: ['first-model'],
    }),
    'first-model',
  );
  assert.equal(
    resolveAssistantActiveModel({
      thread: null,
      globalModel: null,
      installedModels: [],
    }),
    null,
  );
});
