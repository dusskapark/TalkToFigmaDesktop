// IPC (Inter-Process Communication) types

import type { ServerState } from './server';
import type { FigmaAuthState, FigmaUser } from './figma';
import type {
  AssistantMessagePartAttachment,
  AssistantMessage,
  AssistantRunEvent,
  AssistantThread,
  OllamaRuntimeStatus,
  OllamaSetupGuide,
  ToolApprovalRequest,
} from './assistant';

export interface UpdateCapabilities {
  channel: 'direct' | 'mas' | 'msix';
  canCheckForUpdates: boolean;
  managedByStore: boolean;
}

// Events from Main to Renderer
export interface MainToRendererEvents {
  'server:status-changed': ServerState;
  'figma:connection-changed': {
    connected: boolean;
    channelId?: string;
    clientCount?: number;
  };
  'figma:progress-update': {
    requestId: string;
    progress: number;
    message: string;
    completed: boolean;
  };
  'auth:status-changed': {
    isAuthenticated: boolean;
    user?: FigmaUser;
  };
  'log:entry': LogEntry;
  'tray:navigate-to-page': 'assistant' | 'terminal' | 'settings' | 'help';
  'assistant:runtime-status-changed': OllamaRuntimeStatus;
  'assistant:run-event': AssistantRunEvent;
  'assistant:tool-approval-required': ToolApprovalRequest;
}

// Invocations from Renderer to Main
export interface RendererToMainInvocations {
  // Server control
  'server:start': () => Promise<void>;
  'server:stop': () => Promise<void>;
  'server:restart': () => Promise<void>;
  'server:get-status': () => Promise<ServerState>;

  // Figma auth
  'auth:start-oauth': () => Promise<void>;
  'auth:logout': () => Promise<void>;
  'auth:get-status': () => Promise<FigmaAuthState>;
  'auth:set-file-key': (fileKey: string) => Promise<void>;

  // Settings
  'settings:get': <T>(key: string) => Promise<T | null>;
  'settings:set': <T>(key: string, value: T) => Promise<void>;

  // Window control
  'window:resize': (width: number, height: number) => Promise<void>;
  'window:hide': () => Promise<void>;
  'window:show': () => Promise<void>;

  // Shell
  'shell:open-external': (url: string) => Promise<void>;

  // Updates
  'update:check': () => Promise<void>;
  'update:get-capabilities': () => Promise<UpdateCapabilities>;

  // Assistant
  'assistant:get-runtime-status': (threadId?: string) => Promise<OllamaRuntimeStatus>;
  'assistant:get-setup-guide': () => Promise<OllamaSetupGuide>;
  'assistant:list-models': () => Promise<string[]>;
  'assistant:set-active-model': (threadId: string, model: string) => Promise<{ success: boolean; error?: string }>;
  'assistant:create-thread': (title?: string) => Promise<AssistantThread>;
  'assistant:list-threads': () => Promise<AssistantThread[]>;
  'assistant:get-thread': (threadId: string) => Promise<{ thread: AssistantThread | null; messages: AssistantMessage[] }>;
  'assistant:delete-thread': (threadId: string) => Promise<{ success: boolean; error?: string }>;
  'assistant:send-message': (
    threadId: string,
    text: string,
    attachments?: AssistantMessagePartAttachment[],
  ) => Promise<{ success: boolean; runId?: string; error?: string }>;
  'assistant:cancel-run': (runId: string) => Promise<{ success: boolean; error?: string }>;
  'assistant:approve-tool-call': (runId: string, toolCallId: string) => Promise<{ success: boolean; error?: string }>;
  'assistant:reject-tool-call': (runId: string, toolCallId: string) => Promise<{ success: boolean; error?: string }>;
}

// Log entry type
export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  timestamp: string;
  source?: string;
  data?: unknown;
}

// Electron API exposed to renderer via contextBridge
export interface ElectronAPI {
  server: {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    restart: () => Promise<void>;
    getStatus: () => Promise<ServerState>;
    onStatusChanged: (callback: (state: ServerState) => void) => () => void;
  };

