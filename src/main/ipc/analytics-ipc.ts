/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import { trackTutorialAction, trackThemeChange, trackPageView } from '../analytics';
import { createLogger } from '../utils/logger';

const logger = createLogger('IPC:analytics');

export function registerAnalyticsIpcHandlers(): void {
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
}
