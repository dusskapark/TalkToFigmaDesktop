/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { v4 as uuidv4 } from 'uuid';
import { getStore } from '../utils/store';
import { STORE_KEYS } from '../../shared/constants';
import type { AssistantMessage, AssistantRunFinishReason, AssistantRunLog, AssistantThread } from '../../shared/types';
import { ASSISTANT_LIMITS } from './constants';

export interface AssistantKeyValueStore {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}

type StoreProvider = () => AssistantKeyValueStore;

export class AssistantThreadRepository {
  constructor(private readonly storeProvider: StoreProvider = defaultStoreProvider) {}

  createThread(title?: string): AssistantThread {
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
    return thread;
  }

  listThreads(): AssistantThread[] {
    return this.getThreads().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getThread(threadId: string): { thread: AssistantThread | null; messages: AssistantMessage[] } {
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

  deleteThread(threadId: string): boolean {
    const thread = this.findThreadById(threadId);
    if (!thread) {
      return false;
    }
    this.saveThreads(this.getThreads().filter((item) => item.id !== threadId));
    return true;
  }

  appendMessage(message: AssistantMessage): string {
    const messagesByThread = this.getMessagesByThread();
    const threadMessages = messagesByThread[message.threadId] ?? [];
    threadMessages.push(message);
    messagesByThread[message.threadId] = threadMessages.slice(-ASSISTANT_LIMITS.MESSAGES_PER_THREAD);
    this.saveMessagesByThread(messagesByThread);
    return message.id;
  }

  touchThread(threadId: string): void {
    this.updateThread(threadId, { updatedAt: Date.now() });
  }

  updateThread(threadId: string, patch: Partial<AssistantThread>): void {
    const threads = this.getThreads();
    const index = threads.findIndex((thread) => thread.id === threadId);
    if (index < 0) return;
    threads[index] = {
      ...threads[index],
      ...patch,
    };
    this.saveThreads(threads);
  }

  findThreadById(threadId: string): AssistantThread | null {
    return this.getThreads().find((thread) => thread.id === threadId) ?? null;
  }

  getMessagesForThread(threadId: string): AssistantMessage[] {
    const messages = this.getMessagesByThread()[threadId] ?? [];
    return messages.map((message) => ({
      ...message,
      parts: [...message.parts],
    }));
  }

  persistRunLog(runId: string, threadId: string, finishReason: AssistantRunFinishReason, toolCalls: AssistantRunLog['toolCalls']): void {
    const runLogs = this.getRunLogs();
    runLogs.unshift({
      runId,
      threadId,
      finishReason,
      toolCalls,
      createdAt: Date.now(),
    });
    this.saveRunLogs(runLogs);
  }

  getThreads(): AssistantThread[] {
    return this.getStoreValue<AssistantThread[]>(STORE_KEYS.ASSISTANT_THREADS, []);
  }

  saveThreads(threads: AssistantThread[]): void {
    const deduped = Array.from(new Map(threads.map((thread) => [thread.id, thread])).values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, ASSISTANT_LIMITS.THREADS);
    const activeThreadIds = new Set(deduped.map((thread) => thread.id));
    const store = this.storeProvider();
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

  getMessagesByThread(): Record<string, AssistantMessage[]> {
    return this.getStoreValue<Record<string, AssistantMessage[]>>(STORE_KEYS.ASSISTANT_MESSAGES, {});
  }

  saveMessagesByThread(messagesByThread: Record<string, AssistantMessage[]>): void {
    const activeThreadIds = new Set(this.getThreads().map((thread) => thread.id));
    const trimmed: Record<string, AssistantMessage[]> = {};
    for (const [threadId, messages] of Object.entries(messagesByThread)) {
      if (!activeThreadIds.has(threadId)) {
        continue;
      }
      trimmed[threadId] = messages.slice(-ASSISTANT_LIMITS.MESSAGES_PER_THREAD);
    }
    this.storeProvider().set(STORE_KEYS.ASSISTANT_MESSAGES, trimmed);
  }

  getGlobalActiveModel(): string | null {
    return this.getStoreValue<string | null>(STORE_KEYS.ASSISTANT_ACTIVE_MODEL, null);
  }

  setGlobalActiveModel(model: string | null): void {
    this.storeProvider().set(STORE_KEYS.ASSISTANT_ACTIVE_MODEL, model);
  }

  setLastOpenedThreadId(threadId: string): void {
    this.storeProvider().set(STORE_KEYS.ASSISTANT_LAST_OPENED_THREAD_ID, threadId);
  }

  getLastOpenedThreadId(): string | null {
    const value = this.getStoreValue<string | null>(STORE_KEYS.ASSISTANT_LAST_OPENED_THREAD_ID, null);
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
  }

  pruneInvalidThreadModels(installedModelIds: Iterable<string>): void {
    const installedIds = new Set(installedModelIds);
    const threads = this.getThreads();
    let changed = false;

    const patched = threads.map((thread) => {
      if (thread.activeModel && !installedIds.has(thread.activeModel)) {
        changed = true;
        return {
          ...thread,
          activeModel: null,
        };
      }
      return thread;
    });

    if (changed) {
      this.saveThreads(patched);
    }

    const globalModel = this.getGlobalActiveModel();
    if (globalModel && !installedIds.has(globalModel)) {
      this.setGlobalActiveModel(null);
    }
  }

  private getRunLogs(): AssistantRunLog[] {
    return this.getStoreValue<AssistantRunLog[]>(STORE_KEYS.ASSISTANT_RUN_LOGS, []);
  }

  private saveRunLogs(runLogs: AssistantRunLog[]): void {
    this.storeProvider().set(STORE_KEYS.ASSISTANT_RUN_LOGS, runLogs.slice(0, ASSISTANT_LIMITS.RUN_LOGS));
  }

  private getStoreValue<T>(key: string, fallback: T): T {
    const value = this.storeProvider().get(key);
    return value === undefined ? fallback : value as T;
  }
}

function defaultStoreProvider(): AssistantKeyValueStore {
  return getStore();
}
