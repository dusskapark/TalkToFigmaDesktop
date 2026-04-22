/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STORE_KEYS } from '../../shared/constants';
import type { AssistantKeyValueStore } from './AssistantThreadRepository';
import { AssistantThreadRepository } from './AssistantThreadRepository';

function createMemoryStore(initial?: Record<string, unknown>): AssistantKeyValueStore {
  const values = new Map<string, unknown>(Object.entries(initial ?? {}));
  return {
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value);
    },
  };
}

test('AssistantThreadRepository creates a thread and initializes messages', () => {
  const store = createMemoryStore();
  const repository = new AssistantThreadRepository(() => store);

  const thread = repository.createThread('  Design Review  ');
  const storedThreads = store.get(STORE_KEYS.ASSISTANT_THREADS);
  const storedMessages = store.get(STORE_KEYS.ASSISTANT_MESSAGES);

  assert.equal(thread.title, 'Design Review');
  assert.deepEqual(storedThreads, [thread]);
  assert.deepEqual(storedMessages, { [thread.id]: [] });
  assert.equal(store.get(STORE_KEYS.ASSISTANT_LAST_OPENED_THREAD_ID), thread.id);
});

test('AssistantThreadRepository prunes messages for deleted threads and fixes last opened thread', () => {
  const store = createMemoryStore({
    [STORE_KEYS.ASSISTANT_THREADS]: [
      { id: 'a', title: 'A', createdAt: 1, updatedAt: 1, activeModel: null },
      { id: 'b', title: 'B', createdAt: 2, updatedAt: 2, activeModel: null },
    ],
    [STORE_KEYS.ASSISTANT_MESSAGES]: {
      a: [{ id: 'm1', threadId: 'a', role: 'user', parts: [{ type: 'text', text: 'a' }], createdAt: 1 }],
      b: [{ id: 'm2', threadId: 'b', role: 'user', parts: [{ type: 'text', text: 'b' }], createdAt: 2 }],
    },
    [STORE_KEYS.ASSISTANT_LAST_OPENED_THREAD_ID]: 'a',
  });
  const repository = new AssistantThreadRepository(() => store);

  assert.equal(repository.deleteThread('a'), true);

  assert.deepEqual(repository.getThreads().map((thread) => thread.id), ['b']);
  assert.deepEqual(Object.keys(repository.getMessagesByThread()), ['b']);
  assert.equal(store.get(STORE_KEYS.ASSISTANT_LAST_OPENED_THREAD_ID), 'b');
});

test('AssistantThreadRepository clears invalid thread and global model references', () => {
  const store = createMemoryStore({
    [STORE_KEYS.ASSISTANT_THREADS]: [
      { id: 'a', title: 'A', createdAt: 1, updatedAt: 1, activeModel: 'missing' },
      { id: 'b', title: 'B', createdAt: 2, updatedAt: 2, activeModel: 'installed' },
    ],
    [STORE_KEYS.ASSISTANT_ACTIVE_MODEL]: 'missing',
  });
  const repository = new AssistantThreadRepository(() => store);

  repository.pruneInvalidThreadModels(['installed']);

  assert.deepEqual(repository.getThreads().map((thread) => thread.activeModel), ['installed', null]);
  assert.equal(repository.getGlobalActiveModel(), null);
});
