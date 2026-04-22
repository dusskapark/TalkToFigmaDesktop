/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { BrowserWindow } from 'electron';
import inspector from 'node:inspector';
import { AssistantRuntimeService } from '../assistant';
import type { MCPToolBatchFlushReason } from '../analytics/analytics-service';
import type { TalkToFigmaService, TalkToFigmaTray } from '../server';

interface LoggerLike {
  info: (message: string) => void;
  warn: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
}

export async function shutdownApp({
  logger,
  service,
  tray,
  flushMCPToolSuccessBatch,
  trackAppQuit,
}: {
  logger: LoggerLike;
  service: TalkToFigmaService | null;
  tray: TalkToFigmaTray | null;
  flushMCPToolSuccessBatch: (reason: MCPToolBatchFlushReason) => void;
  trackAppQuit: () => void;
}): Promise<void> {
  logger.info('App shutting down...');

  try {
    flushMCPToolSuccessBatch('app_quit');
  } catch (error) {
    logger.warn('Failed to flush MCP success batch on before-quit:', { error });
  }

  trackAppQuit();

  try {
    await AssistantRuntimeService.shutdownIfInitialized();
  } catch (error) {
    logger.error('Error shutting down assistant runtime:', { error });
  }

  try {
    await service?.stopAll({ showNotification: false });
  } catch (error) {
    logger.error('Error stopping servers:', { error });
  }

  closeWindows(logger);
  closeInspector(logger);
  tray?.destroy();

  logger.info('App shutdown complete');
}

function closeWindows(logger: LoggerLike): void {
  const windows = BrowserWindow.getAllWindows();
  for (const window of windows) {
    try {
      if (window.webContents && !window.webContents.isDestroyed()) {
        window.webContents.closeDevTools();
      }
      if (!window.isDestroyed()) {
        window.close();
      }
    } catch (error) {
      logger.error('Error closing window:', { error });
    }
  }
}

function closeInspector(logger: LoggerLike): void {
  try {
    inspector.close();
    logger.info('Inspector closed');
  } catch {
    // Inspector may not be active, ignore.
  }
}
