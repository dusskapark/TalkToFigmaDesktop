/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import type { AssistantThread } from '../../shared/types';
import { ASSISTANT_DEFAULT_MODEL } from './constants';

export function resolveAssistantActiveModel({
  thread,
  globalModel,
  installedModels,
}: {
  thread: AssistantThread | null;
  globalModel: string | null;
  installedModels: string[];
}): string | null {
  if (thread?.activeModel && installedModels.includes(thread.activeModel)) {
    return thread.activeModel;
  }

  if (globalModel && installedModels.includes(globalModel)) {
    return globalModel;
  }

  if (installedModels.includes(ASSISTANT_DEFAULT_MODEL)) {
    return ASSISTANT_DEFAULT_MODEL;
  }

  return installedModels[0] ?? null;
}
