import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Icon } from '@/components/Icon'
import { gameIcon } from '@/components/icons'
import type { GameSummary } from '@/contracts/dto/games'
import { formatNumber, resolveNumerals } from '@/lib/format'
import { useThemeStore } from '@/stores/themeStore'
import styles from './Welcome.module.css'

/**
 * One preview card — S41, 01 §welcome page.
 *
 * ★ **Every string here comes from the payload's i18n keys or the bundle.**
 * There is no `if (slug === 'shelem')` anywhere, no hard-coded name, no
 * per-game branch. That is what makes P5 true on the client: a sixth game added
 * to the backend registry renders a sixth card with no frontend deploy — only a
 * renderer, later, when it becomes playable.
 *
 * The one lookup that *is* local is the icon, and it falls back to a generic
 * spade for a slug this build has never heard of.
 */
export function GameCard({ game, coinRate }: { game: GameSummary; coinRate?: number }) {
  const { t } = useTranslation(['games', 'common'])
  const locale = useThemeStore((s) => s.locale)
  const numeralSystem = useThemeStore((s) => s.numeralSystem)
  const numerals = resolveNumerals(numeralSystem, locale)

  const num = (value: number) => formatNumber(value, { locale, numerals })

  // The server sends `games.shelem.name`; the bundle answers it. A game whose
  // strings this build does not carry falls back to its slug rather than
  // rendering the raw key at somebody.
  const name = t(game.preview.nameKey.replace(/^games\./, ''), {
    ns: 'games',
    defaultValue: game.slug,
  })
  const tagline = t(game.preview.taglineKey.replace(/^games\./, ''), {
    ns: 'games',
    defaultValue: '',
  })

  const [minMinutes, maxMinutes] = game.preview.avgMinutes

  const players =
    game.minPlayers === game.maxPlayers
      ? game.minPlayers === 1
        ? t('games:card.playersSolo')
        : t('games:card.playersExact', { count: game.minPlayers, replace: { count: num(game.minPlayers) } })
      : t('games:card.players', { min: num(game.minPlayers), max: num(game.maxPlayers) })

  const body = (
    <>
      <div className={styles.top}>
        <span className={styles.icon}>
          <Icon name={gameIcon(game.slug)} />
        </span>
        <div className={styles.titles}>
          <div className={styles.name}>{name}</div>
          <div className={styles.tagline}>{tagline}</div>
        </div>
        {game.comingSoon && (
          <span className={`${styles.badge} ${styles.badgeSoon}`}>{t('games:card.comingSoon')}</span>
        )}
      </div>

      <div className={styles.tags}>
        <span className={styles.tag}>{t(`games:card.complexity.${game.preview.complexity}`)}</span>
        {game.preview.hasHiddenInfo && <span className={styles.tag}>{t('games:card.hiddenInfo')}</span>}
        {game.preview.usesStandardDeck && (
          <span className={styles.tag}>{t('games:card.standardDeck')}</span>
        )}
      </div>

      <div className={styles.facts}>
        <span className={styles.fact}>
          <Icon name="users" size="sm" />
          {players}
        </span>
        {game.comingSoon ? (
          <span className={styles.fact}>{t('games:card.notYetAvailable')}</span>
        ) : (
          <>
            <span className={styles.fact}>
              <Icon name="clock" size="sm" />
              {t('games:card.minutes', { min: num(minMinutes), max: num(maxMinutes) })}
            </span>
            {coinRate !== undefined && (
              <span className={`${styles.fact} ${styles.rate}`}>
                <Icon name="coin" size="sm" />
                {num(coinRate)}
              </span>
            )}
          </>
        )}
      </div>
    </>
  )

  // A coming-soon card is not a link: it is focusable and announced as
  // disabled, so it advertises the game without leading anywhere yet.
  if (game.comingSoon) {
    return (
      <div className={`glass ${styles.card}`} aria-disabled="true" tabIndex={0} role="group">
        {body}
      </div>
    )
  }

  return (
    <Link className={`glass ${styles.card}`} to={`/games/${game.slug}`}>
      {body}
    </Link>
  )
}
