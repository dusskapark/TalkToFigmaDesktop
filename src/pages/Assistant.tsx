import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Check, ChevronDown, Copy, Loader2, Paperclip, Plus, SendHorizontal, Shield, ThumbsDown, ThumbsUp, Trash2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import {
  ChatContainerContent,
  ChatContainerRoot,
  ChatContainerScrollAnchor,
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  PromptInput,
  PromptInputAction,
  PromptInputActions,
  PromptInputTextarea,
  Reasoning,
  ReasoningContent,
  ScrollButton,
  ThinkingBar,
  Tool,
  type ToolPart,
} from '@/components/prompt-kit'
import { cn } from '@/lib/utils'
import type {
  AssistantMessage,
  AssistantMessagePart,
  AssistantMessagePartAttachment,
  AssistantMessagePartTool,
  AssistantRunEvent,
  AssistantThread,
  OllamaRuntimeStatus,
  OllamaSetupGuide,
  ToolApprovalRequest,
} from '@/shared/types'

const LAST_OPENED_THREAD_KEY = 'assistant.lastOpenedThreadId'
const PERMISSION_MODE_KEY = 'assistant.permissionMode'
const ATTACHMENT_TEXT_LIMIT = 12_000
const MAX_ATTACHMENTS = 8
const MAX_PROMPT_INPUT_MODEL_OPTIONS = 5
const SHIMMER_MIN_VISIBLE_MS = 500
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  'txt',
  'md',
  'json',
  'yaml',
  'yml',
  'xml',
  'csv',
  'tsv',
  'js',
  'jsx',
  'ts',
  'tsx',
  'css',
  'scss',
  'html',
  'svg',
  'py',
  'go',
  'rs',
  'java',
  'c',
  'cpp',
  'h',
  'hpp',
  'sql',
])

type AppState = 'ready' | 'needs-setup' | 'needs-model-selection' | 'waiting-approval'
type ToolPartState = ToolPart['state']
type PermissionMode = 'run-everything' | 'ask-every-time'
type AssistantFeedback = 'up' | 'down'
const VALID_TOOL_PART_STATES: ToolPartState[] = [
  'input-streaming',
  'input-available',
  'output-available',
  'output-error',
]

interface LiveToolEvent {
  toolCallId: string
  toolType: string
  safety?: 'read' | 'write'
  input?: Record<string, unknown>
  state: ToolPartState
  output?: unknown
  errorText?: string
}

type RenderableChatItem =
  | {
      id: string
      kind: 'text'
      role: 'user' | 'assistant' | 'system'
      text: string
      markdown: boolean
      attachments?: AssistantMessagePartAttachment[]
    }
  | {
      id: string
      kind: 'tool'
      toolCallId: string
      toolType: string
      safety?: 'read' | 'write'
      state: ToolPartState
      input?: Record<string, unknown>
      output?: unknown
      errorText?: string
    }

function getAppState(runtimeStatus: OllamaRuntimeStatus | null, waitingApproval: boolean): AppState {
  if (!runtimeStatus?.daemonReachable) return 'needs-setup'
  if (runtimeStatus.needsModelSelection) return 'needs-model-selection'
  if (waitingApproval) return 'waiting-approval'
  return 'ready'
}

function isErrorCode(value: string | undefined, code: string): boolean {
  return typeof value === 'string' && value.toUpperCase() === code.toUpperCase()
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'run-everything' || value === 'ask-every-time'
}

function collectText(parts: AssistantMessagePart[]): string {
  return parts
    .filter((part): part is Extract<AssistantMessagePart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

function collectAttachments(parts: AssistantMessagePart[]): AssistantMessagePartAttachment[] {
  return parts.filter((part): part is AssistantMessagePartAttachment => part.type === 'attachment')
}

function formatFileSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return '0 B'
  }
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
}

function summarizeAttachments(attachments: AssistantMessagePartAttachment[]): string {
  if (attachments.length === 0) return ''
  const names = attachments.map((attachment) => attachment.name).slice(0, 2)
  const remainder = attachments.length - names.length
  return remainder > 0 ? `${names.join(', ')} +${remainder} more` : names.join(', ')
}

function isLikelyVisionModel(model: string): boolean {
  return /(vision|vl|llava|bakllava|minicpm-v|qwen2(\.5)?-vl|gemma3|gemma4|moondream|pixtral|internvl|phi-3\.5-vision|llama3\.2-vision)/i.test(model)
}

function isToolPartState(value: unknown): value is ToolPartState {
  return typeof value === 'string' && VALID_TOOL_PART_STATES.includes(value as ToolPartState)
}

function normalizeToolType(type: string): string {
  if (type.startsWith('tool-')) return type
  return `tool-${type}`
}

function toToolDisplayName(type: string): string {
  return type
    .replace(/^tool-/, '')
    .replace(/[_-]+/g, ' ')
    .trim()
}

function toCompactValue(value: unknown, max = 160): string {
  if (value === undefined) return ''
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return text.length > max ? `${text.slice(0, max)}...` : text
  } catch {
    const text = String(value)
    return text.length > max ? `${text.slice(0, max)}...` : text
  }
}

function buildReasoningText(
  liveToolEvents: LiveToolEvent[],
  waitingApproval: boolean,
  approvalRequest: ToolApprovalRequest | null,
): string {
  const lines: string[] = []
  lines.push('Runtime reasoning trace')

  if (waitingApproval && approvalRequest) {
    lines.push(`- Awaiting approval for: ${approvalRequest.toolName}`)
  }

  if (liveToolEvents.length === 0) {
    lines.push('- No tool events yet. Preparing execution.')
    return lines.join('\n')
  }

  for (const event of liveToolEvents) {
    const name = toToolDisplayName(event.toolType)
    const status =
      event.state === 'output-available'
        ? 'completed'
        : event.state === 'output-error'
          ? 'failed'
          : event.state === 'input-available'
            ? 'queued'
            : 'running'

    const inputPreview = toCompactValue(event.input)
    const outputPreview = event.state === 'output-available' ? toCompactValue(event.output) : ''
    const errorPreview = event.state === 'output-error' ? event.errorText ?? toCompactValue(event.output) : ''

    lines.push(`- ${name}: ${status}`)
    if (inputPreview) lines.push(`  input: ${inputPreview}`)
    if (outputPreview) lines.push(`  output: ${outputPreview}`)
    if (errorPreview) lines.push(`  error: ${errorPreview}`)
  }

  return lines.join('\n')
}

