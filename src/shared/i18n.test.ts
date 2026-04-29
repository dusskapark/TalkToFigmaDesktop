import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeSupportedLocale, resolveAppLocale } from './i18n'

test('normalizeSupportedLocale maps supported regional locales', () => {
  assert.equal(normalizeSupportedLocale('ko-KR'), 'ko')
  assert.equal(normalizeSupportedLocale('ru-RU'), 'ru')
  assert.equal(normalizeSupportedLocale('hi-IN'), 'hi')
  assert.equal(normalizeSupportedLocale('ta-IN'), 'ta')
})

test('normalizeSupportedLocale falls back to english for unsupported locales', () => {
  assert.equal(normalizeSupportedLocale('fr-FR'), 'en')
  assert.equal(normalizeSupportedLocale('zh-CN'), 'en')
  assert.equal(normalizeSupportedLocale(undefined), 'en')
})

test('resolveAppLocale prioritizes explicit app locale over system locale', () => {
  assert.equal(resolveAppLocale('ko', 'en-US'), 'ko')
  assert.equal(resolveAppLocale('ru', 'ko-KR'), 'ru')
})

test('resolveAppLocale uses system locale when app locale is system or missing', () => {
  assert.equal(resolveAppLocale('system', 'ko-KR'), 'ko')
  assert.equal(resolveAppLocale(null, 'ru-RU'), 'ru')
  assert.equal(resolveAppLocale(undefined, 'fr-FR'), 'en')
})
