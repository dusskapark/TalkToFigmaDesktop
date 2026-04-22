import type { ChangeEvent, RefObject } from 'react'
import { Link2, Copy, AlertTriangle, Cpu, Download, Loader2, Trash2, Upload } from 'lucide-react'
import { Figma, MCP } from '@lobehub/icons'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { McpMultiClientConfig } from '@/components/mcp'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Slider } from '@/components/ui/slider'
import type { AssistantRuntimeStatus } from '@/shared/types'
import { ASSISTANT_CONTEXT_LENGTH, ASSISTANT_TOOL_RESULT_LIMITS } from '@/shared/constants'
import { formatBytes, formatContextLength, formatEta } from './utils'

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
  onUploadModel: () => void
  onActivateModel: (modelId: string) => void
  onDeleteModel: (modelId: string) => void
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
  onUploadModel,
  onActivateModel,
  onDeleteModel,
}: ModelSettingsSectionProps) {
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cpu className="size-5" />
          Model
        </CardTitle>
        <CardDescription>
          First-run download and manual GGUF(+mmproj) upload for the local Assistant runtime.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border p-3 space-y-2">
          <p className="font-medium">Recommended model</p>
          <p className="text-sm">{recommendedModel?.displayName ?? 'gemma4:e4b'}</p>
          <p className="text-muted-foreground text-xs">
            {recommendedModel?.id ?? 'gemma4:e4b'} · {formatBytes(recommendedSizeBytes)}
          </p>
          <p className="text-muted-foreground text-xs capitalize">
            Download state: {runtimeStatus?.downloadState ?? 'idle'}
          </p>
          <p className="text-muted-foreground text-xs">
            Runtime: {runtimeBinaryReady ? 'Ready' : 'Missing'}
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
              {runtimeStatus?.downloadState === 'failed' ? 'Retry Download' : 'Download Recommended'}
            </Button>
            <Button variant="outline" onClick={onRefreshModelStatus} disabled={isWorking}>
              Refresh
            </Button>
          </div>
        </div>

        <div className="rounded-lg border p-3 space-y-3">
          <p className="font-medium">Upload GGUF model</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => ggufInputRef.current?.click()} disabled={isWorking}>
              <Upload className="size-4" />
              Select GGUF
            </Button>
            <Button variant="outline" onClick={() => mmprojInputRef.current?.click()} disabled={isWorking}>
              <Upload className="size-4" />
              Select mmproj (optional)
            </Button>
          </div>
          <input ref={ggufInputRef} type="file" accept=".gguf" className="hidden" onChange={onSelectGguf} />
          <input ref={mmprojInputRef} type="file" accept=".gguf" className="hidden" onChange={onSelectMmproj} />
          <p className="text-muted-foreground text-xs">GGUF: {ggufFile?.name ?? 'Not selected'}</p>
          <p className="text-muted-foreground text-xs">mmproj: {mmprojFile?.name ?? 'Not selected'}</p>
          <Input
            value={displayName}
            onChange={(event) => onDisplayNameChange(event.target.value)}
            placeholder="Display name (optional)"
            disabled={isWorking}
          />
          <Button onClick={onUploadModel} disabled={isWorking || !ggufFile}>
            {isWorking ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            Upload Model
          </Button>
        </div>

        <div className="rounded-lg border p-3 space-y-2">
          <p className="font-medium">Installed models</p>
          {sortedInstalledModels.length === 0 ? (
            <p className="text-muted-foreground text-sm">No installed models yet.</p>
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
                        {isActive ? 'Active' : 'Activate'}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => onDeleteModel(model.id)}
                        disabled={isWorking}
                        aria-label={`Delete ${model.displayName}`}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </CardContent>
    </Card>
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
  const contextLengthIndex = Math.max(0, ASSISTANT_CONTEXT_LENGTH.OPTIONS.findIndex((value) => value === contextLength))
  const toolResultLimitCurrentIndex = Math.max(0, ASSISTANT_TOOL_RESULT_LIMITS.OPTIONS.findIndex((value) => value === toolResultLimitCurrent))
  const toolResultLimitHistoryIndex = Math.max(0, ASSISTANT_TOOL_RESULT_LIMITS.OPTIONS.findIndex((value) => value === toolResultLimitHistory))

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cpu className="size-5" />
          Assistant Runtime
        </CardTitle>
        <CardDescription>
          Tune local context windows and tool-result context passed back to the model.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="rounded-lg border p-4 space-y-4">
          <RuntimeSlider
            title="Context length"
            description="Larger values improve memory, but increase RAM usage and may slow generation on some models."
            value={contextLength}
            index={contextLengthIndex}
            options={ASSISTANT_CONTEXT_LENGTH.OPTIONS}
            onValueChange={onContextLengthChange}
          />
          <RuntimeSlider
            title="Tool response context"
            description="Latest tool result characters passed into the next model step."
            value={toolResultLimitCurrent}
            index={toolResultLimitCurrentIndex}
            options={ASSISTANT_TOOL_RESULT_LIMITS.OPTIONS}
            onValueChange={onToolResultLimitCurrentChange}
          />
          <RuntimeSlider
            title="Tool history context"
            description="Older tool result characters rebuilt into later prompts."
            value={toolResultLimitHistory}
            index={toolResultLimitHistoryIndex}
            options={ASSISTANT_TOOL_RESULT_LIMITS.OPTIONS}
            onValueChange={onToolResultLimitHistoryChange}
          />
          <div className="rounded-lg border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
            Changes apply on the next assistant request. If the local runtime is already running, it will restart with the new context length automatically.
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
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MCP size={20} className="shrink-0" />
          MCP Client Configuration
        </CardTitle>
        <CardDescription>
          Configure TalkToFigma Desktop with your preferred MCP client
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
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="size-5" />
          Server Information
        </CardTitle>
        <CardDescription>MCP server connection details</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-col gap-2 p-3 bg-muted rounded-lg">
          <div className="flex items-center gap-2">
            <MCP size={16} className="shrink-0 text-muted-foreground" />
            <div className="flex-1">
              <p className="font-medium">MCP Server Path</p>
              <p className="text-muted-foreground text-xs">stdio transport (spawned by clients)</p>
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
              <p className="font-medium">WebSocket Bridge</p>
              <p className="text-muted-foreground text-xs">For Figma plugin communication</p>
            </div>
          </div>
          <code className="bg-background px-2 py-1 rounded text-xs">ws://localhost:3055</code>
        </div>
        <div className="flex justify-between items-center p-3 bg-muted rounded-lg">
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className="shrink-0 text-muted-foreground" />
            <div>
              <p className="font-medium">SSE Migration</p>
              <p className="text-muted-foreground text-xs">Legacy SSE connection guide</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={onPreviewMigration}>
            Preview
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
