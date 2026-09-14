import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { api } from '@/api/client'
import type { UpdatePreferencesRequest } from '@/contracts/dto/preferences'
import type { AnimationSpeed, Locale, NumeralSystem, Theme } from '@/contracts/enums'
import i18n, { dirOf, isLocale, localeWasRequestedExplicitly } from '@/i18n'

/**
 * Locale, direction, theme and cosmetics — 06 §3.5.
 *
 * ★ This store is the **only** thing in the app that writes to
 * `document.documentElement`. Components never reach for the DOM root
 * themselves; they set state here and a single `subscribeWithSelector`
 * subscription applies `lang`, `dir`, `data-theme` and the cosmetic custom
 * properties outside React. That is what makes a cosmetic a variable swap with
 * no re-render (06 §6.1) rather than a prop threaded through forty components.
 */

export interface Cosmetics {
  cardBackId: string | null
  cardFaceId: string | null
  feltId: string | null
}

interface ThemeState {
  theme: Theme
  /** `theme` with 'system' resolved against the media query. Never 'system'. */
  resolvedTheme: 'light' | 'dark'
  locale: Locale
  /** Derived from `locale`; stored so components read it without re-deriving. */
  dir: 'ltr' | 'rtl'
  numeralSystem: NumeralSystem
  animationSpeed: AnimationSpeed
  cosmetics: Cosmetics
  sound: { enabled: boolean; volume: number }
  /** True once a signed-in account's stored preferences have been applied. */
  hydrated: boolean

  setTheme: (theme: Theme) => void
  setLocale: (locale: Locale) => void
  setNumeralSystem: (system: NumeralSystem) => void
  setAnimationSpeed: (speed: AnimationSpeed) => void
  setCosmetic: (key: keyof Cosmetics, id: string | null) => void
  /** Applies an account's stored preferences after `GET /auth/me` resolves. */
  hydrateFromServer: () => Promise<void>
  /** Re-resolves 'system' when the OS theme changes under us. */
  syncSystemTheme: () => void
}

const STORAGE_KEY = 'preferences'

function prefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function resolve(theme: Theme): 'light' | 'dark' {
  return theme === 'system' ? (prefersDark() ? 'dark' : 'light') : theme
}

// ── Guest-side persistence ───────────────────────────────────────────────────

interface StoredPreferences {
  theme?: Theme
  numeralSystem?: NumeralSystem
  animationSpeed?: AnimationSpeed
  cosmetics?: Partial<Cosmetics>
  sound?: { enabled: boolean; volume: number }
}

/**
 * Guests and anonymous visitors persist here; users persist to
 * `PUT /me/preferences`. Both paths are kept because a guest's choices are
 * carried into their account by the claim transaction (03 §6.1 step 3) — the
 * dark theme they picked on the invite landing page survives signing up.
 *
 * Every read is defensive: `localStorage` throws in a private window in some
 * browsers, and a settings blob is never worth a blank page.
 */
function readStored(): StoredPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === null ? {} : (JSON.parse(raw) as StoredPreferences)
  } catch {
    return {}
  }
}

function writeStored(patch: StoredPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readStored(), ...patch }))
  } catch {
    // A reader with storage disabled keeps their choice for this page only.
  }
}

/**
 * Fire-and-forget. A settings write that fails must never surface as an error
 * dialog over a game — the choice is already applied locally, and the worst
 * case is that it does not follow the reader to another device.
 */
function persistToServer(patch: UpdatePreferencesRequest): void {
  void api.put('/me/preferences', patch).catch(() => {
    // Guests get 403 here by design (preferences are an account feature), and
    // that is the common case rather than an exception worth reporting.
  })
}

const stored = readStored()
const initialTheme = stored.theme ?? 'system'
const initialLocale: Locale = isLocale(i18n.language) ? i18n.language : 'en'

