/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import type { OllamaRuntimeStatus } from '../../shared/types';
import { createLogger } from '../utils/logger';
import { ASSISTANT_DEFAULT_MODEL } from './constants';

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
  }>;
}

export class OllamaRuntimeProbe {
  private readonly logger = createLogger('OllamaRuntimeProbe');
  private readonly baseUrl: string;

  constructor(baseUrl = 'http://127.0.0.1:11434') {
    this.baseUrl = baseUrl;
  }

  async isDaemonReachable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, { method: 'GET' });
      return response.ok;
    } catch (error) {
      this.logger.debug(`Ollama daemon is not reachable: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async listInstalledModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, { method: 'GET' });
      if (!response.ok) {
        return [];
      }

      const data = await response.json() as OllamaTagsResponse;
      const modelNames = (data.models ?? [])
        .map((model) => model.name ?? model.model ?? '')
        .filter((name): name is string => typeof name === 'string' && name.length > 0);

      modelNames.sort((a, b) => a.localeCompare(b));
      return modelNames;
    } catch (error) {
      this.logger.debug(`Failed to list Ollama models: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  async getRuntimeStatus(activeModel: string | null): Promise<OllamaRuntimeStatus> {
    const daemonReachable = await this.isDaemonReachable();
    const installedModels = daemonReachable ? await this.listInstalledModels() : [];
    const defaultModelInstalled = installedModels.includes(ASSISTANT_DEFAULT_MODEL);
    const activeModelInstalled = !!activeModel && installedModels.includes(activeModel);
    const needsModelSelection = daemonReachable && !defaultModelInstalled && !activeModelInstalled;

    return {
      daemonReachable,
      installedModels,
      defaultModel: ASSISTANT_DEFAULT_MODEL,
      defaultModelInstalled,
      activeModel: activeModelInstalled ? activeModel : null,
      needsModelSelection,
      guideModeOnly: true,
    };
  }
}
