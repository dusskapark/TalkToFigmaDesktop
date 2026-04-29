/**
 * MCP Configuration Utilities
 *
 * Shared utilities for MCP configuration
 */

export type ConfigStatus =
  | 'configured'            // ✅ TalkToFigmaDesktop found in config
  | 'exists-not-configured' // ⚠️ Config exists, our server missing
  | 'not-found'             // ⚪ Config file doesn't exist
  | 'no-permission'         // 🔒 Can't read config
  | 'unknown'               // ❓ Can't determine

/**
 * Get status badge info (color, icon, label)
 */
export function getStatusBadgeInfo(status: ConfigStatus, t?: (key: string) => string): {
  variant: 'default' | 'secondary' | 'destructive' | 'outline'
  label: string
  icon: string
} {
  const translate = t ?? ((key: string) => key)
  switch (status) {
    case 'configured':
      return {
        variant: 'default',
        label: translate('mcp.status.configured'),
        icon: '✅'
      }
    case 'exists-not-configured':
      return {
        variant: 'secondary',
        label: translate('mcp.status.notConfigured'),
        icon: '⚠️'
      }
    case 'not-found':
      return {
        variant: 'outline',
        label: translate('mcp.status.notDetected'),
        icon: '⚪'
      }
    case 'no-permission':
      return {
        variant: 'destructive',
        label: translate('mcp.status.noPermission'),
        icon: '🔒'
      }
    case 'unknown':
    default:
      return {
        variant: 'outline',
        label: translate('mcp.status.unknown'),
        icon: '❓'
      }
  }
}