export const useThemeStore = create<ThemeState>()(
  subscribeWithSelector((set, get) => ({
    theme: initialTheme,
    resolvedTheme: resolve(initialTheme),
    locale: initialLocale,
    dir: dirOf(initialLocale),
    numeralSystem: stored.numeralSystem ?? 'auto',
    animationSpeed: stored.animationSpeed ?? 'normal',
    cosmetics: {
      cardBackId: stored.cosmetics?.cardBackId ?? null,
      cardFaceId: stored.cosmetics?.cardFaceId ?? null,
      feltId: stored.cosmetics?.feltId ?? null,
    },
    sound: stored.sound ?? { enabled: true, volume: 70 },
    hydrated: false,

    setTheme: (theme) => {
      set({ theme, resolvedTheme: resolve(theme) })
      writeStored({ theme })
      persistToServer({ theme })
    },

    setLocale: (locale) => {
      set({ locale, dir: dirOf(locale) })
      // i18next's own detector caches to localStorage under `locale`, so the
      // choice survives a reload without us writing it a second time.
      void i18n.changeLanguage(locale)
      persistToServer({ locale })
    },

    setNumeralSystem: (numeralSystem) => {
      set({ numeralSystem })
      writeStored({ numeralSystem })
      persistToServer({ numeralSystem })
    },

    setAnimationSpeed: (animationSpeed) => {
      set({ animationSpeed })
      writeStored({ animationSpeed })
      persistToServer({ animationSpeed })
    },

    setCosmetic: (key, id) => {
      const cosmetics = { ...get().cosmetics, [key]: id }
      set({ cosmetics })
      writeStored({ cosmetics })
      persistToServer({ [key]: id } as UpdatePreferencesRequest)
    },

    hydrateFromServer: async () => {
      try {
        const { data } = await api.get<{
          theme: Theme
          locale: Locale
          numeralSystem: NumeralSystem
          animationSpeed: AnimationSpeed
          cardBackId: string | null
          cardFaceId: string | null
          feltId: string | null
          soundEnabled: boolean
          soundVolume: number
        }>('/me/preferences')

        set({
          theme: data.theme,
          resolvedTheme: resolve(data.theme),
          numeralSystem: data.numeralSystem,
          animationSpeed: data.animationSpeed,
          cosmetics: {
            cardBackId: data.cardBackId,
            cardFaceId: data.cardFaceId,
            feltId: data.feltId,
          },
          sound: { enabled: data.soundEnabled, volume: data.soundVolume },
          hydrated: true,
        })

        // ★ Precedence (S40): `?lng=` beats the account. Someone who opened
        // `?lng=fa` meant it, including on an account stored as English.
        if (!localeWasRequestedExplicitly() && data.locale !== get().locale) {
          set({ locale: data.locale, dir: dirOf(data.locale) })
          void i18n.changeLanguage(data.locale)
        }
      } catch {
        // A guest (403) or an anonymous visitor (401). Their localStorage
        // values, already applied above, are the right answer.
        set({ hydrated: true })
      }
    },

    syncSystemTheme: () => {
      if (get().theme === 'system') set({ resolvedTheme: resolve('system') })
    },
  })),
)

// ── The one DOM writer ───────────────────────────────────────────────────────

/**
 * Applies store state to `<html>`. Registered once at module load and run
 * immediately, so the very first paint is already correct — a theme applied in
 * a `useEffect` flashes the wrong colours for a frame.
 */
function applyToDocument(state: ThemeState): void {
  if (typeof document === 'undefined') return

  const root = document.documentElement
  root.lang = state.locale
  root.dir = state.dir
  root.dataset.theme = state.resolvedTheme

  const { cardBackId, feltId } = state.cosmetics
  root.style.setProperty(
    '--card-back-image',
    cardBackId === null ? 'none' : `url('/assets/backs/${cardBackId}.svg')`,
  )
  if (feltId !== null) root.style.setProperty('--felt-color', `var(--felt-${feltId})`)

  // 'off' zeroes the motion tokens; the media query in tokens.css does the same
  // for readers who asked the OS instead. Both, because a reader may want fast
  // animations in games and reduced motion everywhere else.
  const scale = state.animationSpeed === 'off' ? '0ms' : state.animationSpeed === 'fast' ? '90ms' : ''
  if (scale === '') {
    root.style.removeProperty('--dur-base')
    root.style.removeProperty('--anim-card-deal')
  } else {
    root.style.setProperty('--dur-base', scale)
    root.style.setProperty('--anim-card-deal', scale)
  }
}

useThemeStore.subscribe(
  (state) => state,
  (state) => {
    applyToDocument(state)
  },
  { fireImmediately: true },
)

// i18next may change the language without going through `setLocale` — the
// querystring detector at boot, or a `?lng=` link. Keep the store in step.
i18n.on('languageChanged', (next) => {
  if (!isLocale(next)) return
  if (useThemeStore.getState().locale === next) return
  useThemeStore.setState({ locale: next, dir: dirOf(next) })
})

if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    useThemeStore.getState().syncSystemTheme()
  })
}
