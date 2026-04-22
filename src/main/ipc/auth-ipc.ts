/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { FigmaAuthState } from '../../shared/types';
import { createLogger } from '../utils/logger';
import * as storeUtils from '../utils/store';

const logger = createLogger('IPC:auth');

export interface AuthManager {
  startOAuth: () => Promise<void>;
  logout: () => Promise<void>;
  getStatus: () => FigmaAuthState;
}

export function registerAuthIpcHandlers(getAuthManager: () => AuthManager | null): void {
  ipcMain.handle(IPC_CHANNELS.AUTH_START_OAUTH, async () => {
    logger.info('IPC: auth:start-oauth');
    const authManager = getAuthManager();
    if (!authManager) {
      throw new Error('Auth manager not initialized');
    }
    await authManager.startOAuth();
  });

  ipcMain.handle(IPC_CHANNELS.AUTH_LOGOUT, async () => {
    logger.info('IPC: auth:logout');
    storeUtils.clearFigmaTokens();
    storeUtils.clearFigmaUser();
    const authManager = getAuthManager();
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
}
