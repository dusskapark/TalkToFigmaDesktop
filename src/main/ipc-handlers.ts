/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { BrowserWindow } from 'electron';
import { createLogger } from './utils/logger';
import { registerMcpConfigHandlers } from './handlers/mcp-config-handler';
import { registerServerIpcHandlers } from './ipc/server-ipc';
import { registerAuthIpcHandlers, type AuthManager } from './ipc/auth-ipc';
import { registerSettingsIpcHandlers } from './ipc/settings-ipc';
import { registerWindowIpcHandlers } from './ipc/window-ipc';
import { registerAnalyticsIpcHandlers } from './ipc/analytics-ipc';
import { registerAssistantIpcHandlers } from './ipc/assistant-ipc';

const logger = createLogger('IPC');

let authManager: AuthManager | null = null;

export function setAuthManager(manager: AuthManager | null): void {
  authManager = manager;
}

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  logger.info('Registering IPC handlers');

  registerServerIpcHandlers();
  registerAuthIpcHandlers(() => authManager);
  registerSettingsIpcHandlers();
  registerWindowIpcHandlers(mainWindow);
  registerMcpConfigHandlers();
  registerAnalyticsIpcHandlers();
  registerAssistantIpcHandlers({
    mainWindow,
    emitToRenderer,
  });

  logger.info('IPC handlers registered successfully');
}

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