function isStandardToolPart(part: AssistantMessagePart): part is AssistantMessagePartTool {
  const type = (part as { type?: unknown }).type
  if (typeof type !== 'string') return false
  if (type === 'text' || type === 'attachment' || type === 'tool-call' || type === 'tool-result') return false
  return isToolPartState((part as { state?: unknown }).state)
}

type LegacyToolCallPart = {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  safety?: 'read' | 'write'
  args?: Record<string, unknown>
}

type LegacyToolResultPart = {
  type: 'tool-result'
  toolCallId: string
  toolName?: string
  ok?: boolean
  result?: unknown
  error?: string
}

function isLegacyToolCallPart(part: unknown): part is LegacyToolCallPart {
  if (!part || typeof part !== 'object') return false
  const candidate = part as Partial<LegacyToolCallPart>
  return (
    candidate.type === 'tool-call'
    && typeof candidate.toolCallId === 'string'
    && typeof candidate.toolName === 'string'
  )
}

function isLegacyToolResultPart(part: unknown): part is LegacyToolResultPart {
  if (!part || typeof part !== 'object') return false
  const candidate = part as Partial<LegacyToolResultPart>
  return candidate.type === 'tool-result' && typeof candidate.toolCallId === 'string'
}

function createAttachmentId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function isLikelyTextFile(file: File): boolean {
  const mime = file.type.toLowerCase()
  if (mime.startsWith('text/')) return true
  if (mime.includes('json') || mime.includes('xml') || mime.includes('yaml')) return true
  if (mime.includes('javascript') || mime.includes('typescript')) return true

  const extension = file.name.split('.').pop()?.toLowerCase()
  return extension ? TEXT_ATTACHMENT_EXTENSIONS.has(extension) : false
}

function isImageFile(file: File): boolean {
  return file.type.toLowerCase().startsWith('image/')
}

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
        return
      }
      reject(new Error('Failed to read file as data URL'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file as data URL'))
    reader.readAsDataURL(file)
  })
}

async function toAttachmentPart(file: File): Promise<AssistantMessagePartAttachment> {
  const attachment: AssistantMessagePartAttachment = {
    type: 'attachment',
    id: createAttachmentId(),
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
  }

  if (isImageFile(file)) {
    const dataUrl = await fileToDataUrl(file)
    const commaIndex = dataUrl.indexOf(',')
    const imageBase64 = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : ''
    if (imageBase64) {
      return {
        ...attachment,
        imageBase64,
      }
    }
    return attachment
  }

  if (!isLikelyTextFile(file)) {
    return attachment
  }

  const rawText = await file.text()
  const truncated = rawText.length > ATTACHMENT_TEXT_LIMIT

  return {
    ...attachment,
    ...(rawText ? { textContent: rawText.slice(0, ATTACHMENT_TEXT_LIMIT) } : {}),
    ...(truncated ? { truncated: true } : {}),
  }
}

function toRenderableItems(messages: AssistantMessage[], liveToolEvents: LiveToolEvent[], streamingText: string): RenderableChatItem[] {
  const items: RenderableChatItem[] = []

  for (const message of messages) {
    if (message.role === 'user') {
      const text = collectText(message.parts)
      const attachments = collectAttachments(message.parts)
      if (text.trim() || attachments.length > 0) {
        items.push({
          id: `${message.id}:user`,
          kind: 'text',
          role: 'user',
          text,
          markdown: false,
          ...(attachments.length > 0 ? { attachments } : {}),
        })
      }
      continue
    }

    const legacyResultsByCallId = new Map<string, LegacyToolResultPart>()
    const consumedLegacyResultCallIds = new Set<string>()

    for (const part of message.parts) {
      if (isLegacyToolResultPart(part)) {
        legacyResultsByCallId.set(part.toolCallId, part)
      }
    }

    for (const part of message.parts) {
      if (part.type === 'text') {
        const text = part.text.trim()
        if (!text) continue
        items.push({
          id: `${message.id}:text:${items.length}`,
          kind: 'text',
          role: message.role,
          text: part.text,
          markdown: message.role === 'assistant',
        })
        continue
      }

      if (isStandardToolPart(part)) {
        items.push({
          id: `${message.id}:tool:${part.toolCallId ?? items.length}`,
          kind: 'tool',
          toolCallId: part.toolCallId ?? `tool-${items.length}`,
          toolType: normalizeToolType(part.type),
          safety: part.safety,
          state: part.state,
          input: part.input,
          output: part.output,
          errorText: part.errorText,
        })
        continue
      }

      const rawPart: unknown = part
      if (isLegacyToolCallPart(rawPart)) {
        const legacyResult = legacyResultsByCallId.get(rawPart.toolCallId)
        if (legacyResult) {
          consumedLegacyResultCallIds.add(rawPart.toolCallId)
        }

        items.push({
          id: `${message.id}:legacy-tool:${rawPart.toolCallId}`,
          kind: 'tool',
          toolCallId: rawPart.toolCallId,
          toolType: normalizeToolType(rawPart.toolName),
          safety: rawPart.safety,
          state: legacyResult
            ? (legacyResult.ok === true ? 'output-available' : 'output-error')
            : 'input-available',
          input: rawPart.args,
          output: legacyResult?.result,
          errorText: legacyResult?.error,
        })
      }
    }

    for (const [toolCallId, legacyResult] of legacyResultsByCallId.entries()) {
      if (consumedLegacyResultCallIds.has(toolCallId)) continue
      items.push({
        id: `${message.id}:legacy-tool-result:${toolCallId}`,
        kind: 'tool',
        toolCallId,
        toolType: normalizeToolType(legacyResult.toolName ?? 'unknown_tool'),
        state: legacyResult.ok === true ? 'output-available' : 'output-error',
        output: legacyResult.result,
        errorText: legacyResult.error,
      })
    }
  }

  for (const event of liveToolEvents) {
    items.push({
      id: `live-tool:${event.toolCallId}`,
      kind: 'tool',
      toolCallId: event.toolCallId,
      toolType: event.toolType,
      safety: event.safety,
      state: event.state,
      input: event.input,
      output: event.output,
      errorText: event.errorText,
    })
  }

  if (streamingText.trim()) {
    items.push({
      id: 'live-streaming',
      kind: 'text',
      role: 'assistant',
      text: streamingText,
      markdown: true,
    })
  }

  return items
}

