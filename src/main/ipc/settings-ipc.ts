/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, STORE_KEYS } from '../../shared/constants';
import { createLogger } from '../utils/logger';
import { TalkToFigmaService } from '../server/TalkToFigmaService';
import * as storeUtils from '../utils/store';

const logger = createLogger('IPC:settings');

export function registerSettingsIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async (_event: IpcMainInvokeEvent, key: string) => {
    logger.debug('IPC: settings:get', { key });
    return storeUtils.getSetting(key) ?? null;
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, async (_event: IpcMainInvokeEvent, key: string, value: unknown) => {
    logger.debug('IPC: settings:set', { key, value });
    storeUtils.setSetting(key, value);

    if (key === STORE_KEYS.APP_LOCALE) {
      TalkToFigmaService.getInstance().refreshNativeUi();
    }
  });
}
