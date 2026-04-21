/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { app, BrowserWindow, protocol } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import inspector from 'node:inspector';
import started from 'electron-squirrel-startup';
import { initialize } from '@aptabase/electron/main';
import { registerIpcHandlers, setAuthManager, emitToRenderer } from './main/ipc-handlers';
import { createLogger, setMainWindow } from './main/utils/logger';
import { TalkToFigmaService, TalkToFigmaServerManager, TalkToFigmaTray } from './main/server';
import { trackAppStart, trackAppQuit, trackUserEngagement, trackFirstOpenIfNeeded, trackAppException, trackOAuthAction, APTABASE_APP_KEY, flushMCPToolSuccessBatch } from './main/analytics';
import { FigmaOAuthService } from './main/figma/oauth/FigmaOAuthService';
import { FigmaApiClient } from './main/figma/api/FigmaApiClient';
import { IPC_CHANNELS, STORE_KEYS } from './shared/constants';
import type { ServerState } from './shared/types';
import { getStore, saveFigmaUser, getFigmaUser } from './main/utils/store';
import { installStdioServer } from './main/utils/stdio-installer';
import { initializeUpdater } from './main/utils/updater';
import { createMenu } from './main/menu';
import { SseDetectionServer } from './main/server/SseDetectionServer';
import { AssistantRuntimeService } from './main/assistant';

// Declare Vite plugin globals
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const RENDERER_PROTOCOL = 'talktofigma-renderer';

protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
]);

// Initialize Aptabase before app is ready (must be before any app events)
initialize(APTABASE_APP_KEY);

const logger = createLogger('main');

// Global error handlers for crash reporting
process.on('uncaughtException', (error: Error) => {
  logger.error('Uncaught exception:', error);
  trackAppException(
    true, // fatal
    error.name || 'UnknownError',
    error.message?.substring(0, 150),
    'main',
    error.stack?.split('\n')[1]?.trim()?.substring(0, 180)
  );
});

process.on('unhandledRejection', (reason: unknown) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.error('Unhandled rejection:', error);
  trackAppException(
    false, // non-fatal
    'UnhandledRejection',
    error.message?.substring(0, 150),
    'main',
    error.stack?.split('\n')[1]?.trim()?.substring(0, 180)
  );
});

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let tray: TalkToFigmaTray | null = null;
let serverManager: TalkToFigmaServerManager | null = null;
let service: TalkToFigmaService | null = null;
let rendererProtocolRegistered = false;

const getRendererRoot = () => path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`);

const getPackagedRendererUrl = () => `${RENDERER_PROTOCOL}://renderer/index.html`;

const getContentType = (filePath: string) => {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.svg':
      return 'image/svg+xml';
    case '.ico':
      return 'image/x-icon';
    case '.icns':
      return 'image/icns';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
};

const registerRendererProtocol = () => {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL || rendererProtocolRegistered) {
    return;
  }

  const rendererRoot = getRendererRoot();

  protocol.handle(RENDERER_PROTOCOL, async (request) => {
    const requestUrl = new URL(request.url);
    const requestedPath = decodeURIComponent(requestUrl.pathname);
    const relativePath = requestedPath === '/' || requestedPath === ''
      ? 'index.html'
      : requestedPath.replace(/^\/+/, '');
    const filePath = path.join(rendererRoot, relativePath);
    const relativeToRoot = path.relative(rendererRoot, filePath);

    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      return new Response('Not found', { status: 404 });
    }

    try {
      const file = await fs.readFile(filePath);
      return new Response(file, {
        headers: {
          'content-type': getContentType(filePath),
        },
      });
    } catch (error) {
      logger.error(`Renderer asset not found: ${filePath}`, error);
      return new Response('Not found', { status: 404 });
    }
  });

  rendererProtocolRegistered = true;
  logger.info(`Renderer protocol registered for: ${rendererRoot}`);
};

const loadRenderer = (window: BrowserWindow) => {
  const rendererUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL || getPackagedRendererUrl();
  logger.info(`Loading renderer: ${rendererUrl}`);
  return window.loadURL(rendererUrl);
};

