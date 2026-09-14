import { beforeEach, describe, expect, it } from 'vitest'
import i18n from '../../src/i18n'
import { useThemeStore } from '../../src/stores/themeStore'

/**
 * S40 — locale, direction and theme.
 *
 * ★ RTL is treated as **correctness, not polish** (02 §8.1). The assertion that
 * `<html dir>` flips is therefore a first-class test, not a nicety: every piece
 * of layout in this app is built from logical properties on the assumption that
 * this one attribute is right. If `dir` does not flip, nothing mirrors and the
 * entire Persian build is broken in a way no component test would catch.
 */

beforeEach(async () => {
  await i18n.changeLanguage('en')
  useThemeStore.setState({ locale: 'en', dir: 'ltr', theme: 'system', resolvedTheme: 'light' })
})

describe('locale', () => {
  it('★ switching to fa sets BOTH <html lang> and <html dir>', () => {
    useThemeStore.getState().setLocale('fa')

    expect(document.documentElement.lang).toBe('fa')
    expect(document.documentElement.dir).toBe('rtl')
    expect(useThemeStore.getState().dir).toBe('rtl')
  })

  it('and switching back restores ltr', () => {
    useThemeStore.getState().setLocale('fa')
    useThemeStore.getState().setLocale('en')

    expect(document.documentElement.lang).toBe('en')
    expect(document.documentElement.dir).toBe('ltr')
  })

  it('★ dir is derived from locale, never stored independently', () => {
    // Two sources of truth for direction is how a half-mirrored page happens.
    useThemeStore.setState({ locale: 'fa', dir: 'ltr' })
    useThemeStore.getState().setLocale('fa')

    expect(useThemeStore.getState().dir).toBe('rtl')
  })

  it('a language change from i18next alone keeps the store in step', async () => {
    // The `?lng=` detector changes the language without going through
    // `setLocale`; the store must not be left describing the old one.
    await i18n.changeLanguage('fa')

    expect(useThemeStore.getState().locale).toBe('fa')
    expect(useThemeStore.getState().dir).toBe('rtl')
  })
})

describe('theme', () => {
  it('stamps data-theme on the document root', () => {
    useThemeStore.getState().setTheme('dark')

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(useThemeStore.getState().resolvedTheme).toBe('dark')
  })

  it("★ resolves 'system' to a concrete value — data-theme is never 'system'", () => {
    // tokens.css has one `[data-theme="dark"]` block and deliberately no
    // duplicate under a media query. That only works if the store resolves.
    useThemeStore.getState().setTheme('system')

    expect(useThemeStore.getState().theme).toBe('system')
    expect(['light', 'dark']).toContain(useThemeStore.getState().resolvedTheme)
    expect(document.documentElement.dataset.theme).not.toBe('system')
  })

  it('persists the choice so a reload keeps it', () => {
    useThemeStore.getState().setTheme('dark')

    expect(localStorage.getItem('preferences')).toContain('dark')
  })
})

describe('cosmetics', () => {
  it('applies a card back as a CSS custom property, not a re-render', () => {
    // The whole cosmetics system is runtime variable swapping (06 §6.1).
    useThemeStore.getState().setCosmetic('cardBackId', 'persian-tile')

    expect(document.documentElement.style.getPropertyValue('--card-back-image')).toContain(
      'persian-tile',
    )
  })

  it("animationSpeed 'off' zeroes the motion tokens", () => {
    useThemeStore.getState().setAnimationSpeed('off')

    expect(document.documentElement.style.getPropertyValue('--dur-base')).toBe('0ms')
  })
})
