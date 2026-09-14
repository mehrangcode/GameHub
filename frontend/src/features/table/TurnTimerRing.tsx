import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDuration, resolveNumerals } from '@/lib/format'
import { serverNow, useSocketStore } from '@/stores/socketStore'
import { useThemeStore } from '@/stores/themeStore'
import styles from './Table.module.css'

const RADIUS = 40
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * ★ The countdown — the highest-stakes number in the UI (06 §3.3).
 *
 * It is rendered from `endsAt − serverNow()`, **never** from a local
 * `setInterval` seeded once at mount and never from bare `Date.now()`. Two
 * different bugs are being avoided:
 *
 *   - a locally-counted timer **drifts** when the tab is backgrounded and
 *     throttled, so it shows time the player does not have;
 *   - a device whose system clock is ten minutes fast computes the wrong
 *     remaining time from a correct absolute deadline, which is why
 *     `serverNow()` applies the offset measured at handshake.
 *
 * Either one shows somebody more time than they have — and that deadline costs
 * them the seat *and* their coins, so it is worth this much care.
 */
export function TurnTimerRing({
  endsAt,
  totalMs,
  strikes,
  ejectAfterStrikes,
  isYou,
  actingName,
}: {
  endsAt: number
  totalMs: number
  strikes: number
  ejectAfterStrikes: number
  isYou: boolean
  actingName: string
}) {
  const { t } = useTranslation(['table', 'common'])
  const locale = useThemeStore((s) => s.locale)
  const numeralSystem = useThemeStore((s) => s.numeralSystem)
  const numerals = resolveNumerals(numeralSystem, locale)
  // Subscribed so a clock offset arriving after the first paint re-renders.
  useSocketStore((s) => s.clockOffset)

  const [remaining, setRemaining] = useState(() => endsAt - serverNow())

  useEffect(() => {
    const tick = () => {
      setRemaining(endsAt - serverNow())
    }
    tick()

    // 250 ms rather than 1 s: a second-resolution tick that lands just after a
    // digit changes makes the ring look like it is skipping.
    const id = setInterval(tick, 250)
    return () => {
      clearInterval(id)
    }
  }, [endsAt])

  const clamped = Math.max(0, remaining)
  const fraction = totalMs > 0 ? Math.min(1, clamped / totalMs) : 0
  const seconds = clamped / 1000

  const colour =
    seconds <= 5 ? 'var(--timer-danger)' : seconds <= 10 ? 'var(--timer-warn)' : 'var(--timer-ok)'

  return (
    <div className={styles.timerWrap}>
      <div
        className={styles.timer}
        role="timer"
        aria-label={t('table:turn.label')}
        // Announced on a coarse cadence; `off` would hide it from a screen
        // reader entirely, and `assertive` would interrupt every second.
        aria-live="off"
      >
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <circle className={styles.timerTrack} cx="50" cy="50" r={RADIUS} />
          <circle
            className={styles.timerFill}
            cx="50"
            cy="50"
            r={RADIUS}
            stroke={colour}
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
          />
        </svg>
        <div>
          <div className={styles.timerValue}>{formatDuration(clamped, { locale, numerals })}</div>
        </div>
      </div>

      <p className={styles.timerCaption}>
        {isYou ? t('table:turn.yours') : t('table:turn.theirs', { name: actingName })}
      </p>

      {/* Strike pips: "1 of 2" without a sentence, and legible at a glance from
          across a table. */}
      {ejectAfterStrikes > 0 && (
        <div
          className={styles.strikes}
          aria-label={t('table:turn.strikes', { count: strikes, limit: ejectAfterStrikes })}
        >
          {Array.from({ length: ejectAfterStrikes }, (_, index) => (
            <span key={index} className={styles.pip} data-struck={index < strikes} />
          ))}
        </div>
      )}
    </div>
  )
}
