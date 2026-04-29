import { useState, type ChangeEvent, type RefObject } from 'react'
import { Link2, Copy, AlertTriangle, ChevronDown, Cpu, Download, Loader2, RefreshCw, Terminal, Trash2, Upload } from 'lucide-react'
import { Figma, MCP } from '@lobehub/icons'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { McpMultiClientConfig } from '@/components/mcp'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import type { AssistantRuntimeBackend, AssistantRuntimeStatus } from '@/shared/types'
import { ASSISTANT_CONTEXT_LENGTH, ASSISTANT_TOOL_RESULT_LIMITS } from '@/shared/constants'
import { APP_LOCALE_OPTIONS, AppLocale, localeLabels } from '@/shared/i18n'
import { formatBytes, formatContextLength, formatEta } from './utils'
import { useLocale } from '@/components/LocaleProvider'
import { useTranslation } from 'react-i18next'

interface ModelSettingsSectionProps {
  runtimeStatus: AssistantRuntimeStatus | null
  displayName: string
  ggufFile: File | null
  mmprojFile: File | null
  isWorking: boolean
  ggufInputRef: RefObject<HTMLInputElement | null>
  mmprojInputRef: RefObject<HTMLInputElement | null>
  onDisplayNameChange: (value: string) => void
  onSelectGguf: (event: ChangeEvent<HTMLInputElement>) => void
  onSelectMmproj: (event: ChangeEvent<HTMLInputElement>) => void
  onDownloadRecommendedModel: () => void
  onRefreshModelStatus: () => void
  onRuntimeBackendChange: (backend: AssistantRuntimeBackend) => void
  onCopyPullCommand: (modelId: string) => void
  onUploadModel: () => void
  onActivateModel: (modelId: string) => void
  onDeleteModel: (modelId: string) => void
}

