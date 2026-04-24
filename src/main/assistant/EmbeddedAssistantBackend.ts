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
import { AiSdkLlamaRuntimeAdapter } from './AiSdkLlamaRuntimeAdapter';
import { EmbeddedLlamaRuntimeService } from './EmbeddedLlamaRuntimeService';
import { ModelInstallService } from './ModelInstallService';
import type { ChatRuntime } from './AssistantRunExecutor';
import type { AssistantRuntimeBackendAdapter, AssistantRuntimeStatusContext } from './AssistantRuntimeBackendAdapter';

const ASSISTANT_RUNTIME_ADAPTER_ENV = 'TALK_TO_FIGMA_ASSISTANT_RUNTIME';
const AI_SDK_RUNTIME_ADAPTER_VALUE = 'ai-sdk';

export interface EmbeddedAssistantBackendOptions {
  modelInstallService: ModelInstallService;
  embeddedRuntimeService: EmbeddedLlamaRuntimeService;
  logger?: {
    warn: (message: string) => void;
  };
}

export class EmbeddedAssistantBackend implements AssistantRuntimeBackendAdapter {
  readonly backend = 'embedded' as const;

  private readonly chatRuntime: ChatRuntime;

  constructor(private readonly options: EmbeddedAssistantBackendOptions) {
    this.chatRuntime = this.createChatRuntime();
  }

  listModelCatalog(): AssistantModelCatalogItem[] {
    return this.options.modelInstallService.getCatalog();
  }

  async listModels(): Promise<string[]> {
    return this.options.modelInstallService.getInstalledModels().map((model) => model.id);
  }

  async getModelById(modelId: string): Promise<AssistantInstalledModel | null> {
    return this.options.modelInstallService.getInstalledModelById(modelId);
  }

  async getRuntimeStatus({ resolveActiveModel }: AssistantRuntimeStatusContext): Promise<AssistantRuntimeStatus> {
    const installedModelDetails = this.options.modelInstallService.getInstalledModels();
    const installedModels = installedModelDetails.map((model) => model.id);
    const recommendedModel = this.options.modelInstallService.getRecommendedModel();
    const activeModel = resolveActiveModel(installedModels);
    const activeModelDetail = installedModelDetails.find((model) => model.id === activeModel) ?? null;
    const downloadSnapshot = this.options.modelInstallService.getDownloadSnapshot();
    const runtimeBinaryStatus = this.options.embeddedRuntimeService.getRuntimeBinaryStatus();

    const modelInstalled = installedModels.length > 0;
    const health = modelInstalled && runtimeBinaryStatus.ready ? this.options.embeddedRuntimeService.getHealth() : 'error';

    let error = downloadSnapshot.error ?? this.options.embeddedRuntimeService.getError();
    if (!modelInstalled && downloadSnapshot.state !== 'downloading' && downloadSnapshot.state !== 'verifying') {
      error ??= 'No model is installed yet. Download the recommended model or upload GGUF files in Settings > Model.';
    } else if (modelInstalled && !runtimeBinaryStatus.ready) {
      error ??= 'Bundled llama-server runtime is missing. Reinstall the app or rebuild the package.';
    }

    return {
      backend: this.backend,
      health,
      modelInstalled,
      runtimeBinaryReady: runtimeBinaryStatus.ready,
      runtimeBinarySource: runtimeBinaryStatus.source,
      ...(runtimeBinaryStatus.path ? { runtimeBinaryPath: runtimeBinaryStatus.path } : {}),
      activeModel,
      installedModels,
      installedModelDetails,
      defaultModel: ASSISTANT_DEFAULT_MODEL,
      recommendedModel,
      supportsVision: Boolean(activeModelDetail?.supportsVision),
      downloadState: downloadSnapshot.state,
      ...(downloadSnapshot.progress ? { downloadProgress: downloadSnapshot.progress } : {}),
      ...(error ? { error } : {}),
    };
  }

  async downloadModel(modelId: string): Promise<{ success: boolean; error?: string }> {
    return this.options.modelInstallService.downloadModel(modelId);
  }

  cancelModelDownload(): { success: boolean; error?: string } {
    return this.options.modelInstallService.cancelDownload();
  }

  async uploadModel(payload: AssistantModelUploadRequest): Promise<{ success: boolean; modelId?: string; error?: string }> {
    return this.options.modelInstallService.uploadModel(payload);
  }

  async deleteModel(modelId: string): Promise<{ success: boolean; error?: string }> {
    const result = this.options.modelInstallService.deleteModel(modelId);
    if (result.success) {
      await this.options.embeddedRuntimeService.stop();
    }
    return result;
  }

  async ensureStarted(model: AssistantInstalledModel): Promise<{ success: boolean; error?: string }> {
    return this.chatRuntime.ensureStarted(model);
  }

  getRuntimeModelName(): string {
    return this.chatRuntime.getRuntimeModelName();
  }

  chatCompletions: ChatRuntime['chatCompletions'] = (payload, signal, onTextDelta) =>
    this.chatRuntime.chatCompletions(payload, signal, onTextDelta);

  async deactivate(): Promise<void> {
    await this.options.embeddedRuntimeService.stop();
  }

  private createChatRuntime(): ChatRuntime {
    if (process.env[ASSISTANT_RUNTIME_ADAPTER_ENV] === AI_SDK_RUNTIME_ADAPTER_VALUE) {
      this.options.logger?.warn('Assistant AI SDK llama runtime adapter enabled for local PoC');
      return new AiSdkLlamaRuntimeAdapter(this.options.embeddedRuntimeService);
    }

    return this.options.embeddedRuntimeService;
  }
}
