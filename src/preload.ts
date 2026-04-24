/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '@/shared/constants';
import type { ElectronAPI, ServerState, FigmaAuthState, MainToRendererEvents, LogEntry } from '@/shared/types';

// Helper to create event listener with cleanup
function createEventListener<T>(channel: string) {
  return (callback: (data: T) => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: T) => callback(data);
    ipcRenderer.on(channel, handler);
    // Return cleanup function
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  };
}

const electronAPI: ElectronAPI = {
  server: {
    start: () => ipcRenderer.invoke(IPC_CHANNELS.SERVER_START),
    stop: () => ipcRenderer.invoke(IPC_CHANNELS.SERVER_STOP),
    restart: () => ipcRenderer.invoke(IPC_CHANNELS.SERVER_RESTART),
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SERVER_GET_STATUS) as Promise<ServerState>,
    onStatusChanged: createEventListener<ServerState>(IPC_CHANNELS.SERVER_STATUS_CHANGED),
  },

  figma: {
    startOAuth: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_START_OAUTH),
    logout: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_LOGOUT),
    getAuthStatus: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_GET_STATUS) as Promise<FigmaAuthState>,
    setFileKey: (key: string) => ipcRenderer.invoke(IPC_CHANNELS.AUTH_SET_FILE_KEY, key),
    onConnectionChanged: createEventListener<MainToRendererEvents['figma:connection-changed']>(
      IPC_CHANNELS.FIGMA_CONNECTION_CHANGED
    ),
    onProgressUpdate: createEventListener<MainToRendererEvents['figma:progress-update']>(
      IPC_CHANNELS.FIGMA_PROGRESS_UPDATE
    ),
  },

  auth: {
    onStatusChanged: createEventListener<MainToRendererEvents['auth:status-changed']>(
      IPC_CHANNELS.AUTH_STATUS_CHANGED
    ),
  },

  settings: {
    get: <T>(key: string) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET, key) as Promise<T | null>,
    set: <T>(key: string, value: T) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, key, value),
  },

  window: {
    resize: (width: number, height: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_RESIZE, width, height),
    hide: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_HIDE),
    show: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SHOW),
  },

  shell: {
    openExternal: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, url),
  },

  log: {
    onEntry: createEventListener<LogEntry>(IPC_CHANNELS.LOG_ENTRY),
  },

  tray: {
    onNavigateToPage: createEventListener<MainToRendererEvents['tray:navigate-to-page']>('tray:navigate-to-page'),
  },

  mcp: {
    detectConfig: (clientId: string) => ipcRenderer.invoke(IPC_CHANNELS.MCP_DETECT_CONFIG, clientId),
    autoConfig: (clientId: string) => ipcRenderer.invoke(IPC_CHANNELS.MCP_AUTO_CONFIGURE, clientId),
    openConfigFolder: (clientId: string) => ipcRenderer.invoke(IPC_CHANNELS.MCP_OPEN_CONFIG_FOLDER, clientId),
    restoreBackup: (clientId: string) => ipcRenderer.invoke(IPC_CHANNELS.MCP_RESTORE_BACKUP, clientId),
    getStdioPath: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_STDIO_PATH) as Promise<string>,
    getStdioConfig: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_STDIO_CONFIG) as Promise<{ config: object; command: string; path: string }>,
  },

  analytics: {
    track: (eventType: string, properties?: Record<string, string | number | boolean>) =>
      ipcRenderer.invoke(IPC_CHANNELS.ANALYTICS_TRACK, eventType, properties),
  },

  update: {
    check: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CHECK),
    getCapabilities: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_GET_CAPABILITIES),
  },

  sse: {
    onClientDetected: createEventListener<Record<string, never>>(IPC_CHANNELS.SSE_CLIENT_DETECTED),
  },

  assistant: {
    getRuntimeStatus: (threadId?: string) => ipcRenderer.invoke(IPC_CHANNELS.ASSISTANT_GET_RUNTIME_STATUS, threadId),
    listModels: () => ipcRenderer.invoke(IPC_CHANNELS.ASSISTANT_LIST_MODELS),
    listModelCatalog: () => ipcRenderer.invoke(IPC_CHANNELS.ASSISTANT_LIST_MODEL_CATALOG),
    downloadModel: (modelId: string) => ipcRenderer.invoke(IPC_CHANNELS.ASSISTANT_DOWNLOAD_MODEL, modelId),
    cancelModelDownload: () => ipcRenderer.invoke(IPC_CHANNELS.ASSISTANT_CANCEL_MODEL_DOWNLOAD),
    uploadModel: (payload) => ipcRenderer.invoke(IPC_CHANNELS.ASSISTANT_UPLOAD_MODEL, payload),
    deleteModel: (modelId: string) => ipcRenderer.invoke(IPC_CHANNELS.ASSISTANT_DELETE_MODEL, modelId),
    setRuntimeBackend: (backend) => ipcRenderer.invoke(IPC_CHANNELS.ASSISTANT_SET_RUNTIME_BACKEND, backend),
    setActiveModel: (threadId: string, model: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.ASSISTANT_SET_ACTIVE_MODEL, threadId, model),
    createThread: (title?: string) => ipcRenderer.invoke(IPC_CHANNELS.ASSISTANT_CREATE_THREAD, title),
    listThreads: () => ipcRenderer.invoke(IPC_CHANNELS.ASSISTANT_LIST_THREADS),
    getThread: (threadId: string) => ipcRenderer.invoke(IPC_CHANNELS.ASSISTANT_GET_THREAD, threadId),
    deleteThread: (threadId: string) => ipcRenderer.invoke(IPC_CHANNELS.ASSISTANT_DELETE_THREAD, threadId),
    sendMessage: (threadId: string, text: string, attachments = []) =>
      ipcRenderer.invoke(IPC_CHANNELS.ASSISTANT_SEND_MESSAGE, threadId, text, attachments),
    cancelRun: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.ASSISTANT_CANCEL_RUN, runId),
    approveToolCall: (runId: string, toolCallId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.ASSISTANT_APPROVE_TOOL_CALL, runId, toolCallId),
    rejectToolCall: (runId: string, toolCallId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.ASSISTANT_REJECT_TOOL_CALL, runId, toolCallId),
    onRuntimeStatusChanged: createEventListener(IPC_CHANNELS.ASSISTANT_RUNTIME_STATUS_CHANGED),
    onRunEvent: createEventListener(IPC_CHANNELS.ASSISTANT_RUN_EVENT),
    onToolApprovalRequired: createEventListener(IPC_CHANNELS.ASSISTANT_TOOL_APPROVAL_REQUIRED),
  },
};

// Expose API to renderer
contextBridge.exposeInMainWorld('electron', electronAPI);