export function AssistantPage() {
  const [runtimeStatus, setRuntimeStatus] = useState<OllamaRuntimeStatus | null>(null)
  const [setupGuide, setSetupGuide] = useState<OllamaSetupGuide | null>(null)
  const [threads, setThreads] = useState<AssistantThread[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AssistantMessage[]>([])
  const [input, setInput] = useState('')
  const [draftAttachments, setDraftAttachments] = useState<AssistantMessagePartAttachment[]>([])
  const [error, setError] = useState<string | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [setupDialogOpen, setSetupDialogOpen] = useState(false)
  const [modelDialogOpen, setModelDialogOpen] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [isRecheckingModels, setIsRecheckingModels] = useState(false)
  const [approvalRequest, setApprovalRequest] = useState<ToolApprovalRequest | null>(null)
  const [waitingApproval, setWaitingApproval] = useState(false)
  const [liveToolEvents, setLiveToolEvents] = useState<LiveToolEvent[]>([])
  const [threadDrawerOpen, setThreadDrawerOpen] = useState(false)
  const [isChangingModel, setIsChangingModel] = useState(false)
  const [showPreResponseShimmer, setShowPreResponseShimmer] = useState(false)
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask-every-time')
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null)
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [assistantFeedbackByMessageId, setAssistantFeedbackByMessageId] = useState<Record<string, AssistantFeedback>>({})

  const sendLockRef = useRef(false)
  const setupDialogPinnedRef = useRef(false)
  const shimmerVisibleSinceRef = useRef<number | null>(null)
  const shimmerHideTimerRef = useRef<number | null>(null)
  const copyFeedbackTimerRef = useRef<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  )

  const appState = useMemo(() => getAppState(runtimeStatus, waitingApproval), [runtimeStatus, waitingApproval])

  const renderableItems = useMemo(
    () => toRenderableItems(messages, liveToolEvents, streamingText),
    [messages, liveToolEvents, streamingText],
  )
  const lastAssistantMessageId = useMemo(() => {
    for (let index = renderableItems.length - 1; index >= 0; index -= 1) {
      const item = renderableItems[index]
      if (item.kind === 'text' && item.role === 'assistant' && item.text.trim().length > 0) {
        return item.id
      }
    }
    return null
  }, [renderableItems])

  const isComposerDisabled = !activeThreadId || !!runId || isSending || appState === 'needs-setup'
  const isSendDisabled = isComposerDisabled || appState === 'needs-model-selection'

  const activeModelLabel = activeThread?.activeModel ?? runtimeStatus?.activeModel ?? runtimeStatus?.defaultModel ?? 'gemma4:e4b'
  const installedModels = runtimeStatus?.installedModels ?? []
  const quickSwitchModels = useMemo(() => {
    if (installedModels.length <= MAX_PROMPT_INPUT_MODEL_OPTIONS) {
      return installedModels
    }

    const prioritizedModels = installedModels.includes(activeModelLabel)
      ? [activeModelLabel, ...installedModels.filter((model) => model !== activeModelLabel)]
      : installedModels

    return prioritizedModels.slice(0, MAX_PROMPT_INPUT_MODEL_OPTIONS)
  }, [installedModels, activeModelLabel])
  const hasMoreModels = installedModels.length > quickSwitchModels.length
  const visionModels = useMemo(() => installedModels.filter(isLikelyVisionModel), [installedModels])
  const selectableModels = visionModels
  const canSend = !isSendDisabled && (input.trim().length > 0 || draftAttachments.length > 0)
  const shouldShowPreResponseShimmer = Boolean((runId || isSending) && !streamingText.trim())
  const permissionModeLabel = permissionMode === 'run-everything' ? 'Run everything' : 'Ask every time'
  const reasoningText = useMemo(
    () => buildReasoningText(liveToolEvents, waitingApproval, approvalRequest),
    [liveToolEvents, waitingApproval, approvalRequest],
  )

  useEffect(() => {
    if (shimmerHideTimerRef.current !== null) {
      window.clearTimeout(shimmerHideTimerRef.current)
      shimmerHideTimerRef.current = null
    }

    if (shouldShowPreResponseShimmer) {
      if (shimmerVisibleSinceRef.current === null) {
        shimmerVisibleSinceRef.current = Date.now()
      }
      setShowPreResponseShimmer(true)
      return
    }

    if (!showPreResponseShimmer) {
      shimmerVisibleSinceRef.current = null
      return
    }

    const elapsed = shimmerVisibleSinceRef.current ? Date.now() - shimmerVisibleSinceRef.current : SHIMMER_MIN_VISIBLE_MS
    const remaining = Math.max(0, SHIMMER_MIN_VISIBLE_MS - elapsed)

    shimmerHideTimerRef.current = window.setTimeout(() => {
      shimmerHideTimerRef.current = null
      shimmerVisibleSinceRef.current = null
      setShowPreResponseShimmer(false)
    }, remaining)

    return () => {
      if (shimmerHideTimerRef.current !== null) {
        window.clearTimeout(shimmerHideTimerRef.current)
        shimmerHideTimerRef.current = null
      }
    }
  }, [shouldShowPreResponseShimmer, showPreResponseShimmer])

  useEffect(
    () => () => {
      if (copyFeedbackTimerRef.current !== null) {
        window.clearTimeout(copyFeedbackTimerRef.current)
        copyFeedbackTimerRef.current = null
      }
    },
    [],
  )

  const openSetupDialog = useCallback((pinned = false) => {
    setupDialogPinnedRef.current = pinned
    setSetupDialogOpen(true)
    setModelDialogOpen(false)
  }, [])

  const closeSetupDialog = useCallback(() => {
    setupDialogPinnedRef.current = false
    setSetupDialogOpen(false)
  }, [])

  const closeSetupDialogIfAutoManaged = useCallback(() => {
    if (!setupDialogPinnedRef.current) {
      setSetupDialogOpen(false)
    }
  }, [])

  const refreshRuntimeStatus = useCallback(async (threadId?: string) => {
    const status = await window.electron.assistant.getRuntimeStatus(threadId)
    setRuntimeStatus(status)

    if (!status.daemonReachable) {
      openSetupDialog(false)
      return status
    }

    closeSetupDialogIfAutoManaged()

    if (status.daemonReachable && status.needsModelSelection) {
      setModelDialogOpen(true)
      setSelectedModel(status.installedModels.find(isLikelyVisionModel) ?? '')
    }

    return status
  }, [closeSetupDialogIfAutoManaged, openSetupDialog])

  const refreshThreads = async () => {
    const nextThreads = await window.electron.assistant.listThreads()
    setThreads(nextThreads)
    return nextThreads
  }

  const loadThread = async (threadId: string) => {
    const data = await window.electron.assistant.getThread(threadId)
    if (!data.thread) return

    setActiveThreadId(threadId)
    setMessages(data.messages)
    setDraftAttachments([])
    await window.electron.settings.set(LAST_OPENED_THREAD_KEY, threadId)
    await refreshRuntimeStatus(threadId)
  }

  const handleSelectThread = async (threadId: string) => {
    await loadThread(threadId)
    setThreadDrawerOpen(false)
  }

  useEffect(() => {
    const initialize = async () => {
      const [guide, existingThreads, savedThreadId, savedPermissionMode] = await Promise.all([
        window.electron.assistant.getSetupGuide(),
        refreshThreads(),
        window.electron.settings.get<string>(LAST_OPENED_THREAD_KEY),
        window.electron.settings.get<string>(PERMISSION_MODE_KEY),
      ])
      setSetupGuide(guide)
      if (isPermissionMode(savedPermissionMode)) {
        setPermissionMode(savedPermissionMode)
      }
      const restoredThread = existingThreads.find((thread) => thread.id === savedThreadId)

      if (restoredThread) {
        await loadThread(restoredThread.id)
      } else if (existingThreads.length > 0) {
        await loadThread(existingThreads[0].id)
      } else {
        const created = await window.electron.assistant.createThread()
        await refreshThreads()
        await loadThread(created.id)
      }
    }

    void initialize()
  }, [refreshRuntimeStatus])

  useEffect(() => {
    const unsubscribeStatus = window.electron.assistant.onRuntimeStatusChanged((status) => {
      setRuntimeStatus(status)

      if (!status.daemonReachable) {
        openSetupDialog(false)
        return
      }

      closeSetupDialogIfAutoManaged()

      if (status.daemonReachable && status.needsModelSelection) {
        setModelDialogOpen(true)
        setSelectedModel(status.installedModels.find(isLikelyVisionModel) ?? '')
      }
    })

    const unsubscribeRunEvent = window.electron.assistant.onRunEvent(async (event: AssistantRunEvent) => {
      if (event.type === 'run-start') {
        sendLockRef.current = false
        setIsSending(false)
        setRunId(event.runId)
        setStreamingText('')
        setLiveToolEvents([])
        setReasoningOpen(false)
        setError(null)
      }

      if (event.type === 'token') {
        setStreamingText((previous) => previous + event.textDelta)
      }

      if (event.type === 'tool-part') {
        setLiveToolEvents((previous) => {
          const existing = previous.find((item) => item.toolCallId === event.part.toolCallId)
          const next: LiveToolEvent = {
            toolCallId: event.part.toolCallId,
            toolType: normalizeToolType(event.part.type),
            safety: event.part.safety ?? existing?.safety,
            input: event.part.input ?? existing?.input,
            state: event.part.state,
            output: event.part.output,
            errorText: event.part.errorText,
          }
          const withoutCurrent = previous.filter((item) => item.toolCallId !== event.part.toolCallId)
          return [...withoutCurrent, next]
        })
      }

      if (event.type === 'run-end') {
        sendLockRef.current = false
        setIsSending(false)
        setRunId((current) => (current === event.runId ? null : current))
        setStreamingText('')
        setLiveToolEvents([])
        setReasoningOpen(false)
        setWaitingApproval(false)
        setApprovalRequest(null)

        if (event.finishReason === 'error') {
          setError(event.error ?? 'Assistant run failed')
        }

        if (activeThreadId) {
          await loadThread(activeThreadId)
        }
        await refreshThreads()
      }
    })

    const unsubscribeApproval = window.electron.assistant.onToolApprovalRequired((request) => {
      if (permissionMode === 'run-everything') {
        setWaitingApproval(false)
        setApprovalRequest(null)
        void window.electron.assistant.approveToolCall(request.runId, request.toolCallId).then((result) => {
          if (!result.success) {
            setApprovalRequest(request)
            setWaitingApproval(true)
            setError(result.error ?? 'Auto-approval failed. Please approve manually.')
          }
        })
        return
      }
      setApprovalRequest(request)
      setWaitingApproval(true)
    })

    return () => {
      unsubscribeStatus()
      unsubscribeRunEvent()
      unsubscribeApproval()
    }
  }, [activeThreadId, closeSetupDialogIfAutoManaged, openSetupDialog, permissionMode, refreshRuntimeStatus])

  useEffect(() => {
    if (!modelDialogOpen) return

    const poll = () => {
      void refreshRuntimeStatus(activeThreadId ?? undefined)
    }

    poll()
    const intervalId = window.setInterval(poll, 3000)
    return () => {
      window.clearInterval(intervalId)
    }
  }, [modelDialogOpen, activeThreadId, refreshRuntimeStatus])

  useEffect(() => {
    if (!setupDialogOpen) return

    const poll = () => {
      void refreshRuntimeStatus(activeThreadId ?? undefined)
    }

    poll()
    const intervalId = window.setInterval(poll, 3000)
    return () => {
      window.clearInterval(intervalId)
    }
  }, [setupDialogOpen, activeThreadId, refreshRuntimeStatus])

  useEffect(() => {
    if (selectableModels.length === 0) return
    setSelectedModel((current) => (current && selectableModels.includes(current) ? current : selectableModels[0]))
  }, [selectableModels])

  useEffect(() => {
    const handleOpenThreads = () => {
      setThreadDrawerOpen(true)
    }

    window.addEventListener('assistant:open-threads', handleOpenThreads)
    return () => {
      window.removeEventListener('assistant:open-threads', handleOpenThreads)
    }
  }, [])

  useEffect(() => {
    const handleOpenSetup = () => {
      openSetupDialog(true)
      void window.electron.assistant.getRuntimeStatus(activeThreadId ?? undefined).then((status) => {
        setRuntimeStatus(status)
      })
    }

    window.addEventListener('assistant:open-setup', handleOpenSetup)
    return () => {
      window.removeEventListener('assistant:open-setup', handleOpenSetup)
    }
  }, [activeThreadId, openSetupDialog])

  const handleCreateThread = async () => {
    const created = await window.electron.assistant.createThread()
    await refreshThreads()
    await loadThread(created.id)
    setThreadDrawerOpen(false)
  }

  const handleDeleteThread = async (threadId: string) => {
    const target = threads.find((thread) => thread.id === threadId)
    if (!target || deletingThreadId) return

    const confirmed = window.confirm(`Delete thread "${target.title}"? This action cannot be undone.`)
    if (!confirmed) return

    setError(null)
    setDeletingThreadId(threadId)
    try {
      const result = await window.electron.assistant.deleteThread(threadId)
      if (!result.success) {
        setError(result.error ?? 'Failed to delete thread')
        return
      }

      const nextThreads = await refreshThreads()
      if (nextThreads.length === 0) {
        const created = await window.electron.assistant.createThread()
        await refreshThreads()
        await loadThread(created.id)
        return
      }

      if (!activeThreadId || activeThreadId === threadId || !nextThreads.some((thread) => thread.id === activeThreadId)) {
        await loadThread(nextThreads[0].id)
      }
    } finally {
      setDeletingThreadId(null)
    }
  }

  const handleSend = async () => {
    if (!activeThreadId || runId || isSending || sendLockRef.current) return

    if (appState === 'needs-model-selection') {
      setModelDialogOpen(true)
      return
    }

    if (appState === 'needs-setup') {
      openSetupDialog(false)
      return
    }

    setError(null)
    const messageText = input
    const pendingAttachments = draftAttachments
    const trimmedMessageText = messageText.trim()

    if (!trimmedMessageText && pendingAttachments.length === 0) {
      return
    }

    sendLockRef.current = true
    setIsSending(true)

    const userMessage: AssistantMessage = {
      id: `local-${Date.now()}`,
      threadId: activeThreadId,
      role: 'user',
      parts: [
        ...(trimmedMessageText ? [{ type: 'text', text: trimmedMessageText } as const] : []),
        ...pendingAttachments,
      ],
      createdAt: Date.now(),
    }
    setMessages((previous) => [...previous, userMessage])

    setInput('')
    setDraftAttachments([])

    let shouldUnlock = true

    try {
      const result = await window.electron.assistant.sendMessage(activeThreadId, messageText, pendingAttachments)
      if (!result.success) {
        if (isErrorCode(result.error, 'MODEL_SELECTION_REQUIRED')) {
          setModelDialogOpen(true)
        } else if (isErrorCode(result.error, 'OLLAMA_NOT_READY')) {
          setError('Ollama is not reachable. Start `ollama serve` and try again.')
        } else {
          setError(result.error ?? 'Failed to send message')
        }

        setMessages((previous) => previous.filter((message) => message.id !== userMessage.id))
        setInput(messageText)
        setDraftAttachments(pendingAttachments)
        await refreshRuntimeStatus(activeThreadId)
        sendLockRef.current = false
        return
      }

      if (result.runId) {
        shouldUnlock = false
        setRunId(result.runId)
      }
    } finally {
      if (shouldUnlock) {
        sendLockRef.current = false
      }
      setIsSending(false)
    }
  }

  const handleFileSelect = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''

    if (files.length === 0) {
      return
    }

    const settled = await Promise.allSettled(files.map((file) => toAttachmentPart(file)))
    const nextAttachments: AssistantMessagePartAttachment[] = []
    let hasFailedAttachment = false

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        nextAttachments.push(result.value)
      } else {
        hasFailedAttachment = true
      }
    }

    if (nextAttachments.length > 0) {
      setDraftAttachments((previous) => {
        const existingKeys = new Set(previous.map((item) => `${item.name}:${item.sizeBytes}`))
        const merged = [
          ...previous,
          ...nextAttachments.filter((attachment) => !existingKeys.has(`${attachment.name}:${attachment.sizeBytes}`)),
        ]
        return merged.slice(0, MAX_ATTACHMENTS)
      })
    }

    if (hasFailedAttachment) {
      setError('Some files could not be attached. Please try again.')
    }
  }

  const handleRemoveAttachment = (attachmentId: string) => {
    setDraftAttachments((previous) => previous.filter((attachment) => attachment.id !== attachmentId))
  }

  const handleSwitchModel = async (model: string) => {
    if (!activeThreadId || !model || isChangingModel) return

    setIsChangingModel(true)
    setError(null)

    try {
      const result = await window.electron.assistant.setActiveModel(activeThreadId, model)
      if (!result.success) {
        setError(result.error ?? 'Failed to set active model')
        return
      }

      setSelectedModel(model)
      await refreshRuntimeStatus(activeThreadId)
      await refreshThreads()
    } finally {
      setIsChangingModel(false)
    }
  }

  const handlePermissionModeChange = async (mode: PermissionMode) => {
    setPermissionMode(mode)
    await window.electron.settings.set(PERMISSION_MODE_KEY, mode)
  }

  const handleApplyModel = async () => {
    if (!activeThreadId || !selectedModel) return

    const result = await window.electron.assistant.setActiveModel(activeThreadId, selectedModel)
    if (!result.success) {
      setError(result.error ?? 'Failed to set active model')
      return
    }

    setModelDialogOpen(false)
    await refreshRuntimeStatus(activeThreadId)
    await refreshThreads()
  }

  const handleRecheckModels = async () => {
    setIsRecheckingModels(true)
    setError(null)

    try {
      const status = await refreshRuntimeStatus(activeThreadId ?? undefined)

      if (!status.needsModelSelection) {
        setModelDialogOpen(false)
        await refreshThreads()
        return
      }

      const nextVisionModels = status.installedModels.filter(isLikelyVisionModel)
      if (nextVisionModels.length > 0) {
        setSelectedModel((current) => (current && nextVisionModels.includes(current) ? current : nextVisionModels[0]))
      }
    } finally {
      setIsRecheckingModels(false)
    }
  }

  const handleRecheckSetup = async () => {
    setIsRecheckingModels(true)
    setError(null)

    try {
      const status = await refreshRuntimeStatus(activeThreadId ?? undefined)

      if (!status.daemonReachable) {
        openSetupDialog(false)
        return
      }

      closeSetupDialog()
      if (status.daemonReachable && status.needsModelSelection) {
        setModelDialogOpen(true)
      }
    } finally {
      setIsRecheckingModels(false)
    }
  }

  const handleApproval = async (approved: boolean) => {
    if (!approvalRequest) return

    if (approved) {
      await window.electron.assistant.approveToolCall(approvalRequest.runId, approvalRequest.toolCallId)
    } else {
      await window.electron.assistant.rejectToolCall(approvalRequest.runId, approvalRequest.toolCallId)
    }

    setWaitingApproval(false)
    setApprovalRequest(null)
  }

  const handleStopThinking = useCallback(async () => {
    if (!runId) return
    await window.electron.assistant.cancelRun(runId)
  }, [runId])

  const handleCopyAssistantMessage = useCallback(async (messageId: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content)
      setCopiedMessageId(messageId)
      if (copyFeedbackTimerRef.current !== null) {
        window.clearTimeout(copyFeedbackTimerRef.current)
      }
      copyFeedbackTimerRef.current = window.setTimeout(() => {
        setCopiedMessageId((current) => (current === messageId ? null : current))
        copyFeedbackTimerRef.current = null
      }, 1500)
    } catch (copyError) {
      console.error('Failed to copy assistant message', copyError)
    }
  }, [])

  const handleAssistantFeedback = useCallback((messageId: string, feedback: AssistantFeedback) => {
    setAssistantFeedbackByMessageId((current) => {
      const existing = current[messageId]
      if (existing === feedback) {
        const next = { ...current }
        delete next[messageId]
        return next
      }
      return {
        ...current,
        [messageId]: feedback,
      }
    })
  }, [])

  return (
    <>
      <div className="flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="relative min-h-0 w-full flex-1 overflow-hidden">
            <ChatContainerRoot className="h-full">
              <ChatContainerContent className="space-y-6 px-4 pt-8 pb-4">
                {renderableItems.length === 0 ? (
                  <div className="text-muted-foreground mx-auto flex min-h-[280px] w-full max-w-4xl items-center justify-center rounded-xl border border-dashed text-sm">
                    Start a conversation with your local assistant.
                  </div>
                ) : (
                  renderableItems.map((item) => {
                    if (item.kind === 'text') {
                      const isAssistant = item.role === 'assistant'
                      const hasText = item.text.trim().length > 0
                      const attachments = item.attachments ?? []
                      const from = item.role === 'user' ? 'user' : 'assistant'
                      const attachmentSummary = summarizeAttachments(attachments)
                      return (
                        <Message
                          key={item.id}
                          className={cn(
                            'mx-auto flex w-full max-w-4xl flex-col gap-2 px-0 md:px-6',
                            isAssistant ? 'items-start' : 'items-end',
                          )}
                        >
                          {hasText ? (
                            isAssistant ? (
                              <div className="group flex w-full flex-col gap-0.5">
                                <MessageContent
                                  from={from}
                                  markdown
                                  className="text-foreground prose w-full flex-1 rounded-lg border-transparent bg-transparent p-2 leading-relaxed shadow-none"
                                >
                                  {item.text}
                                </MessageContent>
                                <MessageActions
                                  className={cn(
                                    'ml-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100',
                                    item.id === lastAssistantMessageId && 'opacity-100',
                                  )}
                                >
                                  <MessageAction tooltip={copiedMessageId === item.id ? 'Copied' : 'Copy'}>
                                    <Button
                                      variant="ghost"
                                      size="icon-sm"
                                      className="rounded-full"
                                      aria-label="Copy assistant message"
                                      onClick={() => void handleCopyAssistantMessage(item.id, item.text)}
                                    >
                                      {copiedMessageId === item.id ? (
                                        <Check className="size-3.5" />
                                      ) : (
                                        <Copy className="size-3.5" />
                                      )}
                                    </Button>
                                  </MessageAction>
                                  <MessageAction tooltip="Helpful">
                                    <Button
                                      variant="ghost"
                                      size="icon-sm"
                                      className={cn(
                                        'rounded-full',
                                        assistantFeedbackByMessageId[item.id] === 'up' && 'bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20',
                                      )}
                                      aria-label="Mark assistant response as helpful"
                                      aria-pressed={assistantFeedbackByMessageId[item.id] === 'up'}
                                      onClick={() => handleAssistantFeedback(item.id, 'up')}
                                    >
                                      <ThumbsUp className="size-3.5" />
                                    </Button>
                                  </MessageAction>
                                  <MessageAction tooltip="Not helpful">
                                    <Button
                                      variant="ghost"
                                      size="icon-sm"
                                      className={cn(
                                        'rounded-full',
                                        assistantFeedbackByMessageId[item.id] === 'down'
                                          && 'bg-rose-500/10 text-rose-700 hover:bg-rose-500/20',
                                      )}
                                      aria-label="Mark assistant response as not helpful"
                                      aria-pressed={assistantFeedbackByMessageId[item.id] === 'down'}
                                      onClick={() => handleAssistantFeedback(item.id, 'down')}
                                    >
                                      <ThumbsDown className="size-3.5" />
                                    </Button>
                                  </MessageAction>
                                </MessageActions>
                              </div>
                            ) : (
                              <MessageContent from="user" className="bg-primary text-primary-foreground max-w-[85%] sm:max-w-[75%]">
                                {item.text}
                              </MessageContent>
                            )
                          ) : null}
                          {attachments.length > 0 ? (
                            <div className="max-w-[85%] rounded-2xl border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-primary sm:max-w-[75%]">
                              <p className="font-medium">
                                {attachments.length === 1 ? '1 attachment' : `${attachments.length} attachments`}
                              </p>
                              <p className="mt-0.5 truncate font-mono text-[11px]">
                                {attachmentSummary}
                              </p>
                            </div>
                          ) : null}
                        </Message>
                      )
                    }

                    return (
                      <div key={item.id} className="mx-auto w-full max-w-4xl px-0 md:px-6">
                        <Tool
                          className="max-w-[85%] sm:max-w-[75%]"
                          toolPart={{
                            type: item.toolType,
                            state: item.state,
                            input: item.input,
                            output: item.output,
                            toolCallId: item.toolCallId,
                            errorText: item.errorText,
                          }}
                          defaultOpen={false}
                        />
                      </div>
                    )
                  })
                )}

                {showPreResponseShimmer ? (
                  <div className="mx-auto w-full max-w-4xl px-0 py-1 md:px-6">
                    <Reasoning open={reasoningOpen} onOpenChange={setReasoningOpen} isStreaming={showPreResponseShimmer}>
                      <ThinkingBar
                        text={waitingApproval ? 'Waiting for approval' : 'Deep reasoning in progress'}
                        stopLabel="Skip thinking"
                        onStop={() => void handleStopThinking()}
                        onClick={() => setReasoningOpen((open) => !open)}
                      />
                      <ReasoningContent className="mt-1 ml-2 border-l-2 border-l-slate-200 px-2 pb-1 dark:border-l-slate-700">
                        <div className="text-muted-foreground whitespace-pre-wrap text-xs leading-relaxed">
                          {reasoningText}
                        </div>
                      </ReasoningContent>
                    </Reasoning>
                  </div>
                ) : null}

                <ChatContainerScrollAnchor />
              </ChatContainerContent>
              <div className="absolute right-7 bottom-4 z-10">
                <ScrollButton className="bg-primary text-primary-foreground hover:bg-primary/90" variant="default" size="icon" />
              </div>
            </ChatContainerRoot>
          </div>

          <div>
            {error ? (
              <div className="mx-auto w-full max-w-4xl px-0 md:px-6">
                <p className="text-destructive mb-2 px-1 text-xs">{error}</p>
              </div>
            ) : null}

            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              multiple
              onChange={(event) => void handleFileSelect(event)}
            />

            <div className="mx-auto w-full max-w-4xl px-0 md:px-6">
              <PromptInput
                value={input}
                onValueChange={setInput}
                onSubmit={() => void handleSend()}
                isLoading={!!runId || isSending}
                disabled={isComposerDisabled}
                className="border shadow-sm"
              >
                {draftAttachments.length > 0 ? (
                  <div className="flex flex-wrap gap-2 px-2 pt-2">
                    {draftAttachments.map((attachment) => (
                      <div key={attachment.id} className="bg-muted/70 flex items-center gap-1 rounded-full border px-2 py-1 text-xs">
                        <span className="max-w-[180px] truncate font-mono">{attachment.name}</span>
                        <span className="text-muted-foreground">{formatFileSize(attachment.sizeBytes)}</span>
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground inline-flex items-center"
                          onClick={() => handleRemoveAttachment(attachment.id)}
                          aria-label={`Remove ${attachment.name}`}
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}

                <PromptInputTextarea placeholder="Ask anything about your design..." />
                <PromptInputActions className="items-center">
                  <PromptInputAction className="gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 rounded-full"
                      disabled={isComposerDisabled}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Paperclip className="size-4" />
                    </Button>

                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 gap-1 rounded-full px-3 font-mono text-[11px]"
                          disabled={isComposerDisabled || isChangingModel}
                        >
                          {activeModelLabel}
                          <ChevronDown className="size-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="min-w-[240px]">
                        {installedModels.length === 0 ? (
                          <DropdownMenuItem
                            disabled
                            className="text-muted-foreground cursor-default font-mono text-[11px]"
                          >
                            No installed models
                          </DropdownMenuItem>
                        ) : (
                          quickSwitchModels.map((model) => (
                            <DropdownMenuItem key={model} onSelect={() => void handleSwitchModel(model)}>
                              <span className="font-mono text-[11px]">{model}</span>
                              {model === activeModelLabel ? <Check className="ml-auto size-3.5" /> : null}
                            </DropdownMenuItem>
                          ))
                        )}
                        <DropdownMenuItem
                          onSelect={() => {
                            if (!runtimeStatus?.daemonReachable) {
                              openSetupDialog(false)
                              return
                            }
                            setModelDialogOpen(true)
                          }}
                        >
                          {hasMoreModels ? 'See all models...' : 'Manage models...'}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>

                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 gap-1 rounded-full px-3 text-[11px]"
                          disabled={isComposerDisabled}
                        >
                          <Shield className="size-3.5" />
                          {permissionModeLabel}
                          <ChevronDown className="size-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="min-w-[200px]">
                        <DropdownMenuItem onSelect={() => void handlePermissionModeChange('run-everything')}>
                          Run Everything
                          {permissionMode === 'run-everything' ? <Check className="ml-auto size-3.5" /> : null}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void handlePermissionModeChange('ask-every-time')}>
                          Ask Every Time
                          {permissionMode === 'ask-every-time' ? <Check className="ml-auto size-3.5" /> : null}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </PromptInputAction>

                  <PromptInputAction className="ml-auto" tooltip="Send">
                    <Button type="submit" size="icon" className="size-9 rounded-full" disabled={!canSend}>
                      <SendHorizontal className="size-4" />
                    </Button>
                  </PromptInputAction>
                </PromptInputActions>
              </PromptInput>
            </div>
          </div>
        </div>
      </div>

      <Sheet open={threadDrawerOpen} onOpenChange={setThreadDrawerOpen}>
        <SheetContent side="left" className="w-[360px] sm:max-w-[360px]">
          <SheetHeader className="pb-2">
            <SheetTitle>Assistant Threads</SheetTitle>
            <SheetDescription>
              {threads.length} thread{threads.length === 1 ? '' : 's'} · Ollama ({runtimeStatus?.defaultModel ?? 'gemma4:e4b'})
            </SheetDescription>
          </SheetHeader>

          <div className="flex flex-1 min-h-0 flex-col px-4 pb-4">
            <Button size="sm" onClick={() => void handleCreateThread()}>
              <Plus className="size-4" />
              New Chat
            </Button>

            <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {threads.map((thread) => (
                <div
                  key={thread.id}
                  className={`group flex items-center gap-1 rounded-lg border pr-1 transition-colors ${
                    thread.id === activeThreadId
                      ? 'border-primary bg-primary/5'
                      : 'hover:bg-muted border-border'
                  }`}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 px-3 py-2 text-left"
                    onClick={() => void handleSelectThread(thread.id)}
                  >
                    <p className="truncate text-sm font-medium">{thread.title}</p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      {thread.activeModel ?? runtimeStatus?.defaultModel ?? 'No model'}
                    </p>
                  </button>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors"
                    onClick={() => void handleDeleteThread(thread.id)}
                    disabled={deletingThreadId === thread.id}
                    aria-label={`Delete ${thread.title}`}
                    title="Delete thread"
                  >
                    {deletingThreadId === thread.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-3.5" />
                    )}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <Dialog
        open={setupDialogOpen}
        onOpenChange={(open) => {
          if (open) {
            setSetupDialogOpen(true)
            return
          }
          closeSetupDialog()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set up local Ollama</DialogTitle>
            <DialogDescription>
              Ollama is required for the local assistant. Complete this onboarding: install Ollama, run it, then install <b>gemma4:e4b</b>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-1 gap-2">
              <div className="rounded-md border p-2">
                <p className="text-muted-foreground text-xs">Ollama API</p>
                <p className="font-medium">{runtimeStatus?.daemonReachable ? 'Reachable' : 'Not reachable'}</p>
              </div>
            </div>

            <div className="space-y-1.5 rounded-md border p-3">
              <p className="font-medium">Onboarding</p>
              <ol className="space-y-2 pl-5">
                <li>
                  <p className="font-medium">Install Ollama</p>
                  <p className="text-muted-foreground text-xs">
                    {setupGuide?.steps?.[0] ?? 'Install Ollama from the official website.'}
                  </p>
                </li>
                <li>
                  <p className="font-medium">Run Ollama</p>
                  <code className="mt-1 block rounded bg-muted px-2 py-1 text-xs">
                    {setupGuide?.serveCommand ?? 'ollama serve'}
                  </code>
                </li>
                <li>
                  <p className="font-medium">Install default model</p>
                  <code className="mt-1 block rounded bg-muted px-2 py-1 text-xs">
                    {setupGuide?.pullCommand ?? 'ollama pull gemma4:e4b'}
                  </code>
                  <code className="mt-1 block rounded bg-muted px-2 py-1 text-xs">
                    {setupGuide?.verifyCommand ?? 'ollama list'}
                  </code>
                </li>
              </ol>
            </div>
          </div>
          <DialogFooter>
            {setupGuide ? (
              <Button
                variant="outline"
                onClick={() => {
                  void window.electron.shell.openExternal(setupGuide.installUrl)
                }}
              >
                Open Guide
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => void handleRecheckSetup()} disabled={isRecheckingModels}>
              {isRecheckingModels ? <Loader2 className="size-4 animate-spin" /> : null}
              {isRecheckingModels ? 'Checking...' : 'Recheck'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={modelDialogOpen}
        onOpenChange={(open) => {
          if (!open && runtimeStatus?.daemonReachable && runtimeStatus?.needsModelSelection) {
            return
          }
          setModelDialogOpen(open)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Select a model</DialogTitle>
            <DialogDescription>
              Choose a locally installed Ollama model. A <b>multimodal reasoning model</b> is recommended for image-based tasks.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {selectableModels.length > 0 ? (
              <select
                className="bg-background w-full rounded-md border px-3 py-2 text-sm"
                value={selectedModel}
                onChange={(event) => setSelectedModel(event.target.value)}
              >
                {selectableModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            ) : null}
            {visionModels.length === 0 && installedModels.length > 0 ? (
              <p className="text-muted-foreground text-sm">
                No vision model detected. Install a vision-capable model such as <code>qwen2.5-vl</code>, <code>llava</code>, or <code>gemma3</code>.
              </p>
            ) : null}
            {installedModels.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {runtimeStatus?.daemonReachable
                  ? 'No local models were found. Pull a model in Ollama, then click Recheck.'
                  : 'Ollama is installed, but the daemon is not reachable. Start `ollama serve`, then click Recheck.'}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => void handleRecheckModels()} disabled={isRecheckingModels}>
              {isRecheckingModels ? <Loader2 className="size-4 animate-spin" /> : null}
              {isRecheckingModels ? 'Checking...' : 'Recheck'}
            </Button>
            <Button onClick={() => void handleApplyModel()} disabled={!selectedModel || !activeThreadId || isRecheckingModels || selectableModels.length === 0}>
              Use Selected Model
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!approvalRequest} onOpenChange={() => void 0}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Approve Design Change</DialogTitle>
            <DialogDescription>
              This tool can modify your Figma file. Approve to continue.
            </DialogDescription>
          </DialogHeader>
          {approvalRequest ? (
            <div className="space-y-2 rounded-md border p-3 text-sm">
              <p>
                <b>Tool:</b> {approvalRequest.toolName}
              </p>
              <p>
                <b>Safety:</b> {approvalRequest.safety}
              </p>
              <pre className="bg-muted max-h-40 overflow-auto rounded p-2 text-xs">
                {JSON.stringify(approvalRequest.args, null, 2)}
              </pre>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => void handleApproval(false)}>
              Reject
            </Button>
            <Button onClick={() => void handleApproval(true)}>Approve</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
