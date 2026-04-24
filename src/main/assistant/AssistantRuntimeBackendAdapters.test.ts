/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  AssistantInstalledModel,
  AssistantModelCatalogItem,
  AssistantRuntimeStatus,
} from '../../shared/types';
import { EmbeddedAssistantBackend } from './EmbeddedAssistantBackend';
import { OllamaAssistantBackend } from './OllamaAssistantBackend';

const recommendedModel: AssistantModelCatalogItem = {
  id: 'gemma4:e4b',
  displayName: 'Gemma 4 E4B (Q4_K_M)',
  version: '1',
  recommended: true,
  supportsVision: true,
  source: 'huggingface',
  modelFileName: 'model.gguf',
  modelUrl: 'https://example.com/model.gguf',
  modelSha256: 'sha',
  modelSizeBytes: 10,
};

const installedModel: AssistantInstalledModel = {
  id: 'gemma4:e4b',
  displayName: 'Gemma 4 E4B (Q4_K_M)',
  version: '1',
  source: 'download',
  supportsVision: true,
  modelPath: '/tmp/model.gguf',
  modelSha256: 'sha',
  modelSizeBytes: 10,
  installedAt: 1,
};

function createEmbeddedBackend({
  models,
  runtimeReady = true,
  runtimeError,
  downloadState = 'idle',
}: {
  models: AssistantInstalledModel[];
  runtimeReady?: boolean;
  runtimeError?: string;
  downloadState?: AssistantRuntimeStatus['downloadState'];
}) {
  return new EmbeddedAssistantBackend({
    modelInstallService: {
      getCatalog: () => [recommendedModel],
      getRecommendedModel: () => recommendedModel,
      getInstalledModels: () => models,
      getInstalledModelById: (modelId: string) => models.find((model) => model.id === modelId) ?? null,
      getDownloadSnapshot: () => ({ state: downloadState }),
      downloadModel: async () => ({ success: true }),
      cancelDownload: () => ({ success: true }),
      uploadModel: async () => ({ success: true, modelId: 'upload:model' }),
      deleteModel: () => ({ success: true }),
    } as any,
    embeddedRuntimeService: {
      getRuntimeBinaryStatus: () => ({
        ready: runtimeReady,
        source: runtimeReady ? 'bundled' : 'missing',
        ...(runtimeReady ? { path: '/tmp/llama-server' } : {}),
      }),
      getHealth: () => 'ready',
      getError: () => runtimeError,
      stop: async () => undefined,
      ensureStarted: async () => ({ success: true }),
      getRuntimeModelName: () => 'local-model',
      chatCompletions: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    } as any,
  });
}

test('EmbeddedAssistantBackend reports no-model status with existing message shape', async () => {
  const backend = createEmbeddedBackend({ models: [] });

  const status = await backend.getRuntimeStatus({
    thread: null,
    resolveActiveModel: () => null,
  });

  assert.equal(status.backend, 'embedded');
  assert.equal(status.modelInstalled, false);
  assert.equal(status.runtimeBinaryReady, true);
  assert.equal(status.activeModel, null);
  assert.match(status.error ?? '', /No model is installed yet/);
});

test('EmbeddedAssistantBackend reports installed and missing-runtime status', async () => {
  const readyBackend = createEmbeddedBackend({ models: [installedModel] });
  const readyStatus = await readyBackend.getRuntimeStatus({
    thread: null,
    resolveActiveModel: () => installedModel.id,
  });

  assert.equal(readyStatus.modelInstalled, true);
  assert.equal(readyStatus.health, 'ready');
  assert.equal(readyStatus.runtimeBinaryReady, true);
  assert.equal(readyStatus.supportsVision, true);

  const missingBackend = createEmbeddedBackend({ models: [installedModel], runtimeReady: false });
  const missingStatus = await missingBackend.getRuntimeStatus({
    thread: null,
    resolveActiveModel: () => installedModel.id,
  });

  assert.equal(missingStatus.modelInstalled, true);
  assert.equal(missingStatus.health, 'error');
  assert.equal(missingStatus.runtimeBinaryReady, false);
  assert.match(missingStatus.error ?? '', /Bundled llama-server runtime is missing/);
});

test('OllamaAssistantBackend reports daemon offline, no-model, and model-available status', async () => {
  const offlineBackend = new OllamaAssistantBackend({
    getRecommendedModel: () => recommendedModel,
    ollamaRuntimeService: {
      getSnapshot: async () => ({ daemonReachable: false, models: [], error: 'offline' }),
      getBaseUrl: () => 'http://127.0.0.1:11434',
    } as any,
  });
  const offlineStatus = await offlineBackend.getRuntimeStatus({
    thread: null,
    resolveActiveModel: () => null,
  });
  assert.equal(offlineStatus.backend, 'ollama');
  assert.equal(offlineStatus.daemonReachable, false);
  assert.equal(offlineStatus.error, 'offline');

  const noModelBackend = new OllamaAssistantBackend({
    getRecommendedModel: () => recommendedModel,
    ollamaRuntimeService: {
      getSnapshot: async () => ({ daemonReachable: true, models: [] }),
      getBaseUrl: () => 'http://127.0.0.1:11434',
    } as any,
  });
  const noModelStatus = await noModelBackend.getRuntimeStatus({
    thread: null,
    resolveActiveModel: () => null,
  });
  assert.equal(noModelStatus.daemonReachable, true);
  assert.equal(noModelStatus.modelInstalled, false);
  assert.match(noModelStatus.error ?? '', /ollama pull gemma4:e4b/);

  const modelBackend = new OllamaAssistantBackend({
    getRecommendedModel: () => recommendedModel,
    ollamaRuntimeService: {
      getSnapshot: async () => ({ daemonReachable: true, models: [{ ...installedModel, source: 'ollama' }] }),
      getBaseUrl: () => 'http://127.0.0.1:11434',
    } as any,
  });
  const modelStatus = await modelBackend.getRuntimeStatus({
    thread: null,
    resolveActiveModel: () => installedModel.id,
  });
  assert.equal(modelStatus.modelInstalled, true);
  assert.equal(modelStatus.health, 'ready');
  assert.equal(modelStatus.activeModel, installedModel.id);
});

test('OllamaAssistantBackend returns existing unsupported operation messages', async () => {
  const backend = new OllamaAssistantBackend({
    getRecommendedModel: () => recommendedModel,
    ollamaRuntimeService: {
      getSnapshot: async () => ({ daemonReachable: true, models: [] }),
      getBaseUrl: () => 'http://127.0.0.1:11434',
    } as any,
  });

  assert.match((await backend.downloadModel('gemma4:e4b')).error ?? '', /Model downloads are managed by Ollama/);
  assert.match((await backend.uploadModel({ ggufPath: '/tmp/model.gguf' })).error ?? '', /embedded runtime/);
  assert.match((await backend.deleteModel('gemma4:e4b')).error ?? '', /ollama rm <model>/);
});
