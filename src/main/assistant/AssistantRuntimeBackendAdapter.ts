/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import type {
  AssistantInstalledModel,
  AssistantModelUploadRequest,
  AssistantRuntimeBackend,
  AssistantRuntimeStatus,
  AssistantThread,
} from '../../shared/types';
import type { ChatRuntime } from './AssistantRunExecutor';

export interface AssistantRuntimeStatusContext {
  thread: AssistantThread | null;
  resolveActiveModel: (installedModels: string[]) => string | null;
}

export interface AssistantRuntimeBackendAdapter extends ChatRuntime {
  readonly backend: AssistantRuntimeBackend;

  listModels(): Promise<string[]>;
  getModelById(modelId: string): Promise<AssistantInstalledModel | null>;
  getRuntimeStatus(context: AssistantRuntimeStatusContext): Promise<AssistantRuntimeStatus>;
  downloadModel(modelId: string): Promise<{ success: boolean; error?: string }>;
  cancelModelDownload(): Promise<{ success: boolean; error?: string }> | { success: boolean; error?: string };
  uploadModel(payload: AssistantModelUploadRequest): Promise<{ success: boolean; modelId?: string; error?: string }>;
  deleteModel(modelId: string): Promise<{ success: boolean; error?: string }> | { success: boolean; error?: string };
  deactivate(): Promise<void>;
}
