import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router'
import { Button } from '@/components/Button'
import { Icon } from '@/components/Icon'
import { gameIcon } from '@/components/icons'
import { getGame } from '@/api/games'
import { formatNumber, resolveNumerals } from '@/lib/format'
import { useAsync } from '@/lib/useAsync'
import { useThemeStore } from '@/stores/themeStore'
import styles from './Welcome.module.css'

/**
 * `/games/:slug` — the detail behind a preview card.
 *
 * Reads the same registry-driven payload the grid does, plus the fields only
 * the table-creation form needs (`optionsSchema`, `defaultOptions`). Rendering
 * the options form from that JSON Schema lands with table creation; for now the
 * page shows what a player wants before committing 45 minutes: how many people,
 * how long, and how long a turn lasts.
 */
export function GameDetailPage() {
  const { slug = '' } = useParams()
  const { t } = useTranslation(['games', 'common', 'table'])
  const locale = useThemeStore((s) => s.locale)
  const numeralSystem = useThemeStore((s) => s.numeralSystem)
  const numerals = resolveNumerals(numeralSystem, locale)

  const { data, error, loading, reload } = useAsync(() => getGame(slug), [slug])

  const num = (value: number) => formatNumber(value, { locale, numerals })

  if (loading) {
    return (
      <div className={`glass ${styles.skeleton}`} aria-busy="true" aria-label={t('common:state.loading')} />
    )
  }

  if (error !== null || data === null) {
    return (
      <div className={`glass ${styles.notice}`} role="alert">
        <Icon name="alert" />
        <p>{error ?? t('common:state.error')}</p>
        <Button variant="quiet" onClick={reload}>
          {t('common:actions.retry')}
        </Button>
        <Link to="/">{t('common:actions.backHome')}</Link>
      </div>
    )
  }

  const name = t(data.preview.nameKey.replace(/^games\./, ''), {
    ns: 'games',
    defaultValue: data.slug,
  })
  const tagline = t(data.preview.taglineKey.replace(/^games\./, ''), {
    ns: 'games',
    defaultValue: '',
  })

  const [minMinutes, maxMinutes] = data.preview.avgMinutes

  return (
    <article className={`glass ${styles.detail}`}>
      <div className={styles.top}>
        <span className={styles.icon}>
          <Icon name={gameIcon(data.slug)} />
        </span>
        <div className={styles.titles}>
          <h1 className={styles.name}>{name}</h1>
          <p className={styles.tagline}>{tagline}</p>
        </div>
        {data.comingSoon && (
          <span className={`${styles.badge} ${styles.badgeSoon}`}>{t('games:card.comingSoon')}</span>
        )}
      </div>

      <div className={styles.detailFacts}>
        <div className={styles.detailFact}>
          <span className={styles.detailKey}>{t('games:card.players', { min: '', max: '' })}</span>
          <span className={`${styles.detailValue} num`}>
            {data.playableCounts.map(num).join(' · ')}
          </span>
        </div>

        <div className={styles.detailFact}>
          <span className={styles.detailKey}>
            <Icon name="clock" size="sm" />
          </span>
          <span className={`${styles.detailValue} num`}>
            {t('games:card.minutes', { min: num(minMinutes), max: num(maxMinutes) })}
          </span>
        </div>

        {data.turnTimeoutMs !== null && (
          <div className={styles.detailFact}>
            <span className={styles.detailKey}>{t('table:turn.label')}</span>
            <span className={`${styles.detailValue} num`}>
              {num(Math.round(data.turnTimeoutMs / 1000))}s
            </span>
          </div>
        )}
      </div>

      <div className={styles.tags}>
        <span className={styles.tag}>{t(`games:card.complexity.${data.preview.complexity}`)}</span>
        {data.preview.hasHiddenInfo && <span className={styles.tag}>{t('games:card.hiddenInfo')}</span>}
        {data.preview.usesStandardDeck && (
          <span className={styles.tag}>{t('games:card.standardDeck')}</span>
        )}
      </div>

      <Link to="/">
        <Button variant="quiet">{t('common:actions.backHome')}</Button>
      </Link>
    </article>
  )
}
