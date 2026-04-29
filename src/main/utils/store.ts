/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import ElectronStore from 'electron-store';
import { ASSISTANT_CONTEXT_LENGTH, ASSISTANT_TOOL_RESULT_LIMITS, STORE_KEYS } from '../../shared/constants';
import type { FigmaAuthTokens, FigmaUser } from '../../shared/types';

let store: any | null = null;

/**
 * Get store instance (singleton pattern)
 * Use this function to access the store from anywhere in the main process
 */
export function getStore(): any {
  if (!store) {
    store = new (ElectronStore as any)({
      name: 'talktofigma-config',
      encryptionKey: 'talktofigma-secure-key-v1', // Use a secure key in production
      defaults: {
        'app.theme': 'system',
        'app.locale': 'system',
        'app.firstLaunch': true,
        'app.showTutorial': true,
        [STORE_KEYS.ASSISTANT_CONTEXT_LENGTH]: ASSISTANT_CONTEXT_LENGTH.DEFAULT,
        [STORE_KEYS.ASSISTANT_TOOL_RESULT_LIMIT_CURRENT]: ASSISTANT_TOOL_RESULT_LIMITS.CURRENT_DEFAULT,
        [STORE_KEYS.ASSISTANT_TOOL_RESULT_LIMIT_HISTORY]: ASSISTANT_TOOL_RESULT_LIMITS.HISTORY_DEFAULT,
      },
    });
  }
  return store;
}

// Helper functions for Figma auth
export function saveFigmaTokens(tokens: FigmaAuthTokens): void {
  const appStore = getStore();
  appStore.set(STORE_KEYS.FIGMA_ACCESS_TOKEN, tokens.accessToken);
  appStore.set(STORE_KEYS.FIGMA_REFRESH_TOKEN, tokens.refreshToken);
  appStore.set(STORE_KEYS.FIGMA_TOKEN_EXPIRES_AT, tokens.expiresAt);
}

export function getFigmaTokens(): FigmaAuthTokens | null {
  const appStore = getStore();
  const accessToken = appStore.get(STORE_KEYS.FIGMA_ACCESS_TOKEN) as string | undefined;
  const refreshToken = appStore.get(STORE_KEYS.FIGMA_REFRESH_TOKEN) as string | undefined;
  const expiresAt = appStore.get(STORE_KEYS.FIGMA_TOKEN_EXPIRES_AT) as number | undefined;

  if (!accessToken || !refreshToken || !expiresAt) {
    return null;
  }

  return { accessToken, refreshToken, expiresAt };
}

export function clearFigmaTokens(): void {
  const appStore = getStore();
  appStore.delete(STORE_KEYS.FIGMA_ACCESS_TOKEN);
  appStore.delete(STORE_KEYS.FIGMA_REFRESH_TOKEN);
  appStore.delete(STORE_KEYS.FIGMA_TOKEN_EXPIRES_AT);
}

export function saveFigmaUser(user: FigmaUser): void {
  const appStore = getStore();
  appStore.set(STORE_KEYS.FIGMA_USER_ID, user.id);
  appStore.set(STORE_KEYS.FIGMA_USER_HANDLE, user.handle);
  appStore.set(STORE_KEYS.FIGMA_USER_EMAIL, user.email);
  if (user.imgUrl) {
    appStore.set(STORE_KEYS.FIGMA_USER_IMG_URL, user.imgUrl);
  }
}

export function getFigmaUser(): FigmaUser | null {
  const appStore = getStore();
  const id = appStore.get(STORE_KEYS.FIGMA_USER_ID) as string | undefined;
  const handle = appStore.get(STORE_KEYS.FIGMA_USER_HANDLE) as string | undefined;
  const email = appStore.get(STORE_KEYS.FIGMA_USER_EMAIL) as string | undefined;

  if (!id || !handle || !email) {
    return null;
  }

  return {
    id,
    handle,
    email,
    imgUrl: appStore.get(STORE_KEYS.FIGMA_USER_IMG_URL) as string | undefined,
  };
}

export function clearFigmaUser(): void {
  const appStore = getStore();
  appStore.delete(STORE_KEYS.FIGMA_USER_ID);
  appStore.delete(STORE_KEYS.FIGMA_USER_HANDLE);
  appStore.delete(STORE_KEYS.FIGMA_USER_EMAIL);
  appStore.delete(STORE_KEYS.FIGMA_USER_IMG_URL);
}

export function setFigmaFileKey(key: string, url?: string): void {
  const appStore = getStore();
  appStore.set(STORE_KEYS.FIGMA_FILE_KEY, key);
  if (url) {
    appStore.set(STORE_KEYS.FIGMA_FILE_URL, url);
  }
}

export function getFigmaFileKey(): { key: string; url?: string } | null {
  const appStore = getStore();
  const key = appStore.get(STORE_KEYS.FIGMA_FILE_KEY) as string | undefined;
  if (!key) return null;

  return {
    key,
    url: appStore.get(STORE_KEYS.FIGMA_FILE_URL) as string | undefined,
  };
}

// Generic get/set for settings
export function getSetting<T>(key: string): T | undefined {
  return getStore().get(key) as T | undefined;
}

export function setSetting<T>(key: string, value: T): void {
  getStore().set(key, value);
}
