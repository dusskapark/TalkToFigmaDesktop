/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

export type AssistantRole = 'user' | 'assistant' | 'system';
export type AssistantToolSafety = 'read' | 'write';
export type AssistantRunFinishReason = 'completed' | 'max-steps' | 'cancelled' | 'error';

export interface AssistantMessagePartText {
  type: 'text';
  text: string;
}

export interface AssistantMessagePartAttachment {
  type: 'attachment';
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  imageBase64?: string;
  textContent?: string;
  truncated?: boolean;
}

export type AssistantToolPartState =
  | 'input-streaming'
  | 'input-available'
  | 'output-available'
  | 'output-error';

export interface AssistantMessagePartTool {
  type: `tool-${string}`;
  state: AssistantToolPartState;
  toolCallId?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  errorText?: string;
  safety?: AssistantToolSafety;
}

export type AssistantMessagePart =
  | AssistantMessagePartText
  | AssistantMessagePartAttachment
  | AssistantMessagePartTool;

export interface AssistantMessage {
  id: string;
  threadId: string;
  role: AssistantRole;
  parts: AssistantMessagePart[];
  createdAt: number;
}

export interface AssistantThread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  activeModel: string | null;
}

export interface AssistantRunLog {
  runId: string;
  threadId: string;
  finishReason: AssistantRunFinishReason;
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    safety: AssistantToolSafety;
    approved?: boolean;
    ok?: boolean;
  }>;
  createdAt: number;
}

export type AssistantRunEvent =
  | { type: 'run-start'; runId: string; threadId: string }
  | { type: 'token'; runId: string; textDelta: string }
  | { type: 'tool-part'; runId: string; part: AssistantMessagePartTool & { toolCallId: string } }
  | { type: 'run-end'; runId: string; finishReason: AssistantRunFinishReason; messageId?: string; error?: string };

export interface ToolApprovalRequest {
  runId: string;
  threadId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  safety: AssistantToolSafety;
  requestedAt: number;
}

export type AssistantRuntimeHealth = 'starting' | 'ready' | 'error';
export type AssistantRuntimeBackend = 'embedded' | 'ollama';
export type AssistantModelDownloadState = 'idle' | 'downloading' | 'verifying' | 'completed' | 'failed';

export interface AssistantModelDownloadProgress {
  stage: 'downloading' | 'verifying';
  downloadedBytes: number;
  totalBytes: number;
  speedBytesPerSecond: number;
  etaSeconds: number | null;
  currentFile: string | null;
}

export interface AssistantModelCatalogItem {
  id: string;
  displayName: string;
  version: string;
  recommended: boolean;
  supportsVision: boolean;
  source: 'huggingface';
  modelFileName: string;
  modelUrl: string;
  modelSha256: string;
  modelSizeBytes: number;
  mmprojFileName?: string;
  mmprojUrl?: string;
  mmprojSha256?: string;
  mmprojSizeBytes?: number;
}

export interface AssistantInstalledModel {
  id: string;
  displayName: string;
  version: string;
  source: 'download' | 'upload' | 'ollama';
  supportsVision: boolean;
  modelPath: string;
  modelSha256: string;
  modelSizeBytes: number;
  mmprojPath?: string;
  mmprojSha256?: string;
  mmprojSizeBytes?: number;
  installedAt: number;
}

export interface AssistantRuntimeStatus {
  backend: AssistantRuntimeBackend;
  health: AssistantRuntimeHealth;
  modelInstalled: boolean;
  runtimeBinaryReady: boolean;
  runtimeBinarySource: 'bundled' | 'missing' | 'external';
  runtimeBinaryPath?: string;
  daemonReachable?: boolean;
  baseUrl?: string;
  activeModel: string | null;
  installedModels: string[];
  installedModelDetails: AssistantInstalledModel[];
  defaultModel: 'gemma4:e4b';
  recommendedModel: AssistantModelCatalogItem;
  supportsVision: boolean;
  downloadState: AssistantModelDownloadState;
  downloadProgress?: AssistantModelDownloadProgress;
  error?: string;
}

export interface AssistantModelUploadRequest {
  ggufPath: string;
  mmprojPath?: string;
  displayName?: string;
}

/** @deprecated kept for temporary compatibility while migrating old imports */
export type OllamaRuntimeStatus = AssistantRuntimeStatus;
