import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { I18nextProvider } from 'react-i18next'

import { i18n, i18nReady } from '@/i18n/renderer'
import { STORE_KEYS } from '@/shared/constants'
import { AppLocale, DEFAULT_LOCALE, isAppLocale, resolveAppLocale } from '@/shared/i18n'

interface LocaleContextValue {
  locale: AppLocale
  resolvedLocale: Exclude<AppLocale, 'system'>
  setLocale: (locale: AppLocale) => Promise<void>
}

const LocaleContext = createContext<LocaleContextValue | undefined>(undefined)

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>('system')
  const [resolvedLocale, setResolvedLocale] = useState<Exclude<AppLocale, 'system'>>(DEFAULT_LOCALE)

  useEffect(() => {
    const loadLocale = async () => {
      try {
        const savedLocale = await window.electron.settings.get<string>(STORE_KEYS.APP_LOCALE)
        const nextLocale = isAppLocale(savedLocale) ? savedLocale : 'system'
        const nextResolvedLocale = resolveAppLocale(nextLocale, navigator.language)

        await i18nReady
        setLocaleState(nextLocale)
        setResolvedLocale(nextResolvedLocale)
        await i18n.changeLanguage(nextResolvedLocale)
      } catch (error) {
        console.error('Failed to load locale:', error)
      }
    }

    void loadLocale()
  }, [])

  const setLocale = async (nextLocale: AppLocale) => {
    const nextResolvedLocale = resolveAppLocale(nextLocale, navigator.language)
    await i18nReady
    setLocaleState(nextLocale)
    setResolvedLocale(nextResolvedLocale)
    await i18n.changeLanguage(nextResolvedLocale)
    await window.electron.settings.set(STORE_KEYS.APP_LOCALE, nextLocale)
  }

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      resolvedLocale,
      setLocale,
    }),
    [locale, resolvedLocale],
  )

  return (
    <I18nextProvider i18n={i18n}>
      <LocaleContext.Provider value={value}>
        {children}
      </LocaleContext.Provider>
    </I18nextProvider>
  )
}

export function useLocale() {
  const context = useContext(LocaleContext)
  if (!context) {
    throw new Error('useLocale must be used within LocaleProvider')
  }
  return context
}
