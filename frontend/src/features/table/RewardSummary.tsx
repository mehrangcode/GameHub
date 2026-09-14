import { useTranslation } from 'react-i18next'
import { Icon } from '@/components/Icon'
import type { GameRewardSettledPayload } from '@/contracts/events'
import { formatNumber, resolveNumerals } from '@/lib/format'
import { translateServerKey } from '@/i18n'
import { useThemeStore } from '@/stores/themeStore'
import styles from './Table.module.css'

/**
 * ★ The receipt — 10 §11, S44.
 *
 * The hardest thing in this whole UI to get right is **a zero that reads as a
 * published rule rather than a bug.** A reward silently not granted is
 * indistinguishable from a broken payout, and a player who assumes a bug is
 * correct to — because a bug looks exactly the same.
 *
 * So a forfeited reward gets more space than a paid one: the arithmetic that
 * produced it, the reason in plain language from the server's own `reasonKey`,
 * and a link to the published rule. The player was told the rule before the
 * match (`GET /rewards/rules` is public, and the ejection warning said so),
 * told again at ejection (`game:rewardPreview`), and told here with the numbers.
 *
 * `factors` is rendered verbatim from the payload — "Shelem base 80 · 1st ×1.5
 * · premium ×1.5 → 180" — so the client needs to ask the server nothing and
 * compute nothing. An opaque economy invites accusations of rigging.
 */
export function RewardSummary({ reward }: { reward: GameRewardSettledPayload }) {
  const { t } = useTranslation(['table', 'common'])
  const locale = useThemeStore((s) => s.locale)
  const numeralSystem = useThemeStore((s) => s.numeralSystem)
  const numerals = resolveNumerals(numeralSystem, locale)

  const num = (value: number) => formatNumber(value, { locale, numerals })
  // Multipliers are fractional and must not round: a 1.5× premium shown as
  // "×2" makes the breakdown disagree with the total it is explaining.
  const factor = (value: number) =>
    `×${formatNumber(value, { locale, numerals, maximumFractionDigits: 2 })}`

  const paid = reward.coinsAwarded > 0

  const rows: [string, string][] = [
    [t('table:reward.base'), num(reward.factors.base)],
    [t('table:reward.placement'), factor(reward.factors.placement)],
    [t('table:reward.premium'), factor(reward.factors.premium)],
    [t('table:reward.integrity'), factor(reward.factors.integrity)],
    [t('table:reward.repeatDecay'), factor(reward.factors.repeatDecay)],
    [t('table:reward.duration'), factor(reward.factors.duration)],
  ]

  return (
    <section className={`glass ${styles.panel}`} aria-labelledby="reward-heading">
      <h2 className={styles.panelTitle} id="reward-heading">
        {t('table:reward.title')}
      </h2>

      <p className={`${styles.rewardTotal} ${paid ? styles.rewardPaid : styles.rewardZero}`}>
        <Icon name="coin" />
        {paid ? t('table:reward.awarded', { count: reward.coinsAwarded, replace: { count: num(reward.coinsAwarded) } }) : t('table:reward.zero')}
      </p>

      <div className={styles.factors}>
        {rows.map(([label, value]) => (
          <span className={styles.factor} key={label}>
            {label}
            <span className={styles.factorValue}>{value}</span>
          </span>
        ))}
        <span className={styles.factor}>
          {t('table:reward.earnedBeforeCaps')}
          <span className={styles.factorValue}>{num(reward.earned)}</span>
        </span>
      </div>

      {/* ★ The forfeiture explanation. Never a grey footnote under a zero. */}
      {reward.forfeited && reward.reasonKey !== null && (
        <p className={styles.forfeitNote}>
          <Icon name="info" />
          <span>
            <strong>{translateServerKey(reward.reasonKey)}</strong>{' '}
            <a href="/premium">{t('table:reward.readRule')}</a>
          </span>
        </p>
      )}

      {/* Capped is not forfeited: the player did nothing wrong, they simply hit
          an earning limit. Different message, different tone. */}
      {reward.capped && !reward.forfeited && (
        <p className={`${styles.banner} ${styles.bannerInfo}`}>
          <Icon name="info" size="sm" />
          <span>{t('table:reward.capped')}</span>
        </p>
      )}

      {/* A non-forfeited, non-capped reduction still has a reason worth saying
          — a returned seat pays half, a resignation a quarter. */}
      {!reward.forfeited && !reward.capped && reward.reasonKey !== null && (
        <p className={styles.tableMeta}>{translateServerKey(reward.reasonKey)}</p>
      )}
    </section>
  )
}
