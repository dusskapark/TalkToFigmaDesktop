/**
 * Individual MCP Client Tab Component
 *
 * Shows configuration, status, buttons, and instructions for a specific client
 */

import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Copy, Check, Zap, FolderOpen, RotateCcw, AlertCircle } from 'lucide-react'
import { ConfigStatusBadge } from './ConfigStatusBadge'
import { ConfigCodeBlock } from './ConfigCodeBlock'
import type { McpClient } from '@/lib/mcp/client-configs'
import type { ConfigDetectionResult } from '@/shared/types/ipc'
import { formatClientConfig, getClientInstructions } from '@/lib/mcp/client-configs'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from 'react-i18next'

interface McpClientTabProps {
  client: McpClient
  configState?: ConfigDetectionResult
  onConfigChange: () => void
}

export function McpClientTab({ client, configState, onConfigChange }: McpClientTabProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [isConfiguring, setIsConfiguring] = useState(false)
  const { toast } = useToast()
  const instructions = getClientInstructions(client, t)

  const configJson = formatClientConfig(client)
  const canAutoConfigure = !client.comingSoon && client.configFormat === 'json'

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(configJson)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      toast({
        title: t('common.copied'),
        description: t('mcp.copyConfigurationSuccess'),
      })
    } catch (error) {
      toast({
        title: t('mcp.failedToCopy'),
        description: t('mcp.couldNotCopy'),
        variant: 'destructive',
      })
    }
  }

  const handleAutoConfig = async () => {
    setIsConfiguring(true)
    try {
      const result = await window.electron.mcp.autoConfig(client.id)

      if (result.success) {
        toast({
          title: t('mcp.successBang'),
          description: result.message,
        })
        onConfigChange()
      } else {
        toast({
          title: t('mcp.configurationFailed'),
          description: result.error || result.message,
          variant: 'destructive',
        })
      }
    } catch (error: any) {
      toast({
        title: t('common.error'),
        description: error.message || t('mcp.failedToAutoConfigure'),
        variant: 'destructive',
      })
    } finally {
      setIsConfiguring(false)
    }
  }

  const handleOpenFolder = async () => {
    try {
      const result = await window.electron.mcp.openConfigFolder(client.id)
      if (!result.success) {
        toast({
          title: t('mcp.failedToOpenFolder'),
          description: result.error,
          variant: 'destructive',
        })
      }
    } catch (error: any) {
      toast({
        title: t('common.error'),
        description: error.message,
        variant: 'destructive',
      })
    }
  }

  const handleRestoreBackup = async () => {
    try {
      const result = await window.electron.mcp.restoreBackup(client.id)
      if (result.success) {
        toast({
          title: t('mcp.backupRestored'),
          description: result.message,
        })
        onConfigChange()
      } else {
        toast({
          title: t('mcp.restoreFailed'),
          description: result.error || result.message,
          variant: 'destructive',
        })
      }
    } catch (error: any) {
      toast({
        title: t('common.error'),
        description: error.message,
        variant: 'destructive',
      })
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              {client.displayName}
            </CardTitle>
            <CardDescription className="mt-2">
              {client.comingSoon
                ? t('mcp.configuringResearch')
                : t('mcp.configureClient', { client: client.displayName })}
            </CardDescription>
          </div>
          {configState && (
            <ConfigStatusBadge status={configState.status} />
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {client.comingSoon ? (
          <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4">
            <div className="flex gap-2">
              <AlertCircle className="size-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <div>
                  <p className="font-medium text-sm text-amber-600 dark:text-amber-400">
                  {t('mcp.comingSoon')}
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  {t('mcp.supportUnderDevelopment', { client: client.displayName })}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Configuration Display */}
            <div>
              <h4 className="text-sm font-semibold mb-2">{t('mcp.configuration')}</h4>
              
              <ConfigCodeBlock config={configJson} />
            </div>

            {/* Action Buttons */}
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={handleCopy}
                variant="outline"
                size="sm"
              >
                {copied ? (
                  <>
                    <Check className="mr-2 size-4" />
                    {t('common.copied')}
                  </>
                ) : (
                  <>
                    <Copy className="mr-2 size-4" />
                    {t('common.copy')}
                  </>
                )}
              </Button>

              {canAutoConfigure && (
                <Button
                  onClick={handleAutoConfig}
                  disabled={isConfiguring}
                  size="sm"
                >
                  <Zap className="mr-2 size-4" />
                  {isConfiguring ? t('common.checking') : t('mcp.autoConfigure')}
                </Button>
              )}

              {client.configPath && (
                <Button
                  onClick={handleOpenFolder}
                  variant="outline"
                  size="sm"
                >
                  <FolderOpen className="mr-2 size-4" />
                  {t('mcp.openFolder')}
                </Button>
              )}

              {configState?.status === 'configured' && (
                <Button
                  onClick={handleRestoreBackup}
                  variant="outline"
                  size="sm"
                >
                  <RotateCcw className="mr-2 size-4" />
                  {t('mcp.restoreBackup')}
                </Button>
              )}
            </div>

            <Separator />

            {/* Instructions */}
            <div>
              <h4 className="text-sm font-semibold mb-2">{t('mcp.instructions')}</h4>
              <ol className="list-decimal list-inside space-y-1 text-sm text-muted-foreground">
                {instructions.map((instruction, index) => (
                  <li key={index}>{instruction}</li>
                ))}
              </ol>
            </div>

            {/* Config Path */}
            {client.configPath && (
              <div className="text-xs text-muted-foreground">
                <strong>{t('mcp.configLocation')}:</strong> {client.configPath}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
