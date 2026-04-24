/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STORE_KEYS } from '../../shared/constants';
import type { AssistantRuntimeBackend } from '../../shared/types';
import { AssistantRuntimeSettings } from './AssistantRuntimeSettings';
import type { AssistantRuntimeBackendAdapter } from './AssistantRuntimeBackendAdapter';
import { AssistantRuntimeBackendCoordinator } from './AssistantRuntimeBackendCoordinator';

function createMemorySettings(initialBackend: AssistantRuntimeBackend) {
  const values = new Map<string, unknown>([
    [STORE_KEYS.ASSISTANT_RUNTIME_BACKEND, initialBackend],
  ]);
  return new AssistantRuntimeSettings(
    <T>(key: string) => values.get(key) as T | undefined,
    <T>(key: string, value: T) => {
      values.set(key, value);
    },
  );
}

function createFakeBackend(onDeactivate: () => void): AssistantRuntimeBackendAdapter {
  return {
    backend: 'embedded',
    listModels: async () => [],
    getModelById: async () => null,
    getRuntimeStatus: async () => {
      throw new Error('not used');
    },
    downloadModel: async () => ({ success: true }),
    cancelModelDownload: () => ({ success: true }),
    uploadModel: async () => ({ success: true }),
    deleteModel: () => ({ success: true }),
    ensureStarted: async () => ({ success: true }),
    getRuntimeModelName: () => 'model',
    chatCompletions: async () => ({ choices: [] }),
    deactivate: async () => {
      onDeactivate();
    },
  };
}

test('AssistantRuntimeBackendCoordinator shuts down runs, deactivates previous backend, prunes, and emits status', async () => {
  const events: string[] = [];
  const settings = createMemorySettings('embedded');
  const coordinator = new AssistantRuntimeBackendCoordinator({
    runtimeSettings: settings,
    runtimeBackends: {
      embedded: createFakeBackend(() => events.push('deactivate:embedded')),
      ollama: createFakeBackend(() => events.push('deactivate:ollama')),
    },
    shutdownRuns: () => events.push('shutdown-runs'),
    pruneInvalidThreadModels: async () => {
      events.push('prune');
    },
    emitRuntimeStatusChange: async (threadId) => {
      events.push(`emit:${threadId ?? ''}`);
    },
    getLastOpenedThreadId: () => 'thread-1',
  });

  const result = await coordinator.setRuntimeBackend('ollama');

  assert.deepEqual(result, { success: true });
  assert.equal(settings.getRuntimeBackend(), 'ollama');
  assert.deepEqual(events, ['shutdown-runs', 'deactivate:embedded', 'prune', 'emit:thread-1']);
});

test('AssistantRuntimeBackendCoordinator emits status only when backend is unchanged', async () => {
  const events: string[] = [];
  const settings = createMemorySettings('ollama');
  const coordinator = new AssistantRuntimeBackendCoordinator({
    runtimeSettings: settings,
    runtimeBackends: {
      embedded: createFakeBackend(() => events.push('deactivate:embedded')),
      ollama: createFakeBackend(() => events.push('deactivate:ollama')),
    },
    shutdownRuns: () => events.push('shutdown-runs'),
    pruneInvalidThreadModels: async () => {
      events.push('prune');
    },
    emitRuntimeStatusChange: async (threadId) => {
      events.push(`emit:${threadId ?? ''}`);
    },
    getLastOpenedThreadId: () => null,
  });

  const result = await coordinator.setRuntimeBackend('ollama');

  assert.deepEqual(result, { success: true });
  assert.deepEqual(events, ['emit:']);
});
