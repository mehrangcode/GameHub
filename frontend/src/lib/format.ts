import type { Locale, NumeralSystem } from '@/contracts/enums'

/**
 * Numerals, dates and durations — 06 §7.1.
 *
 * ★ **Display only.** Everything here formats a number a human *reads as a
 * quantity*: a balance, a score, a countdown. Ids, invite codes, seeds and
 * machine codes stay Latin always — they are strings that happen to contain
 * digits, and converting `SEEDDEMO`'s neighbours or a cuid would make them
 * untypeable and unsearchable. There is deliberately no function here that
 * takes an id.
 */

/** `auto` means "follow the language", which is what almost every reader wants. */
export function resolveNumerals(system: NumeralSystem, locale: Locale): 'latin' | 'persian' {
  if (system !== 'auto') return system
  return locale === 'fa' ? 'persian' : 'latin'
}

/**
 * `fa-IR` renders Persian-Indic digits natively; the `-u-nu-latn` extension
 * asks for the same grouping and separators with Latin digits, which is what a
 * Persian reader who prefers `1,200` gets. Doing it through `Intl` rather than
 * a digit-substitution table also gets the grouping separator right, which a
 * lookup table silently would not.
 */
export function formatNumber(
  value: number,
  options: {
    locale: Locale
    numerals: 'latin' | 'persian'
    signDisplay?: 'auto' | 'always'
    /**
     * Defaults to 0, which is right for the common case — coins, scores and
     * counts are whole numbers. **Reward multipliers are not**: a 1.5×
     * premium or a 0.6× repeat decay rounded to an integer renders as "×2" and
     * "×1", which misstates the arithmetic on the one screen whose entire job
     * is showing a player how their reward was calculated.
     */
    maximumFractionDigits?: number
  } = {
    locale: 'en',
    numerals: 'latin',
  },
): string {
  const tag =
    options.numerals === 'persian'
      ? 'fa-IR'
      : options.locale === 'fa'
        ? 'fa-IR-u-nu-latn'
        : 'en-US'

  return new Intl.NumberFormat(tag, {
    maximumFractionDigits: options.maximumFractionDigits ?? 0,
    signDisplay: options.signDisplay ?? 'auto',
  }).format(value)
}

/**
 * Jalali for Persian readers, Gregorian otherwise — via `Intl`, so the calendar
 * conversion is the platform's job rather than ours. A hand-rolled Jalali
 * converter is a classic source of off-by-one-day bugs around Nowruz.
 */
export function formatDate(
  iso: string,
  locale: Locale,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''

  const tag = locale === 'fa' ? 'fa-IR' : 'en-US'
  return new Intl.DateTimeFormat(tag, {
    ...options,
    ...(locale === 'fa' ? { calendar: 'persian' } : {}),
  }).format(date)
}

/** "2 hours ago" / "۲ ساعت پیش", from the platform's own relative-time rules. */
export function formatRelative(iso: string, locale: Locale, now = Date.now()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''

  const seconds = Math.round((date.getTime() - now) / 1000)
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ]

  const format = new Intl.RelativeTimeFormat(locale === 'fa' ? 'fa-IR' : 'en-US', {
    numeric: 'auto',
  })

  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit)
  }
  return format.format(seconds, 'second')
}

/**
 * `m:ss` for a countdown.
 *
 * ★ Clamped at zero rather than going negative. A deadline that has passed but
 * whose expiry event has not yet arrived should read `0:00`, not `-0:03` — the
 * player is already out of time and a negative number reads as a bug at the
 * exact moment they are most anxious.
 */
export function formatDuration(
  ms: number,
  options: { locale: Locale; numerals: 'latin' | 'persian' } = {
    locale: 'en',
    numerals: 'latin',
  },
): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60

  if (options.numerals === 'persian') {
    const digits = new Intl.NumberFormat('fa-IR', { useGrouping: false })
    return `${digits.format(minutes)}:${digits.format(seconds).padStart(2, '۰')}`
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** Two initials for an avatar. Grapheme-aware, so Persian names do not split. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'

  const first = [...words[0]!][0] ?? ''
  const second = words.length > 1 ? ([...words.at(-1)!][0] ?? '') : ''
  return (first + second).toUpperCase()
}
