/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { ASSISTANT_CONTEXT_LENGTH, ASSISTANT_TOOL_RESULT_LIMITS, STORE_KEYS } from '../../shared/constants';
import type { AssistantRuntimeBackend } from '../../shared/types';
import { getSetting, setSetting } from '../utils/store';

type GetSetting = <T>(key: string) => T | undefined;
type SetSetting = <T>(key: string, value: T) => void;

export function normalizeContextLength(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return ASSISTANT_CONTEXT_LENGTH.DEFAULT;
  }

  const rounded = Math.round(numeric);
  return ASSISTANT_CONTEXT_LENGTH.OPTIONS.includes(rounded as typeof ASSISTANT_CONTEXT_LENGTH.OPTIONS[number])
    ? rounded
    : ASSISTANT_CONTEXT_LENGTH.DEFAULT;
}

export function normalizeToolResultLimit(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  const rounded = Math.round(numeric);
  return ASSISTANT_TOOL_RESULT_LIMITS.OPTIONS.includes(
    rounded as typeof ASSISTANT_TOOL_RESULT_LIMITS.OPTIONS[number],
  )
    ? rounded
    : fallback;
}

export function normalizeRuntimeBackend(value: unknown): AssistantRuntimeBackend {
  return value === 'ollama' ? 'ollama' : 'embedded';
}

export class AssistantRuntimeSettings {
  constructor(
    private readonly readSetting: GetSetting = defaultGetSetting,
    private readonly writeSetting: SetSetting = defaultSetSetting,
  ) {}

  getContextLength(): number {
    return normalizeContextLength(this.readSetting<number>(STORE_KEYS.ASSISTANT_CONTEXT_LENGTH));
  }

  getRuntimeBackend(): AssistantRuntimeBackend {
    return normalizeRuntimeBackend(this.readSetting<AssistantRuntimeBackend>(STORE_KEYS.ASSISTANT_RUNTIME_BACKEND));
  }

  setRuntimeBackend(backend: AssistantRuntimeBackend): void {
    this.writeSetting(STORE_KEYS.ASSISTANT_RUNTIME_BACKEND, normalizeRuntimeBackend(backend));
  }

  getCurrentToolResultLimit(): number {
    return normalizeToolResultLimit(
      this.readSetting<number>(STORE_KEYS.ASSISTANT_TOOL_RESULT_LIMIT_CURRENT),
      ASSISTANT_TOOL_RESULT_LIMITS.CURRENT_DEFAULT,
    );
  }

  getHistoryToolResultLimit(): number {
    return normalizeToolResultLimit(
      this.readSetting<number>(STORE_KEYS.ASSISTANT_TOOL_RESULT_LIMIT_HISTORY),
      ASSISTANT_TOOL_RESULT_LIMITS.HISTORY_DEFAULT,
    );
  }

  increaseContextLengthForPrompt(promptTokens: number, currentContext: number): number | null {
    const configured = this.getContextLength();
    const requiredWithHeadroom = Math.max(promptTokens + 2_048, configured);
    const nextContextLength = ASSISTANT_CONTEXT_LENGTH.OPTIONS.find((option) => option >= requiredWithHeadroom) ?? null;

    if (!nextContextLength || nextContextLength <= currentContext) {
      return null;
    }

    this.writeSetting(STORE_KEYS.ASSISTANT_CONTEXT_LENGTH, nextContextLength);
    return nextContextLength;
  }
}

function defaultGetSetting<T>(key: string): T | undefined {
  return getSetting<T>(key);
}

function defaultSetSetting<T>(key: string, value: T): void {
  setSetting(key, value);
}
