import { useTranslation } from 'react-i18next'
import { Button } from '@/components/Button'
import { Icon } from '@/components/Icon'
import { listGames } from '@/api/games'
import { getRewardRules } from '@/api/wallet'
import { useAsync } from '@/lib/useAsync'
import { GameCard } from './GameCard'
import styles from './Welcome.module.css'

/**
 * The welcome page — S41, and one of M0's exit criteria.
 *
 * ★ The grid is driven entirely by `GET /api/v1/games`. There is no hard-coded
 * list, no per-game component, and no `comingSoon` flag in the frontend: add a
 * game to `domain/games/registry.ts`, restart the backend, refresh the browser,
 * and a sixth card appears. That is P5 — "game #6 must not touch games #1–5" —
 * proven on the client side.
 *
 * The coin rates come from the **public** rate card (`GET /rewards/rules`, no
 * cookie), which is why the page can say "Shelem pays most" to somebody who has
 * not signed up. Deliberate transparency, 10 §11 — and it is fetched
 * separately so a rate-card failure costs the rates, never the games.
 */
export function WelcomePage() {
  const { t } = useTranslation(['games', 'common'])

  const games = useAsync(() => listGames(), [])
  const rules = useAsync(() => getRewardRules(), [])

  const rateFor = (slug: string): number | undefined =>
    rules.data?.rules.find((rule) => rule.gameSlug === slug)?.base

  return (
    <>
      <section className={`glass ${styles.hero}`}>
        <h1 className={styles.heroTitle}>{t('games:list.title')}</h1>
        <p className={styles.heroBody}>{t('auth:guest.noAccountNeeded', { ns: 'auth' })}</p>
      </section>

      <section aria-labelledby="games-heading">
        <div className={styles.head}>
          <h2 id="games-heading">{t('games:list.title')}</h2>
          {games.data !== null && (
            <span className={styles.count}>
              {t('games:list.count', { count: games.data.length })}
            </span>
          )}
        </div>

        {games.loading && (
          <div className={styles.grid} aria-busy="true" aria-label={t('common:state.loading')}>
            {/* Skeletons, not a spinner: the layout does not jump when the real
                cards arrive, which is the whole reason to draw them. */}
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} className={`glass ${styles.skeleton}`} />
            ))}
          </div>
        )}

        {!games.loading && games.error !== null && (
          <div className={`glass ${styles.notice}`} role="alert">
            <Icon name="alert" />
            <p>{games.error}</p>
            <Button variant="quiet" onClick={games.reload}>
              {t('common:actions.retry')}
            </Button>
          </div>
        )}

        {!games.loading && games.error === null && games.data?.length === 0 && (
          <div className={`glass ${styles.notice}`}>
            <Icon name="info" />
            <p>{t('games:list.empty')}</p>
          </div>
        )}

        {!games.loading && games.error === null && (games.data?.length ?? 0) > 0 && (
          <div className={styles.grid}>
            {games.data?.map((game) => (
              <GameCard key={game.slug} game={game} coinRate={rateFor(game.slug)} />
            ))}
          </div>
        )}
      </section>
    </>
  )
}
