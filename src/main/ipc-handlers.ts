/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { ipcMain, BrowserWindow, shell, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../shared/constants';
import { createLogger } from './utils/logger';
import * as storeUtils from './utils/store';
import type {
  AssistantRunEvent,
  FigmaAuthState,
  AssistantRuntimeStatus,
  ServerState,
  ToolApprovalRequest,
  UpdateCapabilities,
} from '../shared/types';
import { registerMcpConfigHandlers } from './handlers/mcp-config-handler';
import { trackTutorialAction, trackThemeChange, trackPageView, trackServerAction } from './analytics';
import { checkForUpdates } from './utils/updater';
import { getUpdateCapabilities } from './utils/distribution';
import { TalkToFigmaService } from './server/TalkToFigmaService';
import { AssistantRuntimeService } from './assistant';

const logger = createLogger('IPC');

// Auth manager (set by main.ts after initialization)
let authManager: {
  startOAuth: () => Promise<void>;
  logout: () => Promise<void>;
  getStatus: () => FigmaAuthState;
} | null = null;

export function setAuthManager(manager: typeof authManager): void {
  authManager = manager;
}

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  logger.info('Registering IPC handlers');
  const assistantRuntime = AssistantRuntimeService.getInstance();

  assistantRuntime.setEventHandlers({
    onRunEvent: (event: AssistantRunEvent) => {
      emitToRenderer(mainWindow, IPC_CHANNELS.ASSISTANT_RUN_EVENT, event);
    },
    onToolApprovalRequired: (request: ToolApprovalRequest) => {
      emitToRenderer(mainWindow, IPC_CHANNELS.ASSISTANT_TOOL_APPROVAL_REQUIRED, request);
    },
    onRuntimeStatusChanged: (status: AssistantRuntimeStatus) => {
      emitToRenderer(mainWindow, IPC_CHANNELS.ASSISTANT_RUNTIME_STATUS_CHANGED, status);
    },
  });

  // ===== Server Control =====
  ipcMain.handle(IPC_CHANNELS.SERVER_START, async () => {
    logger.info('IPC: server:start');
    const service = TalkToFigmaService.getInstance();
    const startTime = Date.now();
    const result = await service.startAll({ showNotification: false });
    if (!result.success) {
      trackServerAction('start', 'all', 3055, undefined, false, result.error);
      throw new Error(result.error || 'Failed to start servers');
    }
    trackServerAction('start', 'all', 3055, Date.now() - startTime, true);
  });

  ipcMain.handle(IPC_CHANNELS.SERVER_STOP, async () => {
    logger.info('IPC: server:stop');
    const service = TalkToFigmaService.getInstance();
    const result = await service.stopAll({ showNotification: false });
    if (!result.success) {
      trackServerAction('stop', 'all', 3055, undefined, false, result.error);
      throw new Error(result.error || 'Failed to stop servers');
    }
    trackServerAction('stop', 'all', 3055, undefined, true);
  });

  ipcMain.handle(IPC_CHANNELS.SERVER_RESTART, async () => {
    logger.info('IPC: server:restart');
    const service = TalkToFigmaService.getInstance();
    await service.stopAll({ showNotification: false });
    await new Promise(resolve => setTimeout(resolve, 1000));
    const result = await service.startAll({ showNotification: false });
    if (!result.success) {
      trackServerAction('restart', 'all', 3055, undefined, false, result.error);
      throw new Error(result.error || 'Failed to restart servers');
    }
    trackServerAction('restart', 'all', 3055, undefined, true);
  });

  ipcMain.handle(IPC_CHANNELS.SERVER_GET_STATUS, async () => {
    const service = TalkToFigmaService.getInstance();
    const result = service.getStatus();
    if (result.success && result.status) {
      const figmaState = result.status;
      return {
        websocket: {
          status: figmaState.websocket.running ? 'running' : 'stopped',
          port: figmaState.websocket.port,
          connectedClients: figmaState.websocket.clientCount || 0,
          mcpClientCount: figmaState.websocket.mcpClientCount,
          figmaClientCount: figmaState.websocket.figmaClientCount,
        },
        mcp: {
          status: 'running',
          transport: 'stdio',
        },
        operationInProgress: false,
        lastError: null,
      } as ServerState;
    }
    return {
      websocket: { status: 'stopped', port: 3055, connectedClients: 0 },
      mcp: { status: 'stopped', port: 3056 },
      operationInProgress: false,
      lastError: result.error || null,
    } as ServerState;
  });

  // ===== Authentication =====
  ipcMain.handle(IPC_CHANNELS.AUTH_START_OAUTH, async () => {
    logger.info('IPC: auth:start-oauth');
    if (!authManager) {
      throw new Error('Auth manager not initialized');
    }
    await authManager.startOAuth();
  });

  ipcMain.handle(IPC_CHANNELS.AUTH_LOGOUT, async () => {
    logger.info('IPC: auth:logout');
    storeUtils.clearFigmaTokens();
    storeUtils.clearFigmaUser();
    if (authManager) {
      await authManager.logout();
    }
  });

  ipcMain.handle(IPC_CHANNELS.AUTH_GET_STATUS, async (): Promise<FigmaAuthState> => {
    logger.debug('IPC: auth:get-status');
    const tokens = storeUtils.getFigmaTokens();
    const user = storeUtils.getFigmaUser();
    const fileInfo = storeUtils.getFigmaFileKey();

    return {
      isAuthenticated: !!tokens && tokens.expiresAt > Date.now(),
      user,
      tokens,
      fileKey: fileInfo?.key ?? null,
      fileUrl: fileInfo?.url ?? null,
    };
  });

  ipcMain.handle(IPC_CHANNELS.AUTH_SET_FILE_KEY, async (_event: IpcMainInvokeEvent, fileKey: string) => {
    logger.info('IPC: auth:set-file-key', { fileKey });
    storeUtils.setFigmaFileKey(fileKey);
  });

  // ===== Settings =====
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async (_event: IpcMainInvokeEvent, key: string) => {
    logger.debug('IPC: settings:get', { key });
    return storeUtils.getSetting(key) ?? null;
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, async (_event: IpcMainInvokeEvent, key: string, value: unknown) => {
    logger.debug('IPC: settings:set', { key, value });
    storeUtils.setSetting(key, value);
  });

  // ===== Window Control =====
  ipcMain.handle(IPC_CHANNELS.WINDOW_RESIZE, async (_event: IpcMainInvokeEvent, width: number, height: number) => {
    logger.debug('IPC: window:resize', { width, height });
    const bounds = mainWindow.getBounds();
    const xDiff = Math.floor((width - bounds.width) / 2);
    mainWindow.setBounds({
      x: bounds.x - xDiff,
      y: bounds.y,
      width,
      height,
    }, false);
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_HIDE, async () => {
    logger.debug('IPC: window:hide');
    mainWindow.hide();
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_SHOW, async () => {
    logger.debug('IPC: window:show');
    mainWindow.show();
  });

  // ===== Shell =====
  ipcMain.handle(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, async (_event: IpcMainInvokeEvent, url: string) => {
    logger.info('IPC: shell:open-external', { url });
    await shell.openExternal(url);
  });

  // ===== MCP Configuration =====
  registerMcpConfigHandlers();

  // ===== Analytics (Renderer → Main) =====
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_TRACK, async (
    _event: IpcMainInvokeEvent,
    eventType: string,
    properties?: Record<string, string | number | boolean>
  ) => {
    logger.debug('IPC: analytics:track', { eventType });

    switch (eventType) {
      case 'tutorial':
        if (properties?.action) {
          trackTutorialAction(properties.action as 'shown' | 'completed' | 'skipped');
        }
        break;
      case 'theme':
        if (properties?.theme) {
          trackThemeChange(properties.theme as 'light' | 'dark' | 'system');
        }
        break;
      case 'pageView':
        if (properties?.title && properties?.location) {
          trackPageView(
            String(properties.title),
            String(properties.location),
            properties.path ? String(properties.path) : undefined
          );
        }
        break;
      default:
        logger.warn(`Unknown analytics event type: ${eventType}`);
    }
  });

  // ===== Updates =====
  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async () => {
    logger.info('IPC: update:check');
    checkForUpdates(true);
  });
  ipcMain.handle(IPC_CHANNELS.UPDATE_GET_CAPABILITIES, async (): Promise<UpdateCapabilities> => {
    logger.debug('IPC: update:get-capabilities');
    return getUpdateCapabilities();
  });

  // ===== Assistant =====
  ipcMain.handle(IPC_CHANNELS.ASSISTANT_GET_RUNTIME_STATUS, async (_event: IpcMainInvokeEvent, threadId?: string) => {
    return assistantRuntime.getRuntimeStatus(threadId);
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_LIST_MODELS, async () => {
    return assistantRuntime.listModels();
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_LIST_MODEL_CATALOG, async () => {
    return assistantRuntime.listModelCatalog();
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_DOWNLOAD_MODEL, async (_event: IpcMainInvokeEvent, modelId: string) => {
    return assistantRuntime.downloadModel(modelId);
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_CANCEL_MODEL_DOWNLOAD, async () => {
    return assistantRuntime.cancelModelDownload();
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_UPLOAD_MODEL, async (_event: IpcMainInvokeEvent, payload: {
    ggufPath: string;
    mmprojPath?: string;
    displayName?: string;
  }) => {
    return assistantRuntime.uploadModel(payload);
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_DELETE_MODEL, async (_event: IpcMainInvokeEvent, modelId: string) => {
    return assistantRuntime.deleteModel(modelId);
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_SET_ACTIVE_MODEL, async (_event: IpcMainInvokeEvent, threadId: string, model: string) => {
    return assistantRuntime.setActiveModel(threadId, model);
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_CREATE_THREAD, async (_event: IpcMainInvokeEvent, title?: string) => {
    return assistantRuntime.createThread(title);
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_LIST_THREADS, async () => {
    return assistantRuntime.listThreads();
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_GET_THREAD, async (_event: IpcMainInvokeEvent, threadId: string) => {
    return assistantRuntime.getThread(threadId);
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_DELETE_THREAD, async (_event: IpcMainInvokeEvent, threadId: string) => {
    return assistantRuntime.deleteThread(threadId);
  });

  ipcMain.handle(
    IPC_CHANNELS.ASSISTANT_SEND_MESSAGE,
    async (_event: IpcMainInvokeEvent, threadId: string, text: string, attachments = []) => {
      return assistantRuntime.sendMessage(threadId, text, attachments);
    },
  );

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_CANCEL_RUN, async (_event: IpcMainInvokeEvent, runId: string) => {
    return assistantRuntime.cancelRun(runId);
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_APPROVE_TOOL_CALL, async (_event: IpcMainInvokeEvent, runId: string, toolCallId: string) => {
    return assistantRuntime.approveToolCall(runId, toolCallId);
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_REJECT_TOOL_CALL, async (_event: IpcMainInvokeEvent, runId: string, toolCallId: string) => {
    return assistantRuntime.rejectToolCall(runId, toolCallId);
  });

  logger.info('IPC handlers registered successfully');
}

// Helper to emit events to renderer
export function emitToRenderer(mainWindow: BrowserWindow, channel: string, data: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const webContents = mainWindow.webContents;
  if (!webContents || webContents.isDestroyed() || webContents.isCrashed()) {
    return;
  }

  const mainFrame = webContents.mainFrame;
  if (!mainFrame || mainFrame.isDestroyed()) {
    return;
  }

  try {
    webContents.send(channel, data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes('Render frame was disposed before WebFrameMain could be accessed')
      || message.includes('Object has been destroyed')
    ) {
      return;
    }
    logger.warn(`Failed to emit IPC event "${channel}"`, { error: message });
  }
}