export function LanguageSettingsSection() {
  const { t } = useTranslation()
  const { locale, setLocale } = useLocale()

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.language.title')}</CardTitle>
        <CardDescription>{t('settings.language.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <Select value={locale} onValueChange={(value) => void setLocale(value as AppLocale)}>
          <SelectTrigger className="w-full sm:w-[240px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {APP_LOCALE_OPTIONS.map((option: AppLocale) => (
              <SelectItem key={option} value={option}>
                {option === 'system' ? t('settings.language.systemDefault') : localeLabels[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardContent>
    </Card>
  )
}

export function ModelSettingsSection({
  runtimeStatus,
  displayName,
  ggufFile,
  mmprojFile,
  isWorking,
  ggufInputRef,
  mmprojInputRef,
  onDisplayNameChange,
  onSelectGguf,
  onSelectMmproj,
  onDownloadRecommendedModel,
  onRefreshModelStatus,
  onRuntimeBackendChange,
  onCopyPullCommand,
  onUploadModel,
  onActivateModel,
  onDeleteModel,
}: ModelSettingsSectionProps) {
  const { t } = useTranslation()
  const [showUploadPanel, setShowUploadPanel] = useState(false)
  const recommendedModel = runtimeStatus?.recommendedModel
  const recommendedSizeBytes = (recommendedModel?.modelSizeBytes ?? 0) + (recommendedModel?.mmprojSizeBytes ?? 0)
  const downloadProgress = runtimeStatus?.downloadProgress
  const progressPercent = downloadProgress && downloadProgress.totalBytes > 0
    ? Math.min(100, Math.max(0, (downloadProgress.downloadedBytes / downloadProgress.totalBytes) * 100))
    : 0
  const isDownloading = runtimeStatus?.downloadState === 'downloading' || runtimeStatus?.downloadState === 'verifying'
  const runtimeBinaryReady = runtimeStatus?.runtimeBinaryReady ?? false
  const runtimeBinaryPath = runtimeStatus?.runtimeBinaryPath ?? null
  const sortedInstalledModels = [...(runtimeStatus?.installedModelDetails ?? [])].sort((a, b) => b.installedAt - a.installedAt)
  const backend = runtimeStatus?.backend ?? 'embedded'
  const isOllama = backend === 'ollama'
  const hasInstalledModels = sortedInstalledModels.length > 0
  const showRecommendedCard = !isOllama && (!hasInstalledModels || runtimeStatus?.downloadState === 'downloading' || runtimeStatus?.downloadState === 'verifying' || runtimeStatus?.downloadState === 'failed')
  const ollamaPullModel = sortedInstalledModels[0]?.id ?? recommendedModel?.id ?? 'gemma4:e4b'
  const runtimeStatusLabel = isOllama
    ? runtimeStatus?.daemonReachable
      ? runtimeStatus.modelInstalled ? t('settings.model.ready') : t('settings.model.noModels')
      : t('settings.model.daemonOffline')
    : runtimeBinaryReady
      ? t('settings.model.ready')
      : t('settings.model.missingRuntime')

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cpu className="size-5" />
          {t('settings.model.title')}
        </CardTitle>
        <CardDescription>
          {t('settings.model.description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            className={`rounded-lg border p-3 text-left transition-colors ${
              backend === 'embedded' ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
            }`}
            onClick={() => onRuntimeBackendChange('embedded')}
            disabled={isWorking}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium">Embedded</p>
              <span className="rounded-md border bg-background px-2 py-0.5 text-[11px]">
                {backend === 'embedded' ? runtimeStatusLabel : t('settings.model.bundled')}
              </span>
            </div>
            <p className="text-muted-foreground mt-1 text-xs">
              {t('settings.model.embeddedDescription')}
            </p>
          </button>
          <button
            type="button"
            className={`rounded-lg border p-3 text-left transition-colors ${
              backend === 'ollama' ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
            }`}
            onClick={() => onRuntimeBackendChange('ollama')}
            disabled={isWorking}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium">Ollama</p>
              <span className="rounded-md border bg-background px-2 py-0.5 text-[11px]">
                {backend === 'ollama' ? runtimeStatusLabel : t('settings.model.external')}
              </span>
            </div>
            <p className="text-muted-foreground mt-1 text-xs">
              {t('settings.model.connectOllama')}
            </p>
          </button>
        </div>

        {isOllama ? (
          <div className="rounded-lg border p-3 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium">{t('settings.model.ollamaDaemon')}</p>
                <p className="text-muted-foreground text-xs">
                  {runtimeStatus?.baseUrl ?? 'http://127.0.0.1:11434'}
                </p>
              </div>
              <Button variant="outline" onClick={onRefreshModelStatus} disabled={isWorking}>
                <RefreshCw className="size-4" />
                {t('common.refresh')}
              </Button>
            </div>

            {runtimeStatus?.error ? (
              <p className="text-destructive text-xs">{runtimeStatus.error}</p>
            ) : null}

            {sortedInstalledModels.length === 0 ? (
              <div className="rounded-md border bg-muted/20 p-3">
                <div className="flex items-start gap-2">
                  <Terminal className="text-muted-foreground mt-0.5 size-4" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{t('settings.model.pullModel')}</p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t('settings.model.pullModelDescription')}
                    </p>
                    <code className="mt-2 block rounded-md bg-background px-2 py-1 text-xs">
                      ollama pull {ollamaPullModel}
                    </code>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => onCopyPullCommand(ollamaPullModel)}>
                    <Copy className="size-4" />
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : showRecommendedCard ? (
          <EmbeddedRecommendedModelCard
            recommendedModel={recommendedModel}
            recommendedSizeBytes={recommendedSizeBytes}
            runtimeStatus={runtimeStatus}
            runtimeBinaryReady={runtimeBinaryReady}
            runtimeBinaryPath={runtimeBinaryPath}
            progressPercent={progressPercent}
            downloadProgress={downloadProgress}
            isWorking={isWorking}
            isDownloading={isDownloading}
            onDownloadRecommendedModel={onDownloadRecommendedModel}
            onRefreshModelStatus={onRefreshModelStatus}
          />
        ) : null}

        <div className="rounded-lg border p-3 space-y-2">
          <p className="font-medium">{isOllama ? t('settings.model.ollamaModels') : t('settings.model.installedModels')}</p>
          {sortedInstalledModels.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {isOllama ? t('settings.model.noOllamaModelsFound') : t('settings.model.noInstalledModelsYet')}
            </p>
          ) : (
            sortedInstalledModels.map((model) => {
              const isActive = runtimeStatus?.activeModel === model.id
              return (
                <div key={model.id} className="rounded-md border bg-muted/20 p-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{model.displayName}</p>
                      <p className="text-muted-foreground truncate text-xs">
                        {model.id} · {model.source} · {formatBytes(model.modelSizeBytes + (model.mmprojSizeBytes ?? 0))}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="sm"
                        variant={isActive ? 'secondary' : 'outline'}
                        onClick={() => onActivateModel(model.id)}
                        disabled={isWorking || isActive}
                      >
                        {isActive ? t('settings.model.active') : t('settings.model.activate')}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => onDeleteModel(model.id)}
                        disabled={isWorking || isOllama}
                        aria-label={isOllama
                          ? t('settings.model.manageWithOllama', { model: model.displayName })
                          : t('settings.model.deleteModel', { model: model.displayName })}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })
          )}
          {!isOllama ? (
            <EmbeddedUploadSection
              showUploadPanel={showUploadPanel}
              onToggle={() => setShowUploadPanel((current) => !current)}
              ggufInputRef={ggufInputRef}
              mmprojInputRef={mmprojInputRef}
              ggufFile={ggufFile}
              mmprojFile={mmprojFile}
              displayName={displayName}
              isWorking={isWorking}
              onSelectGguf={onSelectGguf}
              onSelectMmproj={onSelectMmproj}
              onDisplayNameChange={onDisplayNameChange}
              onUploadModel={onUploadModel}
            />
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

function EmbeddedRecommendedModelCard({
  recommendedModel,
  recommendedSizeBytes,
  runtimeStatus,
  runtimeBinaryReady,
  runtimeBinaryPath,
  progressPercent,
  downloadProgress,
  isWorking,
  isDownloading,
  onDownloadRecommendedModel,
  onRefreshModelStatus,
}: {
  recommendedModel: AssistantRuntimeStatus['recommendedModel'] | undefined
  recommendedSizeBytes: number
  runtimeStatus: AssistantRuntimeStatus | null
  runtimeBinaryReady: boolean
  runtimeBinaryPath: string | null
  progressPercent: number
  downloadProgress: AssistantRuntimeStatus['downloadProgress']
  isWorking: boolean
  isDownloading: boolean
  onDownloadRecommendedModel: () => void
  onRefreshModelStatus: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="rounded-lg border p-3 space-y-2">
      <p className="font-medium">{t('settings.model.recommendedModel')}</p>
      <p className="text-sm">{recommendedModel?.displayName ?? 'gemma4:e4b'}</p>
      <p className="text-muted-foreground text-xs">
        {recommendedModel?.id ?? 'gemma4:e4b'} · {formatBytes(recommendedSizeBytes)}
      </p>
      <p className="text-muted-foreground text-xs capitalize">
        {t('settings.model.downloadState', { state: runtimeStatus?.downloadState ?? 'idle' })}
      </p>
      <p className="text-muted-foreground text-xs">
        {t('settings.model.runtimeStatus', { status: runtimeBinaryReady ? t('settings.model.ready') : t('settings.model.missingRuntime') })}
        {runtimeStatus?.runtimeBinarySource ? ` (${runtimeStatus.runtimeBinarySource})` : ''}
      </p>
      {runtimeBinaryPath ? (
        <p className="text-muted-foreground break-all text-[11px]">
          {runtimeBinaryPath}
        </p>
      ) : null}

      {downloadProgress ? (
        <div className="space-y-2 pt-1">
          <Progress value={progressPercent} />
          <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            <span>{formatBytes(downloadProgress.downloadedBytes)} / {formatBytes(downloadProgress.totalBytes)}</span>
            <span>{formatBytes(downloadProgress.speedBytesPerSecond)}/s</span>
            <span>ETA {formatEta(downloadProgress.etaSeconds)}</span>
            {downloadProgress.currentFile ? <span>{downloadProgress.currentFile}</span> : null}
          </div>
        </div>
      ) : null}

      {runtimeStatus?.error ? (
        <p className="text-destructive text-xs">{runtimeStatus.error}</p>
      ) : null}

      <div className="flex items-center gap-2 pt-1">
        <Button onClick={onDownloadRecommendedModel} disabled={isWorking || isDownloading}>
          {isWorking || isDownloading ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
          {runtimeStatus?.downloadState === 'failed' ? t('settings.model.retryDownload') : t('settings.model.downloadRecommended')}
        </Button>
        <Button variant="outline" onClick={onRefreshModelStatus} disabled={isWorking}>
          {t('common.refresh')}
        </Button>
      </div>
    </div>
  )
}

function EmbeddedUploadSection({
  showUploadPanel,
  onToggle,
  ggufInputRef,
  mmprojInputRef,
  ggufFile,
  mmprojFile,
  displayName,
  isWorking,
  onSelectGguf,
  onSelectMmproj,
  onDisplayNameChange,
  onUploadModel,
}: {
  showUploadPanel: boolean
  onToggle: () => void
  ggufInputRef: RefObject<HTMLInputElement | null>
  mmprojInputRef: RefObject<HTMLInputElement | null>
  ggufFile: File | null
  mmprojFile: File | null
  displayName: string
  isWorking: boolean
  onSelectGguf: (event: ChangeEvent<HTMLInputElement>) => void
  onSelectMmproj: (event: ChangeEvent<HTMLInputElement>) => void
  onDisplayNameChange: (value: string) => void
  onUploadModel: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="border-t pt-3 mt-3 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-medium text-sm">{t('settings.model.addCustomModel')}</p>
          <p className="text-muted-foreground text-xs">
            {t('settings.model.addCustomModelDescription')}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onToggle} disabled={isWorking}>
          <ChevronDown className={`size-4 transition-transform ${showUploadPanel ? 'rotate-180' : ''}`} />
          {showUploadPanel ? t('common.hide') : t('common.open')}
        </Button>
      </div>

      {showUploadPanel ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => ggufInputRef.current?.click()} disabled={isWorking}>
              <Upload className="size-4" />
              {t('settings.model.selectGguf')}
            </Button>
            <Button variant="outline" onClick={() => mmprojInputRef.current?.click()} disabled={isWorking}>
              <Upload className="size-4" />
              {t('settings.model.selectMmproj')}
            </Button>
          </div>
          <input ref={ggufInputRef} type="file" accept=".gguf" className="hidden" onChange={onSelectGguf} />
          <input ref={mmprojInputRef} type="file" accept=".gguf" className="hidden" onChange={onSelectMmproj} />
          <p className="text-muted-foreground text-xs">GGUF: {ggufFile?.name ?? t('settings.model.notSelected')}</p>
          <p className="text-muted-foreground text-xs">mmproj: {mmprojFile?.name ?? t('settings.model.notSelected')}</p>
          <Input
            value={displayName}
            onChange={(event) => onDisplayNameChange(event.target.value)}
            placeholder={t('settings.model.displayNamePlaceholder')}
            disabled={isWorking}
          />
          <Button onClick={onUploadModel} disabled={isWorking || !ggufFile}>
            {isWorking ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            {t('settings.model.uploadModel')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

interface AssistantRuntimeSettingsSectionProps {
  contextLength: number
  toolResultLimitCurrent: number
  toolResultLimitHistory: number
  onContextLengthChange: (values: number[]) => void
  onToolResultLimitCurrentChange: (values: number[]) => void
  onToolResultLimitHistoryChange: (values: number[]) => void
}

export function AssistantRuntimeSettingsSection({
  contextLength,
  toolResultLimitCurrent,
  toolResultLimitHistory,
  onContextLengthChange,
  onToolResultLimitCurrentChange,
  onToolResultLimitHistoryChange,
}: AssistantRuntimeSettingsSectionProps) {
  const { t } = useTranslation()
  const contextLengthIndex = Math.max(0, ASSISTANT_CONTEXT_LENGTH.OPTIONS.findIndex((value) => value === contextLength))
  const toolResultLimitCurrentIndex = Math.max(0, ASSISTANT_TOOL_RESULT_LIMITS.OPTIONS.findIndex((value) => value === toolResultLimitCurrent))
  const toolResultLimitHistoryIndex = Math.max(0, ASSISTANT_TOOL_RESULT_LIMITS.OPTIONS.findIndex((value) => value === toolResultLimitHistory))

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cpu className="size-5" />
          {t('settings.model.assistantRuntime')}
        </CardTitle>
        <CardDescription>
          {t('settings.model.assistantRuntimeDescription')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="rounded-lg border p-4 space-y-4">
          <RuntimeSlider
            title={t('settings.model.contextLength')}
            description={t('settings.model.contextLengthDescription')}
            value={contextLength}
            index={contextLengthIndex}
            options={ASSISTANT_CONTEXT_LENGTH.OPTIONS}
            onValueChange={onContextLengthChange}
          />
          <RuntimeSlider
            title={t('settings.model.toolResponseContext')}
            description={t('settings.model.toolResponseContextDescription')}
            value={toolResultLimitCurrent}
            index={toolResultLimitCurrentIndex}
            options={ASSISTANT_TOOL_RESULT_LIMITS.OPTIONS}
            onValueChange={onToolResultLimitCurrentChange}
          />
          <RuntimeSlider
            title={t('settings.model.toolHistoryContext')}
            description={t('settings.model.toolHistoryContextDescription')}
            value={toolResultLimitHistory}
            index={toolResultLimitHistoryIndex}
            options={ASSISTANT_TOOL_RESULT_LIMITS.OPTIONS}
            onValueChange={onToolResultLimitHistoryChange}
          />
          <div className="rounded-lg border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
            {t('settings.model.runtimeRestartNotice')}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function RuntimeSlider({
  title,
  description,
  value,
  index,
  options,
  onValueChange,
}: {
  title: string
  description: string
  value: number
  index: number
  options: readonly number[]
  onValueChange: (values: number[]) => void
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-medium">{title}</p>
          <p className="text-muted-foreground text-xs">{description}</p>
        </div>
        <div className="rounded-md border bg-muted/40 px-2 py-1 text-sm font-medium tabular-nums">
          {formatContextLength(value)}
        </div>
      </div>
      <Slider min={0} max={options.length - 1} step={1} value={[index]} onValueChange={onValueChange} />
      <div className="text-muted-foreground grid grid-cols-7 text-center text-xs font-medium tabular-nums">
        {options.map((option) => (
          <span key={option}>{formatContextLength(option)}</span>
        ))}
      </div>
    </div>
  )
}

export function McpConfigSection() {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MCP size={20} className="shrink-0" />
          {t('settings.model.mcpClientConfiguration')}
        </CardTitle>
        <CardDescription>
          {t('settings.model.mcpClientConfigurationDescription')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <McpMultiClientConfig />
      </CardContent>
    </Card>
  )
}

export function ServerInfoSection({
  stdioPath,
  onCopyStdioPath,
  onPreviewMigration,
}: {
  stdioPath: string
  onCopyStdioPath: () => void
  onPreviewMigration: () => void
}) {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="size-5" />
          {t('settings.model.serverInformation')}
        </CardTitle>
        <CardDescription>{t('settings.model.serverInformationDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-col gap-2 p-3 bg-muted rounded-lg">
          <div className="flex items-center gap-2">
            <MCP size={16} className="shrink-0 text-muted-foreground" />
            <div className="flex-1">
              <p className="font-medium">{t('settings.model.mcpServerPath')}</p>
              <p className="text-muted-foreground text-xs">{t('settings.model.stdioTransport')}</p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={onCopyStdioPath}
              disabled={!stdioPath || stdioPath === 'Loading...' || stdioPath === 'Error loading path'}
            >
              <Copy className="size-4" />
            </Button>
          </div>
          <code className="bg-background px-2 py-1 rounded text-xs break-all">
            {stdioPath}
          </code>
        </div>
        <div className="flex justify-between items-center p-3 bg-muted rounded-lg">
          <div className="flex items-center gap-2">
            <Figma size={16} className="shrink-0 text-muted-foreground" />
            <div>
              <p className="font-medium">{t('settings.model.websocketBridge')}</p>
              <p className="text-muted-foreground text-xs">{t('settings.model.websocketBridgeDescription')}</p>
            </div>
          </div>
          <code className="bg-background px-2 py-1 rounded text-xs">ws://localhost:3055</code>
        </div>
        <div className="flex justify-between items-center p-3 bg-muted rounded-lg">
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className="shrink-0 text-muted-foreground" />
            <div>
              <p className="font-medium">{t('settings.model.legacySse')}</p>
              <p className="text-muted-foreground text-xs">{t('settings.model.legacySseDescription')}</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={onPreviewMigration}>
            {t('common.preview')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
