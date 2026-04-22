/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { BrowserWindow } from 'electron';
import { FigmaOAuthService } from '../figma/oauth/FigmaOAuthService';
import { FigmaApiClient } from '../figma/api/FigmaApiClient';
import { getFigmaUser, getStore, saveFigmaUser } from '../utils/store';
import { trackOAuthAction } from '../analytics';
import { IPC_CHANNELS, STORE_KEYS } from '../../shared/constants';
import type { FigmaAuthState } from '../../shared/types';

interface LoggerLike {
  error: (message: string, error?: unknown) => void;
  info: (message: string) => void;
}

export interface AuthManagerAdapter {
  startOAuth: () => Promise<void>;
  logout: () => Promise<void>;
  getStatus: () => FigmaAuthState;
}

export function createAuthManagerAdapter({
  window,
  logger,
  emitToRenderer,
}: {
  window: BrowserWindow;
  logger: LoggerLike;
  emitToRenderer: (window: BrowserWindow, channel: string, data: unknown) => void;
}): AuthManagerAdapter {
  return {
    startOAuth: async () => {
      trackOAuthAction('start');
      try {
        const oauthService = new FigmaOAuthService();
        await oauthService.authenticate();
        trackOAuthAction('success');

        const apiClient = await FigmaApiClient.create();
        if (!apiClient) {
          return;
        }

        const userResult = await apiClient.getCurrentUser();
        if (!userResult.success || !userResult.data) {
          return;
        }

        const user = {
          id: userResult.data.id,
          email: userResult.data.email,
          handle: userResult.data.handle,
          imgUrl: userResult.data.img_url,
        };
        saveFigmaUser(user);

        emitToRenderer(window, IPC_CHANNELS.AUTH_STATUS_CHANGED, {
          isAuthenticated: true,
          user,
          tokens: null,
          fileKey: null,
          fileUrl: null,
        });
      } catch (error) {
        trackOAuthAction('error');
        logger.error('OAuth authentication failed:', error);
        throw error;
      }
    },
    logout: async () => {
      trackOAuthAction('logout');
      FigmaOAuthService.clearTokens();

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
        tokens: null,
        fileKey: null,
        fileUrl: null,
      };
    },
  };
}
