import { app } from 'electron'

import { STORE_KEYS } from '@/shared/constants'
import { AppLocale, DEFAULT_LOCALE, isAppLocale, resolveAppLocale, resources } from '@/shared/i18n'
import { getSetting } from './utils/store'

type TranslationTree = Record<string, unknown>

function getNestedValue(tree: TranslationTree, key: string): string | undefined {
  const segments = key.split('.')
  let current: unknown = tree

  for (const segment of segments) {
    if (!current || typeof current !== 'object' || !(segment in current)) {
      return undefined
    }
    current = (current as TranslationTree)[segment]
  }

  return typeof current === 'string' ? current : undefined
}

function interpolate(template: string, values?: Record<string, unknown>): string {
  if (!values) return template

  return template.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (_match, key: string) => {
    const value = values[key]
    return value === undefined || value === null ? '' : String(value)
  })
}

export function getStoredLocale(): AppLocale {
  const locale = getSetting<string>(STORE_KEYS.APP_LOCALE)
  return isAppLocale(locale) ? locale : 'system'
}

export function getResolvedMainLocale(): Exclude<AppLocale, 'system'> {
  return resolveAppLocale(getStoredLocale(), app.getLocale())
}

export function t(key: string, options?: Record<string, unknown>): string {
  const locale = getResolvedMainLocale()
  const localized = getNestedValue(resources[locale].translation as TranslationTree, key)
  const fallback = getNestedValue(resources[DEFAULT_LOCALE].translation as TranslationTree, key)
  const template = localized ?? fallback ?? key
  return interpolate(template, options)
}
