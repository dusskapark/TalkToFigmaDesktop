import { useEffect, useRef, useState, type ChangeEvent } from 'react'

import { useToast } from '@/hooks/use-toast'
import { SseMigrationDialog } from '@/components/SseMigrationDialog'
import type { AssistantRuntimeStatus } from '@/shared/types'
import { ASSISTANT_CONTEXT_LENGTH, ASSISTANT_TOOL_RESULT_LIMITS, STORE_KEYS } from '@/shared/constants'
import {
  AssistantRuntimeSettingsSection,
  McpConfigSection,
  ModelSettingsSection,
  ServerInfoSection,
} from './settings/SettingsSections'
import { filePathOf, normalizeContextLength, normalizeToolResultLimit } from './settings/utils'

interface SettingsPageProps {
  onNavigateToSettings?: () => void
}

export function SettingsPage({ onNavigateToSettings }: SettingsPageProps) {
  const { toast } = useToast()
  const [stdioPath, setStdioPath] = useState<string>('Loading...')
  const [showMigrationDialog, setShowMigrationDialog] = useState(false)

  const [runtimeStatus, setRuntimeStatus] = useState<AssistantRuntimeStatus | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [ggufFile, setGgufFile] = useState<File | null>(null)
  const [mmprojFile, setMmprojFile] = useState<File | null>(null)
  const [isWorking, setIsWorking] = useState(false)
  const [contextLength, setContextLength] = useState<number>(ASSISTANT_CONTEXT_LENGTH.DEFAULT)
  const [toolResultLimitCurrent, setToolResultLimitCurrent] = useState<number>(ASSISTANT_TOOL_RESULT_LIMITS.CURRENT_DEFAULT)
  const [toolResultLimitHistory, setToolResultLimitHistory] = useState<number>(ASSISTANT_TOOL_RESULT_LIMITS.HISTORY_DEFAULT)

  const ggufInputRef = useRef<HTMLInputElement | null>(null)
  const mmprojInputRef = useRef<HTMLInputElement | null>(null)

  const recommendedModel = runtimeStatus?.recommendedModel
  const isDownloading = runtimeStatus?.downloadState === 'downloading' || runtimeStatus?.downloadState === 'verifying'

  const refreshModelStatus = async () => {
    const status = await window.electron.assistant.getRuntimeStatus()
    setRuntimeStatus(status)
  }

  useEffect(() => {
    if (window.electron?.mcp?.getStdioPath) {
      void window.electron.mcp.getStdioPath().then(path => {
        setStdioPath(path)
      }).catch(() => {
        setStdioPath('Error loading path')
      })
    } else {
      setStdioPath('Not available')
    }

    void refreshModelStatus()
    void window.electron.settings.get<number>(STORE_KEYS.ASSISTANT_CONTEXT_LENGTH).then((value) => {
      setContextLength(normalizeContextLength(value))
    })
    void window.electron.settings.get<number>(STORE_KEYS.ASSISTANT_TOOL_RESULT_LIMIT_CURRENT).then((value) => {
      setToolResultLimitCurrent(normalizeToolResultLimit(value, ASSISTANT_TOOL_RESULT_LIMITS.CURRENT_DEFAULT))
    })
    void window.electron.settings.get<number>(STORE_KEYS.ASSISTANT_TOOL_RESULT_LIMIT_HISTORY).then((value) => {
      setToolResultLimitHistory(normalizeToolResultLimit(value, ASSISTANT_TOOL_RESULT_LIMITS.HISTORY_DEFAULT))
    })
    const unsubscribeAssistantStatus = window.electron.assistant.onRuntimeStatusChanged((status) => {
      setRuntimeStatus(status)
    })

    return () => {
      unsubscribeAssistantStatus()
    }
  }, [])

  const copyStdioPath = () => {
    if (stdioPath && stdioPath !== 'Loading...' && stdioPath !== 'Error loading path') {
      navigator.clipboard.writeText(stdioPath)
      toast({
        title: 'Copied to clipboard',
        description: 'Stdio server path has been copied',
      })
    }
  }

  const handleDownloadRecommendedModel = async () => {
    if (!recommendedModel) return
    setIsWorking(true)
    try {
      const result = await window.electron.assistant.downloadModel(recommendedModel.id)
      if (!result.success) {
        toast({
          variant: 'destructive',
          title: 'Model download failed',
          description: result.error ?? 'Retry is required.',
        })
      }
      await refreshModelStatus()
    } finally {
      setIsWorking(false)
    }
  }

  const handleUploadModel = async () => {
    const ggufPath = filePathOf(ggufFile)
    if (!ggufPath) {
      toast({
        variant: 'destructive',
        title: 'GGUF file required',
        description: 'Select a GGUF file before uploading.',
      })
      return
    }

    setIsWorking(true)
    try {
      const result = await window.electron.assistant.uploadModel({
        ggufPath,
        ...(filePathOf(mmprojFile) ? { mmprojPath: filePathOf(mmprojFile) ?? undefined } : {}),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      })

      if (!result.success) {
        toast({
          variant: 'destructive',
          title: 'Upload failed',
          description: result.error ?? 'Could not upload model files.',
        })
        return
      }

      toast({
        title: 'Model uploaded',
        description: 'The model was registered successfully.',
      })
      setGgufFile(null)
      setMmprojFile(null)
      setDisplayName('')
      if (ggufInputRef.current) ggufInputRef.current.value = ''
      if (mmprojInputRef.current) mmprojInputRef.current.value = ''
      await refreshModelStatus()
    } finally {
      setIsWorking(false)
    }
  }

  const handleActivateModel = async (modelId: string) => {
    setIsWorking(true)
    try {
      const result = await window.electron.assistant.setActiveModel('', modelId)
      if (!result.success) {
        toast({
          variant: 'destructive',
          title: 'Activation failed',
          description: result.error ?? 'Could not activate the model.',
        })
        return
      }
      toast({
        title: 'Model activated',
        description: `${modelId} is now the active default model.`,
      })
      await refreshModelStatus()
    } finally {
      setIsWorking(false)
    }
  }

  const handleDeleteModel = async (modelId: string) => {
    const confirmed = window.confirm(`Delete model ${modelId}?`)
    if (!confirmed) return

    setIsWorking(true)
    try {
      const result = await window.electron.assistant.deleteModel(modelId)
      if (!result.success) {
        toast({
          variant: 'destructive',
          title: 'Delete failed',
          description: result.error ?? 'Could not delete model.',
        })
        return
      }
      toast({
        title: 'Model deleted',
        description: `${modelId} was removed.`,
      })
      await refreshModelStatus()
    } finally {
      setIsWorking(false)
    }
  }

  const handleSelectGguf = (event: ChangeEvent<HTMLInputElement>) => {
    setGgufFile(event.target.files?.[0] ?? null)
  }

  const handleSelectMmproj = (event: ChangeEvent<HTMLInputElement>) => {
    setMmprojFile(event.target.files?.[0] ?? null)
  }

  const handleContextLengthChange = (values: number[]) => {
    const nextIndex = Math.max(0, Math.min(ASSISTANT_CONTEXT_LENGTH.OPTIONS.length - 1, Math.round(values[0] ?? 0)))
    const nextContextLength = ASSISTANT_CONTEXT_LENGTH.OPTIONS[nextIndex] ?? ASSISTANT_CONTEXT_LENGTH.DEFAULT
    setContextLength(nextContextLength)
    void window.electron.settings.set(STORE_KEYS.ASSISTANT_CONTEXT_LENGTH, nextContextLength)
  }

  const handleToolResultLimitCurrentChange = (values: number[]) => {
    const nextIndex = Math.max(0, Math.min(ASSISTANT_TOOL_RESULT_LIMITS.OPTIONS.length - 1, Math.round(values[0] ?? 0)))
    const nextValue = ASSISTANT_TOOL_RESULT_LIMITS.OPTIONS[nextIndex] ?? ASSISTANT_TOOL_RESULT_LIMITS.CURRENT_DEFAULT
    setToolResultLimitCurrent(nextValue)
    void window.electron.settings.set(STORE_KEYS.ASSISTANT_TOOL_RESULT_LIMIT_CURRENT, nextValue)
  }

  const handleToolResultLimitHistoryChange = (values: number[]) => {
    const nextIndex = Math.max(0, Math.min(ASSISTANT_TOOL_RESULT_LIMITS.OPTIONS.length - 1, Math.round(values[0] ?? 0)))
    const nextValue = ASSISTANT_TOOL_RESULT_LIMITS.OPTIONS[nextIndex] ?? ASSISTANT_TOOL_RESULT_LIMITS.HISTORY_DEFAULT
    setToolResultLimitHistory(nextValue)
    void window.electron.settings.set(STORE_KEYS.ASSISTANT_TOOL_RESULT_LIMIT_HISTORY, nextValue)
  }

  return (
    <div className="space-y-6 w-full pb-6">
      <ModelSettingsSection
        runtimeStatus={runtimeStatus}
        displayName={displayName}
        ggufFile={ggufFile}
        mmprojFile={mmprojFile}
        isWorking={isWorking || isDownloading}
        ggufInputRef={ggufInputRef}
        mmprojInputRef={mmprojInputRef}
        onDisplayNameChange={setDisplayName}
        onSelectGguf={handleSelectGguf}
        onSelectMmproj={handleSelectMmproj}
        onDownloadRecommendedModel={() => void handleDownloadRecommendedModel()}
        onRefreshModelStatus={() => void refreshModelStatus()}
        onUploadModel={() => void handleUploadModel()}
        onActivateModel={(modelId) => void handleActivateModel(modelId)}
        onDeleteModel={(modelId) => void handleDeleteModel(modelId)}
      />

      <AssistantRuntimeSettingsSection
        contextLength={contextLength}
        toolResultLimitCurrent={toolResultLimitCurrent}
        toolResultLimitHistory={toolResultLimitHistory}
        onContextLengthChange={handleContextLengthChange}
        onToolResultLimitCurrentChange={handleToolResultLimitCurrentChange}
        onToolResultLimitHistoryChange={handleToolResultLimitHistoryChange}
      />

      <McpConfigSection />

      <ServerInfoSection
        stdioPath={stdioPath}
        onCopyStdioPath={copyStdioPath}
        onPreviewMigration={() => setShowMigrationDialog(true)}
      />

      <SseMigrationDialog
        open={showMigrationDialog}
        onClose={() => setShowMigrationDialog(false)}
        onGoToSettings={onNavigateToSettings}
      />
    </div>
  )
}
