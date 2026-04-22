/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { BrowserWindow, ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { AssistantRunEvent, AssistantRuntimeStatus, ToolApprovalRequest } from '../../shared/types';
import { AssistantRuntimeService } from '../assistant';

export function registerAssistantIpcHandlers({
  mainWindow,
  emitToRenderer,
}: {
  mainWindow: BrowserWindow;
  emitToRenderer: (mainWindow: BrowserWindow, channel: string, data: unknown) => void;
}): void {
  const assistantRuntime = AssistantRuntimeService.getInstance();

  assistantRuntime.setEventHandlers({
    onRunEvent: (event: AssistantRunEvent) => {
      emitToRenderer(mainWindow, IPC_CHANNELS.ASSISTANT_RUN_EVENT, event);
    },
    onToolApprovalRequired: (request: ToolApprovalRequest) => {
      emitToRenderer(mainWindow, IPC_CHANNELS.ASSISTANT_TOOL_APPROVAL_REQUIRED, request);
    },
    onRuntimeStatusChanged: (status: AssistantRuntimeStatus) => {
      emitToRenderer(mainWindow, IPC_CHANNELS.ASSISTANT_RUNTIME_STATUS_CHANGED, status);
    },
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_GET_RUNTIME_STATUS, async (_event: IpcMainInvokeEvent, threadId?: string) => {
    return assistantRuntime.getRuntimeStatus(threadId);
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_LIST_MODELS, async () => {
    return assistantRuntime.listModels();
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_LIST_MODEL_CATALOG, async () => {
    return assistantRuntime.listModelCatalog();
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_DOWNLOAD_MODEL, async (_event: IpcMainInvokeEvent, modelId: string) => {
    return assistantRuntime.downloadModel(modelId);
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_CANCEL_MODEL_DOWNLOAD, async () => {
    return assistantRuntime.cancelModelDownload();
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_UPLOAD_MODEL, async (_event: IpcMainInvokeEvent, payload: {
    ggufPath: string;
    mmprojPath?: string;
    displayName?: string;
  }) => {
    return assistantRuntime.uploadModel(payload);
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_DELETE_MODEL, async (_event: IpcMainInvokeEvent, modelId: string) => {
    return assistantRuntime.deleteModel(modelId);
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_SET_ACTIVE_MODEL, async (_event: IpcMainInvokeEvent, threadId: string, model: string) => {
    return assistantRuntime.setActiveModel(threadId, model);
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_CREATE_THREAD, async (_event: IpcMainInvokeEvent, title?: string) => {
    return assistantRuntime.createThread(title);
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_LIST_THREADS, async () => {
    return assistantRuntime.listThreads();
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_GET_THREAD, async (_event: IpcMainInvokeEvent, threadId: string) => {
    return assistantRuntime.getThread(threadId);
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_DELETE_THREAD, async (_event: IpcMainInvokeEvent, threadId: string) => {
    return assistantRuntime.deleteThread(threadId);
  });

  ipcMain.handle(
    IPC_CHANNELS.ASSISTANT_SEND_MESSAGE,
    async (_event: IpcMainInvokeEvent, threadId: string, text: string, attachments = []) => {
      return assistantRuntime.sendMessage(threadId, text, attachments);
    },
  );

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_CANCEL_RUN, async (_event: IpcMainInvokeEvent, runId: string) => {
    return assistantRuntime.cancelRun(runId);
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_APPROVE_TOOL_CALL, async (_event: IpcMainInvokeEvent, runId: string, toolCallId: string) => {
    return assistantRuntime.approveToolCall(runId, toolCallId);
  });

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_REJECT_TOOL_CALL, async (_event: IpcMainInvokeEvent, runId: string, toolCallId: string) => {
    return assistantRuntime.rejectToolCall(runId, toolCallId);
  });
}
