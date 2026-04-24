/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import type { AssistantRuntimeBackend } from '../../shared/types';
import type { AssistantRuntimeSettings } from './AssistantRuntimeSettings';
import type { AssistantRuntimeBackendAdapter } from './AssistantRuntimeBackendAdapter';

export interface AssistantRuntimeBackendCoordinatorOptions {
  runtimeSettings: AssistantRuntimeSettings;
  runtimeBackends: Record<AssistantRuntimeBackend, AssistantRuntimeBackendAdapter>;
  shutdownRuns: () => void;
  pruneInvalidThreadModels: () => Promise<void>;
  emitRuntimeStatusChange: (threadId?: string) => Promise<void>;
  getLastOpenedThreadId: () => string | null;
}

export class AssistantRuntimeBackendCoordinator {
  constructor(private readonly options: AssistantRuntimeBackendCoordinatorOptions) {}

  async setRuntimeBackend(backend: AssistantRuntimeBackend): Promise<{ success: boolean; error?: string }> {
    const normalizedBackend = backend === 'ollama' ? 'ollama' : 'embedded';
    const previousBackend = this.options.runtimeSettings.getRuntimeBackend();
    const lastOpenedThreadId = this.options.getLastOpenedThreadId() ?? undefined;

    if (previousBackend === normalizedBackend) {
      await this.options.emitRuntimeStatusChange(lastOpenedThreadId);
      return { success: true };
    }

    this.options.shutdownRuns();
    await this.options.runtimeBackends[previousBackend].deactivate();
    this.options.runtimeSettings.setRuntimeBackend(normalizedBackend);
    await this.options.pruneInvalidThreadModels();
    await this.options.emitRuntimeStatusChange(lastOpenedThreadId);
    return { success: true };
  }
}
