/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { app, Menu, MenuItemConstructorOptions, shell, BrowserWindow } from 'electron';
import { checkForUpdates } from './utils/updater';
import { getUpdateCapabilities } from './utils/distribution';
import { TalkToFigmaServerManager } from './server/TalkToFigmaServerManager';
import { TalkToFigmaService } from './server/TalkToFigmaService';

/**
 * Create application menu
 * Based on Tray menu structure for consistency
 */
export function createMenu(mainWindow: BrowserWindow) {
  const isMac = process.platform === 'darwin';
  const { canCheckForUpdates } = getUpdateCapabilities();
  const serverManager = TalkToFigmaServerManager.getInstance();
  const service = TalkToFigmaService.getInstance();

  /**
   * Navigate to a specific page in the app
   */
  const showPage = (page: 'assistant' | 'terminal' | 'settings' | 'help') => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('tray:navigate-to-page', page);
    }
  };

  /**
   * Get current server status for dynamic menu items
   */
  const getServerStatus = () => {
    const status = serverManager.getStatus();
    return status.websocket.running;
  };

  const template: MenuItemConstructorOptions[] = [
    // App Menu (macOS only)
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            ...(canCheckForUpdates
              ? [
                  {
                    label: 'Check for Updates...',
                    click: () => {
                      checkForUpdates(true);
                    }
                  } as MenuItemConstructorOptions,
                  { type: 'separator' as const },
                ]
              : []),
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' }
          ]
        } as MenuItemConstructorOptions]
      : []),

    // Edit Menu (clipboard shortcuts: cut/copy/paste/select all)
    { role: 'editMenu' },

    // Server Menu (server control)
    {
      label: 'Server',
      submenu: [
        {
          label: getServerStatus() ? 'Stop Server' : 'Start Server',
          accelerator: 'CmdOrCtrl+S',
          click: async () => {
            const isRunning = getServerStatus();
            if (isRunning) {
              await service.stopAll({ showNotification: true });
            } else {
              await service.startAll({ showNotification: true });
            }
            // Menu will be automatically updated via menuUpdateCallback
          }
        },
        {
          label: 'Restart Server',
          accelerator: 'CmdOrCtrl+R',
          click: async () => {
            await service.stopAll({ showNotification: false });
            await service.startAll({ showNotification: true });
          }
        }
      ] as MenuItemConstructorOptions[]
    },

    // View Menu (page navigation + window controls)
    {
      label: 'View',
      submenu: [
        {
          label: 'Assistant',
          accelerator: 'CmdOrCtrl+1',
          click: () => showPage('assistant')
        },
        { type: 'separator' },
        {
          label: 'Terminal',
          accelerator: 'CmdOrCtrl+2',
          click: () => showPage('terminal')
        },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+3',
          click: () => showPage('settings')
        },
        {
          label: 'Help',
          accelerator: 'CmdOrCtrl+4',
          click: () => showPage('help')
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' }
      ] as MenuItemConstructorOptions[]
    },

    // Window Menu (window management)
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [
              { type: 'separator' as const },
              { role: 'front' as const }
            ]
          : [
              { role: 'close' as const }
            ])
      ] as MenuItemConstructorOptions[]
    },

    // Help Menu
    {
      role: 'help',
      submenu: [
        // Windows/Linux: Add "Check for Updates" to Help menu
        ...(!isMac && canCheckForUpdates
          ? [
              {
                label: 'Check for Updates...',
                click: () => {
                  checkForUpdates(true);
                }
              },
              { type: 'separator' as const }
            ]
          : []),
        {
          label: 'Learn More',
          click: async () => {
            await shell.openExternal('https://github.com/grab/TalkToFigmaDesktop');
          }
        },
        {
          label: 'Documentation',
          click: async () => {
            await shell.openExternal('https://github.com/grab/TalkToFigmaDesktop/blob/main/README.md');
          }
        },
        {
          label: 'MCP Protocol Docs',
          click: async () => {
            await shell.openExternal('https://modelcontextprotocol.io');
          }
        },
        { type: 'separator' },
        {
          label: 'Report Issue',
          click: async () => {
            await shell.openExternal('https://github.com/grab/TalkToFigmaDesktop/issues');
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
