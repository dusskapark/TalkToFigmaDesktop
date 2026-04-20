/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { app } from 'electron';
import path, { basename } from 'node:path';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  copyFileSync,
} from 'node:fs';
import { finished } from 'node:stream/promises';
import { createLogger } from '../utils/logger';
import { getStore } from '../utils/store';
import { STORE_KEYS } from '../../shared/constants';
import type {
  AssistantInstalledModel,
  AssistantModelCatalogItem,
  AssistantModelDownloadProgress,
  AssistantModelDownloadState,
  AssistantModelUploadRequest,
} from '../../shared/types';
import {
  isResumeNotSatisfiable,
  resolveCorruptedArtifactCleanupPaths,
  resolveResumePreparation,
} from './modelDownloadRecovery';

interface DownloadSnapshot {
  state: AssistantModelDownloadState;
  progress?: AssistantModelDownloadProgress;
  error?: string;
}

interface DownloadArtifact {
  fileName: string;
  url: string;
  expectedSha256: string;
  expectedSizeBytes: number;
  destinationPath: string;
}

interface DownloadTask {
  controller: AbortController;
  totalBytes: number;
  downloadedBytes: number;
  startedAt: number;
  lastSampleAt: number;
  lastSampleBytes: number;
}

const EMBEDDED_MODEL_CATALOG: AssistantModelCatalogItem[] = [
  {
    id: 'gemma4:e4b',
    displayName: 'Gemma 4 E4B (Q4_K_M)',
    version: '2714b5519c6c3516b1000e7c5e1eba998dfe1fe8',
    recommended: true,
    supportsVision: true,
    source: 'huggingface',
    modelFileName: 'gemma-4-E4B-it-Q4_K_M.gguf',
    modelUrl: 'https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf?download=true',
    modelSha256: '90ce98129eb3e8cc57e62433d500c97c624b1e3af1fcc85dd3b55ad7e0313e9f',
    modelSizeBytes: 5_335_289_824,
    mmprojFileName: 'mmproj-gemma-4-E4B-it-Q8_0.gguf',
    mmprojUrl: 'https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF/resolve/main/mmproj-gemma-4-E4B-it-Q8_0.gguf?download=true',
    mmprojSha256: '51d4b7fd825e4569f746b200fccc5332bf914e8ef7cbe447272ce4fec6df3db6',
    mmprojSizeBytes: 559_874_528,
  },
];

function sanitizeModelLabel(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'custom-model';
}

