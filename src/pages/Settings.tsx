import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Link2, Copy, AlertTriangle, Cpu, Download, Loader2, Trash2, Upload } from 'lucide-react'
import { Figma, MCP } from '@lobehub/icons'
import { McpMultiClientConfig } from '@/components/mcp'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { useToast } from '@/hooks/use-toast'
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { SseMigrationDialog } from '@/components/SseMigrationDialog'
import type { AssistantRuntimeStatus } from '@/shared/types'

interface SettingsPageProps {
  onNavigateToSettings?: () => void
}

function formatBytes(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = sizeBytes
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size.toFixed(size >= 100 || index === 0 ? 0 : 1)} ${units[index]}`
}

function formatEta(seconds: number | null | undefined): string {
  if (!Number.isFinite(seconds) || !seconds || seconds <= 0) return '-'
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  const remaining = total % 60
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    return `${hours}h ${minutes % 60}m`
  }
  if (minutes > 0) {
    return `${minutes}m ${remaining}s`
  }
  return `${remaining}s`
}

function filePathOf(file: File | null): string | null {
  if (!file) return null
  const pathValue = (file as File & { path?: string }).path
  return typeof pathValue === 'string' && pathValue.trim().length > 0 ? pathValue : null
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

  const ggufInputRef = useRef<HTMLInputElement | null>(null)
  const mmprojInputRef = useRef<HTMLInputElement | null>(null)

  const recommendedModel = runtimeStatus?.recommendedModel
  const recommendedSizeBytes = (recommendedModel?.modelSizeBytes ?? 0) + (recommendedModel?.mmprojSizeBytes ?? 0)
  const downloadProgress = runtimeStatus?.downloadProgress
  const progressPercent = downloadProgress && downloadProgress.totalBytes > 0
    ? Math.min(100, Math.max(0, (downloadProgress.downloadedBytes / downloadProgress.totalBytes) * 100))
    : 0
  const isDownloading = runtimeStatus?.downloadState === 'downloading' || runtimeStatus?.downloadState === 'verifying'
  const runtimeBinaryReady = runtimeStatus?.runtimeBinaryReady ?? false
  const runtimeBinaryPath = runtimeStatus?.runtimeBinaryPath ?? null

  const installedModels = runtimeStatus?.installedModelDetails ?? []
  const sortedInstalledModels = useMemo(
    () => [...installedModels].sort((a, b) => b.installedAt - a.installedAt),
    [installedModels],
  )

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

  return (
    <div className="space-y-6 w-full pb-6">
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
              <Button
                onClick={() => void handleDownloadRecommendedModel()}
                disabled={isWorking || isDownloading}
              >
                {isWorking || isDownloading ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                {runtimeStatus?.downloadState === 'failed' ? 'Retry Download' : 'Download Recommended'}
              </Button>
              <Button variant="outline" onClick={() => void refreshModelStatus()} disabled={isWorking}>
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
            <input ref={ggufInputRef} type="file" accept=".gguf" className="hidden" onChange={handleSelectGguf} />
            <input ref={mmprojInputRef} type="file" accept=".gguf" className="hidden" onChange={handleSelectMmproj} />
            <p className="text-muted-foreground text-xs">
              GGUF: {ggufFile?.name ?? 'Not selected'}
            </p>
            <p className="text-muted-foreground text-xs">
              mmproj: {mmprojFile?.name ?? 'Not selected'}
            </p>
            <Input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Display name (optional)"
              disabled={isWorking}
            />
            <Button onClick={() => void handleUploadModel()} disabled={isWorking || !ggufFile}>
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
                          onClick={() => void handleActivateModel(model.id)}
                          disabled={isWorking || isActive}
                        >
                          {isActive ? 'Active' : 'Activate'}
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => void handleDeleteModel(model.id)}
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
                onClick={copyStdioPath}
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
            <Button variant="outline" size="sm" onClick={() => setShowMigrationDialog(true)}>
              Preview
            </Button>
          </div>
        </CardContent>
      </Card>

      <SseMigrationDialog
        open={showMigrationDialog}
        onClose={() => setShowMigrationDialog(false)}
        onGoToSettings={onNavigateToSettings}
      />
    </div>
  )
}
