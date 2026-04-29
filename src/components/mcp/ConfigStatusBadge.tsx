/**
 * Configuration Status Badge Component
 *
 * Shows status indicator with colors and icons
 */

import { Badge } from '@/components/ui/badge'
import { getStatusBadgeInfo } from '@/lib/mcp/config-utils'
import type { ConfigDetectionResult } from '@/shared/types/ipc'
import { useTranslation } from 'react-i18next'

interface ConfigStatusBadgeProps {
  status: ConfigDetectionResult['status']
}

export function ConfigStatusBadge({ status }: ConfigStatusBadgeProps) {
  const { t } = useTranslation()
  const badgeInfo = getStatusBadgeInfo(status, t)

  return (
    <Badge variant={badgeInfo.variant} className="flex items-center gap-1">
      <span>{badgeInfo.icon}</span>
      <span>{badgeInfo.label}</span>
    </Badge>
  )
}
