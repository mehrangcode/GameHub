import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'
import { LOCALES, type Locale } from '@/contracts/enums'

import enAuth from './locales/en/auth.json'
import enCommon from './locales/en/common.json'
import enErrors from './locales/en/errors.json'
import enGames from './locales/en/games.json'
import enTable from './locales/en/table.json'
import faAuth from './locales/fa/auth.json'
import faCommon from './locales/fa/common.json'
import faErrors from './locales/fa/errors.json'
import faGames from './locales/fa/games.json'
import faTable from './locales/fa/table.json'

/**
 * i18n — 06 §7, 02 §8.1.
 *
 * ★ The namespaces are not an organizational convenience: they are the **first
 * segment of every key the server sends**. `errors.field.tooBig`,
 * `table.system.seatTaken` and `games.reward.forfeitedTimeout` all split
 * cleanly into `<namespace>:<rest>`, so a payload's `i18nKey` renders through
 * {@link translateServerKey} with no mapping table to keep in sync. The server
 * never sends English prose, and this is the half of that contract that makes
 * it work.
 *
 * Resources are bundled rather than fetched: M0 has five small namespaces, and
 * a network round-trip before the first paint to fetch the word "Sign in" is a
 * bad trade. Per-game namespaces lazy-load from M1, where the cost is real.
 */

export const NAMESPACES = ['common', 'auth', 'table', 'errors', 'games'] as const
export type Namespace = (typeof NAMESPACES)[number]

export const resources = {
  en: { common: enCommon, auth: enAuth, table: enTable, errors: enErrors, games: enGames },
  fa: { common: faCommon, auth: faAuth, table: faTable, errors: faErrors, games: faGames },
} as const

export const FALLBACK_LOCALE: Locale = 'en'

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

/** `fa` is the only RTL locale we ship; derived, never stored separately. */
export function dirOf(locale: Locale): 'ltr' | 'rtl' {
  return locale === 'fa' ? 'rtl' : 'ltr'
}

/**
 * Locale precedence — S40: `?lng=` → DB preference → localStorage →
 * `navigator.language` → `en`.
 *
 * The detector covers everything except the DB preference, which arrives later
 * (after `GET /auth/me` resolves) and is applied by `themeStore` — but only
 * when the reader did not ask for a language explicitly in the URL. Someone who
 * opened `?lng=fa` meant it, including on an account whose stored preference is
 * English.
 */
// Not awaited, and it does not need to be: with `resources` bundled there is no
// backend to fetch from, so i18next initializes **synchronously** and `t` works
// on the next line. A top-level `await` here would also push the whole entry
// chunk past the browser targets in `vite.config.ts`.
void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: FALLBACK_LOCALE,
    supportedLngs: [...LOCALES],
    // Without this, `fa-IR` from a browser resolves to nothing rather than `fa`.
    load: 'languageOnly',
    ns: [...NAMESPACES],
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    detection: {
      order: ['querystring', 'localStorage', 'navigator'],
      lookupQuerystring: 'lng',
      lookupLocalStorage: 'locale',
      caches: ['localStorage'],
    },
    react: { useSuspense: false },
  })

/** True when the reader pinned a language in the URL — it outranks the account. */
export function localeWasRequestedExplicitly(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).has('lng')
}

/**
 * ★ Renders a server-supplied `i18nKey`.
 *
 * The server sends `errors.seatTaken`, never "Someone took that seat first." —
 * so this is the only place a key from the wire becomes words, and it is the
 * reason a Persian reader gets a Persian error without a round-trip.
 *
 * An unknown key falls back to a generic message rather than printing the raw
 * key: a user seeing `errors.somethingNew` learns nothing, and a backend that
 * ships a new code before the frontend has the string should degrade to
 * "something went wrong", not to debug output.
 */
export function translateServerKey(key: string, params?: Record<string, unknown>): string {
  const separator = key.indexOf('.')
  if (separator === -1) return i18n.t(key, params ?? {})

  const namespace = key.slice(0, separator)
  const rest = key.slice(separator + 1)

  if (!(NAMESPACES as readonly string[]).includes(namespace)) {
    return i18n.t('errors:internal')
  }

  return i18n.t(rest, {
    ns: namespace,
    defaultValue: i18n.t('errors:internal'),
    ...params,
  })
}

export default i18n
