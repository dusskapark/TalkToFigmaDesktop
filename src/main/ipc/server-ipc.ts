/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { ServerState } from '../../shared/types';
import { trackServerAction } from '../analytics';
import { TalkToFigmaService } from '../server/TalkToFigmaService';
import { createLogger } from '../utils/logger';
import { toRendererServerState } from '../bootstrap/server-state-mapper';

const logger = createLogger('IPC:server');

export function registerServerIpcHandlers(): void {
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
      return toRendererServerState(result.status);
    }
    return {
      websocket: { status: 'stopped', port: 3055, connectedClients: 0 },
      mcp: { status: 'stopped', port: 3056 },
      operationInProgress: false,
      lastError: result.error || null,
    } as ServerState;
  });
}