const createWindow = () => {
  logger.info('Creating main window');
  
  // Create the main browser window (sidebar layout)
  mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    minWidth: 700,
    minHeight: 500,
    frame: true,               // Standard window frame
    transparent: false,         // Opaque window
    alwaysOnTop: false,        // Normal window behavior
    resizable: true,           // Allow resize
    skipTaskbar: false,        // Show in taskbar
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Center window on screen
  mainWindow.center();

  // Renderer lifecycle diagnostics (critical for packaged/TestFlight blank-screen debugging)
  let rendererDomReady = false;

  mainWindow.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      logger.info(`Renderer did-start-navigation: ${url}`);
    }
  });

  mainWindow.webContents.on('dom-ready', () => {
    rendererDomReady = true;
    logger.info(`Renderer dom-ready: ${mainWindow?.webContents.getURL() || 'unknown'}`);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    logger.info(`Renderer did-finish-load: ${mainWindow?.webContents.getURL() || 'unknown'}`);
  });

  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      logger.error(
        `Renderer did-fail-load: code=${errorCode}, description=${errorDescription}, url=${validatedURL}, mainFrame=${isMainFrame}`
      );
    }
  );

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const trimmedMessage = message.length > 500 ? `${message.slice(0, 500)}...` : message;
    logger.info(`Renderer console[${level}] ${sourceId}:${line} ${trimmedMessage}`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error(
      `Renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}`
    );
  });

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    logger.error(
      `Preload error: path=${preloadPath}, message=${error?.message || 'unknown'}`
    );
  });

  mainWindow.on('unresponsive', () => {
    logger.warn('Main window became unresponsive');
  });

  mainWindow.on('responsive', () => {
    logger.info('Main window responsive again');
  });

  loadRenderer(mainWindow).catch((error) => {
    logger.error(`Renderer load failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed() || rendererDomReady) {
      return;
    }

    logger.warn(
      `Renderer did not reach dom-ready after 10s; currentURL=${mainWindow.webContents.getURL() || 'empty'}, loading=${mainWindow.webContents.isLoading()}. Retrying renderer load.`
    );
    mainWindow.webContents.stop();
    loadRenderer(mainWindow).catch((error) => {
      logger.error(`Renderer retry failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 10_000);

  // Register IPC handlers
  registerIpcHandlers(mainWindow);

  // Set mainWindow reference for logger to emit logs
  setMainWindow(mainWindow);

  // Create application menu
  createMenu(mainWindow);

  logger.info('Main window created successfully');
};

const createTray = () => {
  logger.info('Creating system tray');

  if (!serverManager) {
    logger.error('Cannot create tray: serverManager not initialized');
    return;
  }

  tray = new TalkToFigmaTray(serverManager);
  tray.create();

  logger.info('System tray created');
};

const initializeServers = (window: BrowserWindow) => {
  logger.info('Initializing TalkToFigma servers...');

  // Initialize server manager
  serverManager = TalkToFigmaServerManager.getInstance();

  // Initialize service (singleton pattern)
  service = TalkToFigmaService.getInstance();

  // Helper to emit status changes to renderer
  const emitStatusChange = () => {
    // Safety check: ensure window is still valid
    if (!window || window.isDestroyed()) {
      logger.warn('Cannot emit status change: window is destroyed');
      return;
    }

    const result = service!.getStatus();
    if (result.success && result.status) {
      const figmaState = result.status;
      const status: ServerState = {
        websocket: {
          status: figmaState.websocket.running ? 'running' : 'stopped',
          port: figmaState.websocket.port,
          connectedClients: figmaState.websocket.clientCount || 0,
        },
        mcp: {
          status: 'running', // stdio mode is always available when app is running
          transport: 'stdio',
        },
        operationInProgress: false,
        lastError: null,
      };
      emitToRenderer(window, IPC_CHANNELS.SERVER_STATUS_CHANGED, status);
    }
  };

  // Register callback to emit status changes when service notifies
  // This is the single source of truth for status updates
  service.setTrayUpdateCallback(() => {
    emitStatusChange();
  });

  // Register callback to update menu when server status changes
  service.setMenuUpdateCallback(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      createMenu(mainWindow);
    }
  });

  // Create auth manager adapter
  const authManagerAdapter = {
    startOAuth: async () => {
      // Track OAuth start
      trackOAuthAction('start');
      try {
        const oauthService = new FigmaOAuthService();
        await oauthService.authenticate();

        // Track OAuth success
        trackOAuthAction('success');

        // Tokens are already saved by authenticate()
        // Now fetch user info
        const apiClient = await FigmaApiClient.create();
        if (apiClient) {
          const userResult = await apiClient.getCurrentUser();
          if (userResult.success && userResult.data) {
            // Save user info using helper function
            saveFigmaUser({
              id: userResult.data.id,
              email: userResult.data.email,
              handle: userResult.data.handle,
              imgUrl: userResult.data.img_url,
            });

            // Emit auth status change to renderer with user info
            emitToRenderer(window, IPC_CHANNELS.AUTH_STATUS_CHANGED, {
              isAuthenticated: true,
              user: {
                id: userResult.data.id,
                email: userResult.data.email,
                handle: userResult.data.handle,
                imgUrl: userResult.data.img_url,
              },
              tokens: null,
              fileKey: null,
              fileUrl: null,
            });
          }
        }
      } catch (error) {
        // Track OAuth error
        trackOAuthAction('error');
        logger.error('OAuth authentication failed:', error);
        throw error;
      }
    },
    logout: async () => {
      // Track OAuth logout
      trackOAuthAction('logout');

      // Clear tokens and user info using service method
      FigmaOAuthService.clearTokens();

      // Emit auth status change to renderer
      emitToRenderer(window, IPC_CHANNELS.AUTH_STATUS_CHANGED, {
        isAuthenticated: false,
        user: null,
        tokens: null,
        fileKey: null,
        fileUrl: null,
      });
    },
    getStatus: () => {
      const store = getStore();
      const accessToken = store.get(STORE_KEYS.FIGMA_ACCESS_TOKEN);
      const expiresAt = store.get(STORE_KEYS.FIGMA_TOKEN_EXPIRES_AT) || 0;
      const user = getFigmaUser();

      return {
        isAuthenticated: !!accessToken && expiresAt > Date.now(),
        user: user || null,
        tokens: null, // Don't expose tokens
        fileKey: null,
        fileUrl: null,
      };
    },
  };

  setAuthManager(authManagerAdapter);

  // Emit initial auth status on startup
  const initialAuthStatus = authManagerAdapter.getStatus();
  emitToRenderer(window, IPC_CHANNELS.AUTH_STATUS_CHANGED, initialAuthStatus);
  if (initialAuthStatus.isAuthenticated && initialAuthStatus.user) {
    logger.info(`Restored auth session for user: ${initialAuthStatus.user.handle}`);
  }

  logger.info('TalkToFigma servers initialized');
};

