/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { BrowserWindow } from 'electron';

interface LoggerLike {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

interface CreateMainWindowOptions {
  preloadPath: string;
  logger: LoggerLike;
  loadRenderer: (window: BrowserWindow) => Promise<void>;
  registerIpcHandlers: (window: BrowserWindow) => void;
  setLoggerWindow: (window: BrowserWindow | null) => void;
  createMenu: (window: BrowserWindow) => void;
}

export function createMainWindow({
  preloadPath,
  logger,
  loadRenderer,
  registerIpcHandlers,
  setLoggerWindow,
  createMenu,
}: CreateMainWindowOptions): BrowserWindow {
  logger.info('Creating main window');

  const mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    minWidth: 700,
    minHeight: 500,
    frame: true,
    transparent: false,
    alwaysOnTop: false,
    resizable: true,
    skipTaskbar: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.center();
  attachRendererDiagnostics(mainWindow, logger, loadRenderer);
  registerIpcHandlers(mainWindow);
  setLoggerWindow(mainWindow);
  createMenu(mainWindow);

  logger.info('Main window created successfully');
  return mainWindow;
}

function attachRendererDiagnostics(
  window: BrowserWindow,
  logger: LoggerLike,
  loadRenderer: (window: BrowserWindow) => Promise<void>,
): void {
  let rendererDomReady = false;

  window.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      logger.info(`Renderer did-start-navigation: ${url}`);
    }
  });

  window.webContents.on('dom-ready', () => {
    rendererDomReady = true;
    logger.info(`Renderer dom-ready: ${window.webContents.getURL() || 'unknown'}`);
  });

  window.webContents.on('did-finish-load', () => {
    logger.info(`Renderer did-finish-load: ${window.webContents.getURL() || 'unknown'}`);
  });

  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      logger.error(
        `Renderer did-fail-load: code=${errorCode}, description=${errorDescription}, url=${validatedURL}, mainFrame=${isMainFrame}`
      );
    }
  );

  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const trimmedMessage = message.length > 500 ? `${message.slice(0, 500)}...` : message;
    logger.info(`Renderer console[${level}] ${sourceId}:${line} ${trimmedMessage}`);
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    logger.error(
      `Renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}`
    );
  });

  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    logger.error(
      `Preload error: path=${preloadPath}, message=${error?.message || 'unknown'}`
    );
  });

  window.on('unresponsive', () => {
    logger.warn('Main window became unresponsive');
  });

  window.on('responsive', () => {
    logger.info('Main window responsive again');
  });

  loadRenderer(window).catch((error) => {
    logger.error(`Renderer load failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  setTimeout(() => {
    if (window.isDestroyed() || rendererDomReady) {
      return;
    }

    logger.warn(
      `Renderer did not reach dom-ready after 10s; currentURL=${window.webContents.getURL() || 'empty'}, loading=${window.webContents.isLoading()}. Retrying renderer load.`
    );
    window.webContents.stop();
    loadRenderer(window).catch((error) => {
      logger.error(`Renderer retry failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 10_000);
}
