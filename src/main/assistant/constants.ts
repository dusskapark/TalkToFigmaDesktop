/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

export const ASSISTANT_DEFAULT_MODEL = 'gemma4:e4b' as const;
export const ASSISTANT_MAX_STEPS = 8;

export const ASSISTANT_LIMITS = {
  THREADS: 100,
  MESSAGES_PER_THREAD: 400,
  RUN_LOGS: 500,
} as const;
