/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { BrowserWindow, ipcMain, IpcMainInvokeEvent, shell } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { UpdateCapabilities } from '../../shared/types';
import { getUpdateCapabilities } from '../utils/distribution';
import { createLogger } from '../utils/logger';
import { checkForUpdates } from '../utils/updater';

const logger = createLogger('IPC:window');

export function registerWindowIpcHandlers(mainWindow: BrowserWindow): void {
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

  ipcMain.handle(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, async (_event: IpcMainInvokeEvent, url: string) => {
    logger.info('IPC: shell:open-external', { url });
    await shell.openExternal(url);
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async () => {
    logger.info('IPC: update:check');
    checkForUpdates(true);
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_GET_CAPABILITIES, async (): Promise<UpdateCapabilities> => {
    logger.debug('IPC: update:get-capabilities');
    return getUpdateCapabilities();
  });
}
