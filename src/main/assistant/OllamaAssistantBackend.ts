/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import type {
  AssistantInstalledModel,
  AssistantModelCatalogItem,
  AssistantModelUploadRequest,
  AssistantRuntimeStatus,
} from '../../shared/types';
import { ASSISTANT_DEFAULT_MODEL } from './constants';
import { OllamaRuntimeService } from './OllamaRuntimeService';
import type { ChatRuntime } from './AssistantRunExecutor';
import type { AssistantRuntimeBackendAdapter, AssistantRuntimeStatusContext } from './AssistantRuntimeBackendAdapter';

export interface OllamaAssistantBackendOptions {
  ollamaRuntimeService: OllamaRuntimeService;
  getRecommendedModel: () => AssistantModelCatalogItem;
}

export class OllamaAssistantBackend implements AssistantRuntimeBackendAdapter {
  readonly backend = 'ollama' as const;

  constructor(private readonly options: OllamaAssistantBackendOptions) {}

  async listModels(): Promise<string[]> {
    const snapshot = await this.options.ollamaRuntimeService.getSnapshot();
    return snapshot.models.map((model) => model.id);
  }

  async getModelById(modelId: string): Promise<AssistantInstalledModel | null> {
    const snapshot = await this.options.ollamaRuntimeService.getSnapshot();
    return snapshot.models.find((model) => model.id === modelId) ?? null;
  }

  async getRuntimeStatus({ resolveActiveModel }: AssistantRuntimeStatusContext): Promise<AssistantRuntimeStatus> {
    const snapshot = await this.options.ollamaRuntimeService.getSnapshot();
    const installedModelDetails = snapshot.models;
    const installedModels = installedModelDetails.map((model) => model.id);
    const recommendedModel = this.options.getRecommendedModel();
    const activeModel = resolveActiveModel(installedModels);
    const activeModelDetail = installedModelDetails.find((model) => model.id === activeModel) ?? null;
    const modelInstalled = installedModels.length > 0;
    const health = snapshot.daemonReachable && modelInstalled ? 'ready' : 'error';

    let error = snapshot.error;
    if (snapshot.daemonReachable && !modelInstalled) {
      error = `No Ollama models are available. Run "ollama pull ${recommendedModel.id}" in Terminal, then refresh.`;
    }

    return {
      backend: this.backend,
      health,
      modelInstalled,
      runtimeBinaryReady: snapshot.daemonReachable,
      runtimeBinarySource: 'external',
      daemonReachable: snapshot.daemonReachable,
      baseUrl: this.options.ollamaRuntimeService.getBaseUrl(),
      activeModel,
      installedModels,
      installedModelDetails,
      defaultModel: ASSISTANT_DEFAULT_MODEL,
      recommendedModel,
      supportsVision: Boolean(activeModelDetail?.supportsVision),
      downloadState: 'idle',
      ...(error ? { error } : {}),
    };
  }

  async downloadModel(_modelId: string): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: 'Model downloads are managed by Ollama. Run "ollama pull <model>" in Terminal.' };
  }

  cancelModelDownload(): { success: boolean; error?: string } {
    return { success: false, error: 'Model downloads are managed by Ollama. Run "ollama pull <model>" in Terminal.' };
  }

  async uploadModel(_payload: AssistantModelUploadRequest): Promise<{ success: boolean; modelId?: string; error?: string }> {
    return { success: false, error: 'GGUF upload is only available for the embedded runtime.' };
  }

  async deleteModel(_modelId: string): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: 'Remove Ollama models with "ollama rm <model>" in Terminal.' };
  }

  async ensureStarted(model: AssistantInstalledModel): Promise<{ success: boolean; error?: string }> {
    return this.options.ollamaRuntimeService.ensureStarted(model);
  }

  getRuntimeModelName(): string {
    return this.options.ollamaRuntimeService.getRuntimeModelName();
  }

  chatCompletions: ChatRuntime['chatCompletions'] = (payload, signal, onTextDelta) =>
    this.options.ollamaRuntimeService.chatCompletions(payload, signal, onTextDelta);

  async deactivate(): Promise<void> {
    return undefined;
  }
}