// App ready
app.on('ready', async () => {
  logger.info('App ready, initializing...');

  registerRendererProtocol();

  // Track app start and user engagement (Kotlin-compatible)
  trackAppStart();
  trackUserEngagement();
  trackFirstOpenIfNeeded();

  // Install stdio server to Application Support and create symlink
  logger.info('Installing MCP stdio server...');
  const installResult = await installStdioServer();
  if (installResult.success) {
    logger.info(`✅ MCP stdio server installed at: ${installResult.path}`);
  } else {
    logger.error(`❌ Failed to install MCP stdio server: ${installResult.error}`);
  }

  // Initialize auto-updater (production only)
  // KleverDesktop style: direct call, no setImmediate wrapper needed
  initializeUpdater();

  createWindow();

  // Initialize servers after window is created
  if (mainWindow) {
    initializeServers(mainWindow);
    createTray();
  }

  // Start SSE detection server — listens on port 3056 for 60s to detect legacy clients
  if (mainWindow) {
    const sseDetection = new SseDetectionServer(() => {
      emitToRenderer(mainWindow!, IPC_CHANNELS.SSE_CLIENT_DETECTED, {});
      sseDetection.stop();
    });
    sseDetection.start().then(() => {
      setTimeout(() => sseDetection.stop(), 60_000);
    });
  }

  // Auto-start servers in development
  if (process.env.NODE_ENV === 'development') {
    try {
      logger.info('Auto-starting servers in development mode...');
      await service?.startAll({ showNotification: false });
    } catch (error) {
      logger.error('Failed to auto-start servers:', { error });
    }
  }
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    logger.info('All windows closed, quitting app');
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Graceful shutdown
app.on('before-quit', async () => {
  logger.info('App shutting down...');

  // Flush buffered MCP success analytics before app shutdown.
  try {
    flushMCPToolSuccessBatch('app_quit');
  } catch (error) {
    logger.warn('Failed to flush MCP success batch on before-quit:', { error });
  }

  // Track app quit
  trackAppQuit();

  // Stop assistant runtime before shutting down app services so spawned llama-server exits.
  try {
    await AssistantRuntimeService.shutdownIfInitialized();
  } catch (error) {
    logger.error('Error shutting down assistant runtime:', { error });
  }

  // Stop servers gracefully
  try {
    await service?.stopAll({ showNotification: false });
  } catch (error) {
    logger.error('Error stopping servers:', { error });
  }

  // Close all windows and their DevTools explicitly
  // This helps prevent inspector socket hang on MAS builds
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

  // Close Node.js inspector to prevent InspectorSocket::Shutdown hang
  // This is especially important for MAS sandbox builds
  try {
    inspector.close();
    logger.info('Inspector closed');
  } catch {
    // Inspector may not be active, ignore
  }

  // Destroy tray
  tray?.destroy();

  logger.info('App shutdown complete');
});

app.on('will-quit', () => {
  // Best-effort second flush in case before-quit flow was interrupted.
  try {
    flushMCPToolSuccessBatch('app_quit');
  } catch (error) {
    logger.warn('Failed to flush MCP success batch on will-quit:', { error });
  }
});