function ensureDirectory(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export class ModelInstallService {
  private readonly logger = createLogger('ModelInstallService');
  private readonly modelRootDir: string;
  private readonly managedModelDir: string;
  private readonly downloadDir: string;
  private readonly onStateChanged?: () => void;

  private downloadSnapshot: DownloadSnapshot = { state: 'idle' };
  private activeDownloadTask: DownloadTask | null = null;

  constructor(options?: { onStateChanged?: () => void }) {
    this.onStateChanged = options?.onStateChanged;

    this.modelRootDir = path.join(app.getPath('userData'), 'assistant-models');
    this.managedModelDir = path.join(this.modelRootDir, 'models');
    this.downloadDir = path.join(this.modelRootDir, 'downloads');

    ensureDirectory(this.modelRootDir);
    ensureDirectory(this.managedModelDir);
    ensureDirectory(this.downloadDir);
    this.compactRegistry();
  }

  getCatalog(): AssistantModelCatalogItem[] {
    return EMBEDDED_MODEL_CATALOG.map((item) => ({ ...item }));
  }

  getRecommendedModel(): AssistantModelCatalogItem {
    return EMBEDDED_MODEL_CATALOG.find((item) => item.recommended) ?? EMBEDDED_MODEL_CATALOG[0];
  }

  getDownloadSnapshot(): DownloadSnapshot {
    return {
      state: this.downloadSnapshot.state,
      ...(this.downloadSnapshot.progress ? { progress: { ...this.downloadSnapshot.progress } } : {}),
      ...(this.downloadSnapshot.error ? { error: this.downloadSnapshot.error } : {}),
    };
  }

  cancelDownload(): { success: boolean; error?: string } {
    if (!this.activeDownloadTask) {
      return { success: false, error: 'No active model download' };
    }

    this.activeDownloadTask.controller.abort();
    this.setDownloadSnapshot({
      state: 'failed',
      error: 'Download cancelled by user',
    });
    return { success: true };
  }

  async downloadModel(modelId: string): Promise<{ success: boolean; error?: string }> {
    if (this.activeDownloadTask) {
      return { success: false, error: 'A model download is already in progress' };
    }

    const model = this.getCatalog().find((item) => item.id === modelId);
    if (!model) {
      return { success: false, error: `Model catalog entry not found: ${modelId}` };
    }

    const artifacts: DownloadArtifact[] = [
      {
        fileName: model.modelFileName,
        url: model.modelUrl,
        expectedSha256: model.modelSha256,
        expectedSizeBytes: model.modelSizeBytes,
        destinationPath: path.join(this.managedModelDir, model.modelFileName),
      },
    ];

    if (model.mmprojFileName && model.mmprojUrl && model.mmprojSha256 && model.mmprojSizeBytes) {
      artifacts.push({
        fileName: model.mmprojFileName,
        url: model.mmprojUrl,
        expectedSha256: model.mmprojSha256,
        expectedSizeBytes: model.mmprojSizeBytes,
        destinationPath: path.join(this.managedModelDir, model.mmprojFileName),
      });
    }

    const totalBytes = artifacts.reduce((sum, artifact) => sum + artifact.expectedSizeBytes, 0);
    this.activeDownloadTask = {
      controller: new AbortController(),
      totalBytes,
      downloadedBytes: 0,
      startedAt: Date.now(),
      lastSampleAt: Date.now(),
      lastSampleBytes: 0,
    };

    this.setDownloadSnapshot({
      state: 'downloading',
      progress: {
        stage: 'downloading',
        downloadedBytes: 0,
        totalBytes,
        speedBytesPerSecond: 0,
        etaSeconds: null,
        currentFile: artifacts[0]?.fileName ?? null,
      },
    });

    try {
      for (const artifact of artifacts) {
        this.updateDownloadProgress({ currentFile: artifact.fileName });
        await this.downloadArtifact(artifact, this.activeDownloadTask.controller.signal);
      }

      this.setDownloadSnapshot({
        state: 'verifying',
        progress: {
          stage: 'verifying',
          downloadedBytes: totalBytes,
          totalBytes,
          speedBytesPerSecond: 0,
          etaSeconds: 0,
          currentFile: null,
        },
      });

      for (const artifact of artifacts) {
        const partPath = this.getPartPath(artifact.fileName);
        const verificationPath = existsSync(partPath) ? partPath : artifact.destinationPath;
        if (!existsSync(verificationPath)) {
          throw new Error(`Downloaded artifact is missing: ${artifact.fileName}`);
        }

        const actualSha = await this.computeSha256(verificationPath);
        if (actualSha !== artifact.expectedSha256) {
          this.cleanupCorruptedArtifact(artifact);
          throw new Error(`Checksum mismatch for ${artifact.fileName}`);
        }

        if (verificationPath === partPath) {
          renameSync(partPath, artifact.destinationPath);
        }
      }

      const installedModel: AssistantInstalledModel = {
        id: model.id,
        displayName: model.displayName,
        version: model.version,
        source: 'download',
        supportsVision: model.supportsVision,
        modelPath: path.join(this.managedModelDir, model.modelFileName),
        modelSha256: model.modelSha256,
        modelSizeBytes: model.modelSizeBytes,
        ...(model.mmprojFileName && model.mmprojSha256 && model.mmprojSizeBytes
          ? {
              mmprojPath: path.join(this.managedModelDir, model.mmprojFileName),
              mmprojSha256: model.mmprojSha256,
              mmprojSizeBytes: model.mmprojSizeBytes,
            }
          : {}),
        installedAt: Date.now(),
      };

      this.upsertInstalledModel(installedModel);
      if (!this.getActiveModelId()) {
        this.setActiveModelId(installedModel.id);
      }

      this.setDownloadSnapshot({
        state: 'completed',
        progress: {
          stage: 'verifying',
          downloadedBytes: totalBytes,
          totalBytes,
          speedBytesPerSecond: 0,
          etaSeconds: 0,
          currentFile: null,
        },
      });

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Model download failed: ${message}`);
      this.setDownloadSnapshot({
        state: 'failed',
        error: message,
      });
      return { success: false, error: message };
    } finally {
      this.activeDownloadTask = null;
    }
  }

  async uploadModel(payload: AssistantModelUploadRequest): Promise<{ success: boolean; modelId?: string; error?: string }> {
    try {
      const ggufPath = payload.ggufPath?.trim();
      if (!ggufPath) {
        return { success: false, error: 'GGUF file path is required' };
      }
      if (!existsSync(ggufPath)) {
        return { success: false, error: `GGUF file not found: ${ggufPath}` };
      }
      if (!ggufPath.toLowerCase().endsWith('.gguf')) {
        return { success: false, error: 'GGUF file must use .gguf extension' };
      }

      const mmprojPath = payload.mmprojPath?.trim();
      if (mmprojPath) {
        if (!existsSync(mmprojPath)) {
          return { success: false, error: `mmproj file not found: ${mmprojPath}` };
        }
        if (!mmprojPath.toLowerCase().endsWith('.gguf')) {
          return { success: false, error: 'mmproj file must use .gguf extension' };
        }
      }

      const label = sanitizeModelLabel(payload.displayName || basename(ggufPath, '.gguf'));
      const ggufHash = await this.computeSha256(ggufPath);
      const modelId = `upload:${ggufHash.slice(0, 12)}`;
      const modelFileName = `${label}-${ggufHash.slice(0, 12)}.gguf`;
      const modelDestination = path.join(this.managedModelDir, modelFileName);
      copyFileSync(ggufPath, modelDestination);

      const modelSizeBytes = statSync(ggufPath).size;
      let mmprojDestination: string | undefined;
      let mmprojHash: string | undefined;
      let mmprojSizeBytes: number | undefined;

      if (mmprojPath) {
        mmprojHash = await this.computeSha256(mmprojPath);
        mmprojSizeBytes = statSync(mmprojPath).size;
        const mmprojFileName = `${label}-${mmprojHash.slice(0, 12)}-mmproj.gguf`;
        mmprojDestination = path.join(this.managedModelDir, mmprojFileName);
        copyFileSync(mmprojPath, mmprojDestination);
      }

      const model: AssistantInstalledModel = {
        id: modelId,
        displayName: payload.displayName?.trim() || basename(ggufPath),
        version: 'upload',
        source: 'upload',
        supportsVision: Boolean(mmprojDestination),
        modelPath: modelDestination,
        modelSha256: ggufHash,
        modelSizeBytes,
        ...(mmprojDestination ? { mmprojPath: mmprojDestination } : {}),
        ...(mmprojHash ? { mmprojSha256: mmprojHash } : {}),
        ...(mmprojSizeBytes ? { mmprojSizeBytes } : {}),
        installedAt: Date.now(),
      };
      this.upsertInstalledModel(model);

      if (!this.getActiveModelId()) {
        this.setActiveModelId(modelId);
      }

      this.notifyStateChanged();
      return { success: true, modelId };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  deleteModel(modelId: string): { success: boolean; error?: string } {
    const registry = this.getInstalledModels();
    const target = registry.find((item) => item.id === modelId);
    if (!target) {
      return { success: false, error: 'Model not found' };
    }

    const nextRegistry = registry.filter((item) => item.id !== modelId);
    this.saveInstalledModels(nextRegistry);

    const activeModelId = this.getActiveModelId();
    if (activeModelId === modelId) {
      this.setActiveModelId(nextRegistry[0]?.id ?? null);
    }

    this.safeDeleteManagedFile(target.modelPath);
    if (target.mmprojPath) {
      this.safeDeleteManagedFile(target.mmprojPath);
    }
    this.notifyStateChanged();
    return { success: true };
  }

  getInstalledModels(): AssistantInstalledModel[] {
    const store = getStore();
    const raw = store.get(STORE_KEYS.ASSISTANT_MODEL_REGISTRY);
    if (!Array.isArray(raw)) {
      return [];
    }

    const models = raw as AssistantInstalledModel[];
    return models.filter((model) => existsSync(model.modelPath));
  }

  getActiveModelId(): string | null {
    const store = getStore();
    const value = store.get(STORE_KEYS.ASSISTANT_ACTIVE_MODEL);
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
  }

  setActiveModelId(modelId: string | null): void {
    const store = getStore();
    store.set(STORE_KEYS.ASSISTANT_ACTIVE_MODEL, modelId);
    this.notifyStateChanged();
  }

  getInstalledModelById(modelId: string | null): AssistantInstalledModel | null {
    if (!modelId) return null;
    return this.getInstalledModels().find((model) => model.id === modelId) ?? null;
  }

  private compactRegistry(): void {
    const models = this.getInstalledModels();
    this.saveInstalledModels(models);
  }

  private saveInstalledModels(models: AssistantInstalledModel[]): void {
    const deduped = Array.from(new Map(models.map((model) => [model.id, model])).values())
      .sort((a, b) => b.installedAt - a.installedAt);
    const store = getStore();
    store.set(STORE_KEYS.ASSISTANT_MODEL_REGISTRY, deduped);
  }

  private upsertInstalledModel(model: AssistantInstalledModel): void {
    const models = this.getInstalledModels();
    const nextModels = [
      ...models.filter((current) => current.id !== model.id),
      model,
    ];
    this.saveInstalledModels(nextModels);
  }

  private notifyStateChanged(): void {
    this.onStateChanged?.();
  }

  private setDownloadSnapshot(snapshot: DownloadSnapshot): void {
    this.downloadSnapshot = snapshot;
    this.notifyStateChanged();
  }

  private updateDownloadProgress(patch: Partial<AssistantModelDownloadProgress>): void {
    const task = this.activeDownloadTask;
    if (!task) {
      return;
    }

    const now = Date.now();
    const elapsedMs = Math.max(1, now - task.lastSampleAt);
    const bytesSinceLastSample = task.downloadedBytes - task.lastSampleBytes;
    const speedBytesPerSecond = Math.max(0, Math.floor(bytesSinceLastSample / (elapsedMs / 1000)));
    const remainingBytes = Math.max(0, task.totalBytes - task.downloadedBytes);
    const etaSeconds = speedBytesPerSecond > 0 ? Math.ceil(remainingBytes / speedBytesPerSecond) : null;

    task.lastSampleAt = now;
    task.lastSampleBytes = task.downloadedBytes;

    this.setDownloadSnapshot({
      state: 'downloading',
      progress: {
        stage: 'downloading',
        downloadedBytes: task.downloadedBytes,
        totalBytes: task.totalBytes,
        speedBytesPerSecond,
        etaSeconds,
        currentFile: null,
        ...(patch.currentFile !== undefined ? { currentFile: patch.currentFile } : {}),
      },
    });
  }

  private async downloadArtifact(artifact: DownloadArtifact, signal: AbortSignal): Promise<void> {
    const finalPath = artifact.destinationPath;
    const partPath = this.getPartPath(artifact.fileName);

    if (existsSync(finalPath)) {
      const existingSha = await this.computeSha256(finalPath);
      if (existingSha === artifact.expectedSha256) {
        if (existsSync(partPath)) {
          unlinkSync(partPath);
        }
        if (this.activeDownloadTask) {
          this.activeDownloadTask.downloadedBytes += artifact.expectedSizeBytes;
          this.updateDownloadProgress({ currentFile: artifact.fileName });
        }
        return;
      }
      unlinkSync(finalPath);
    }

    const existingPartBytes = existsSync(partPath) ? statSync(partPath).size : 0;
    const resumePreparation = resolveResumePreparation(existingPartBytes, artifact.expectedSizeBytes);
    if (resumePreparation.resetPart) {
      this.safeDeleteFile(partPath);
    }

    const headers: Record<string, string> = {};
    if (resumePreparation.rangeHeader) {
      headers.Range = resumePreparation.rangeHeader;
    }
    const response = await fetch(artifact.url, {
      method: 'GET',
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      signal,
    });
    if (isResumeNotSatisfiable(response.status)) {
      this.safeDeleteFile(partPath);
      throw new Error(`Failed to resume download for ${artifact.fileName}: HTTP 416`);
    }
    if (!response.ok && response.status !== 206) {
      throw new Error(`Failed to download ${artifact.fileName}: HTTP ${response.status}`);
    }

    const appendMode = response.status === 206 && resumePreparation.nextPartBytes > 0;
    const fileStream = createWriteStream(partPath, { flags: appendMode ? 'a' : 'w' });

    if (this.activeDownloadTask && appendMode) {
      this.activeDownloadTask.downloadedBytes += resumePreparation.nextPartBytes;
      this.updateDownloadProgress({ currentFile: artifact.fileName });
    }

    const body = response.body;
    if (!body) {
      throw new Error(`Download body is empty for ${artifact.fileName}`);
    }

    const reader = body.getReader();
    try {
      let doneReading = false;
      while (!doneReading) {
        const { done, value } = await reader.read();
        if (done) {
          doneReading = true;
          continue;
        }
        if (!value) continue;
        if (signal.aborted) {
          throw new Error('Download aborted');
        }
        fileStream.write(Buffer.from(value));
        if (this.activeDownloadTask) {
          this.activeDownloadTask.downloadedBytes += value.byteLength;
          this.updateDownloadProgress({ currentFile: artifact.fileName });
        }
      }
    } finally {
      fileStream.end();
      await finished(fileStream);
    }
  }

  private getPartPath(fileName: string): string {
    return path.join(this.downloadDir, `${fileName}.part`);
  }

  private async computeSha256(filePath: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  private cleanupCorruptedArtifact(artifact: DownloadArtifact): void {
    const partPath = this.getPartPath(artifact.fileName);
    for (const cleanupPath of resolveCorruptedArtifactCleanupPaths(partPath, artifact.destinationPath)) {
      this.safeDeleteFile(cleanupPath);
    }
  }

  private safeDeleteFile(filePath: string): void {
    if (!existsSync(filePath)) {
      return;
    }
    try {
      unlinkSync(filePath);
    } catch (error) {
      this.logger.warn(`Failed to delete file: ${filePath}, ${error}`);
    }
  }

  private safeDeleteManagedFile(filePath: string): void {
    if (!filePath.startsWith(this.modelRootDir)) {
      return;
    }
    if (!existsSync(filePath)) {
      return;
    }
    try {
      unlinkSync(filePath);
    } catch (error) {
      this.logger.warn(`Failed to delete managed model file: ${filePath}, ${error}`);
    }
  }
}
