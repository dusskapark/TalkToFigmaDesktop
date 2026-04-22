import { ASSISTANT_CONTEXT_LENGTH, ASSISTANT_TOOL_RESULT_LIMITS } from '@/shared/constants'

export function formatBytes(sizeBytes: number): string {
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

export function formatEta(seconds: number | null | undefined): string {
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

export function filePathOf(file: File | null): string | null {
  if (!file) return null
  const pathValue = (file as File & { path?: string }).path
  return typeof pathValue === 'string' && pathValue.trim().length > 0 ? pathValue : null
}

export function normalizeContextLength(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) {
    return ASSISTANT_CONTEXT_LENGTH.DEFAULT
  }
  const rounded = Math.round(numeric)
  return ASSISTANT_CONTEXT_LENGTH.OPTIONS.includes(rounded as typeof ASSISTANT_CONTEXT_LENGTH.OPTIONS[number])
    ? rounded
    : ASSISTANT_CONTEXT_LENGTH.DEFAULT
}

export function formatContextLength(value: number): string {
  return `${Math.round(value / 1024)}k`
}

export function normalizeToolResultLimit(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) {
    return fallback
  }

  const rounded = Math.round(numeric)
  return ASSISTANT_TOOL_RESULT_LIMITS.OPTIONS.includes(rounded as typeof ASSISTANT_TOOL_RESULT_LIMITS.OPTIONS[number])
    ? rounded
    : fallback
}