  figma: {
    startOAuth: () => Promise<void>;
    logout: () => Promise<void>;
    getAuthStatus: () => Promise<FigmaAuthState>;
    setFileKey: (key: string) => Promise<void>;
    onConnectionChanged: (callback: (data: MainToRendererEvents['figma:connection-changed']) => void) => () => void;
    onProgressUpdate: (callback: (data: MainToRendererEvents['figma:progress-update']) => void) => () => void;
  };

  auth: {
    onStatusChanged: (callback: (data: MainToRendererEvents['auth:status-changed']) => void) => () => void;
  };

  settings: {
    get: <T>(key: string) => Promise<T | null>;
    set: <T>(key: string, value: T) => Promise<void>;
  };

  window: {
    resize: (width: number, height: number) => Promise<void>;
    hide: () => Promise<void>;
    show: () => Promise<void>;
  };

  shell: {
    openExternal: (url: string) => Promise<void>;
  };

  log: {
    onEntry: (callback: (entry: LogEntry) => void) => () => void;
  };

  tray: {
    onNavigateToPage: (callback: (page: MainToRendererEvents['tray:navigate-to-page']) => void) => () => void;
  };

  mcp: {
    detectConfig: (clientId: string) => Promise<ConfigDetectionResult>;
    autoConfig: (clientId: string) => Promise<ConfigWriteResult>;
    openConfigFolder: (clientId: string) => Promise<{ success: boolean; error?: string }>;
    restoreBackup: (clientId: string) => Promise<ConfigWriteResult>;
    getStdioPath: () => Promise<string>;
    getStdioConfig: () => Promise<{ config: object; command: string; path: string }>;
  };

  analytics: {
    track: (eventType: string, properties?: Record<string, string | number | boolean>) => Promise<void>;
  };

  update: {
    check: () => Promise<void>;
    getCapabilities: () => Promise<UpdateCapabilities>;
  };

  sse: {
    onClientDetected: (callback: () => void) => () => void;
  };

  assistant: {
    getRuntimeStatus: (threadId?: string) => Promise<OllamaRuntimeStatus>;
    getSetupGuide: () => Promise<OllamaSetupGuide>;
    listModels: () => Promise<string[]>;
    setActiveModel: (threadId: string, model: string) => Promise<{ success: boolean; error?: string }>;
    createThread: (title?: string) => Promise<AssistantThread>;
    listThreads: () => Promise<AssistantThread[]>;
    getThread: (threadId: string) => Promise<{ thread: AssistantThread | null; messages: AssistantMessage[] }>;
    deleteThread: (threadId: string) => Promise<{ success: boolean; error?: string }>;
    sendMessage: (
      threadId: string,
      text: string,
      attachments?: AssistantMessagePartAttachment[],
    ) => Promise<{ success: boolean; runId?: string; error?: string }>;
    cancelRun: (runId: string) => Promise<{ success: boolean; error?: string }>;
    approveToolCall: (runId: string, toolCallId: string) => Promise<{ success: boolean; error?: string }>;
    rejectToolCall: (runId: string, toolCallId: string) => Promise<{ success: boolean; error?: string }>;
    onRuntimeStatusChanged: (callback: (status: MainToRendererEvents['assistant:runtime-status-changed']) => void) => () => void;
    onRunEvent: (callback: (event: MainToRendererEvents['assistant:run-event']) => void) => () => void;
    onToolApprovalRequired: (callback: (request: MainToRendererEvents['assistant:tool-approval-required']) => void) => () => void;
  };
}

// MCP Configuration types
export interface ConfigDetectionResult {
  status: 'configured' | 'exists-not-configured' | 'not-found' | 'no-permission' | 'unknown';
  configPath: string;
  exists: boolean;
  readable: boolean;
  hasOurServer: boolean;
  error?: string;
}

export interface ConfigWriteResult {
  success: boolean;
  message: string;
  configPath?: string;
  backupPath?: string;
  error?: string;
}

// Extend Window interface
declare global {
  interface Window {
    electron: ElectronAPI;
  }
}
