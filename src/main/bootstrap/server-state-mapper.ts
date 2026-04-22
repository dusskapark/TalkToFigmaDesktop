/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import type { ServerState } from '../../shared/types';

interface FigmaServerStatus {
  websocket: {
    running: boolean;
    port: number;
    clientCount?: number;
    mcpClientCount?: number;
    figmaClientCount?: number;
  };
}

export function toRendererServerState(figmaState: FigmaServerStatus): ServerState {
  return {
    websocket: {
      status: figmaState.websocket.running ? 'running' : 'stopped',
      port: figmaState.websocket.port,
      connectedClients: figmaState.websocket.clientCount || 0,
      mcpClientCount: figmaState.websocket.mcpClientCount,
      figmaClientCount: figmaState.websocket.figmaClientCount,
    },
    mcp: {
      status: 'running',
      transport: 'stdio',
    },
    operationInProgress: false,
    lastError: null,
  };
}
