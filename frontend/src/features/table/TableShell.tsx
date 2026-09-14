import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/Button'
import { Icon } from '@/components/Icon'
import { gameIcon } from '@/components/icons'
import { formatDuration, resolveNumerals } from '@/lib/format'
import { socketManager } from '@/socket/manager'
import { useAuthStore } from '@/stores/authStore'
import { useChatStore } from '@/stores/chatStore'
import { useGameStore } from '@/stores/gameStore'
import { serverNow, useSocketStore } from '@/stores/socketStore'
import { useTableStore } from '@/stores/tableStore'
import { useThemeStore } from '@/stores/themeStore'
import { RewardSummary } from './RewardSummary'
import { SeatRing } from './SeatRing'
import { SignupNudge } from './SignupNudge'
import { TableChat } from './TableChat'
import { TurnTimerRing } from './TurnTimerRing'
import styles from './Table.module.css'

/**
 * The shell every game renders inside — 06 §5.1, S44.
 *
 * Built **once** and reused by all five games: the per-game folder supplies
 * only a renderer, which fills the `GameArea` slot below. Nothing in this file
 * knows what a card is.
 *
 * ★ And nothing in this file decides anything about the game. The acting seat,
 * the deadline, the strike count, the ejection and the reward all arrive from
 * the server and are rendered verbatim. The one number computed locally is
 * "how many milliseconds until `endsAt`", and even that is computed against the
 * server's clock rather than the device's.
 */
export function TableShell() {
  const { t } = useTranslation(['table', 'common', 'games'])

  const table = useTableStore((s) => s.table)
  const members = useTableStore((s) => s.members)
  const you = useTableStore((s) => s.you)

  const status = useAuthStore((s) => s.status)
  const socketState = useSocketStore((s) => s.state)
  const protocolMismatch = useSocketStore((s) => s.protocolMismatch)

  const locale = useThemeStore((s) => s.locale)
  const numeralSystem = useThemeStore((s) => s.numeralSystem)
  const numerals = resolveNumerals(numeralSystem, locale)

  const game = useGameStore()
  const markRead = useChatStore((s) => s.markRead)

  const [busySeat, setBusySeat] = useState<number | null>(null)
  const [reclaimTick, setReclaimTick] = useState(0)

  // Drives the reclaim countdown. One interval for the whole panel rather than
  // a timer per component.
  useEffect(() => {
    if (game.ejected?.reclaimableUntil == null) return
    const id = setInterval(() => {
      setReclaimTick((n) => n + 1)
    }, 500)
    return () => {
      clearInterval(id)
    }
  }, [game.ejected?.reclaimableUntil])

  useEffect(() => {
    markRead()
  }, [markRead])

  if (table === null) {
    return (
      <p role="status" aria-live="polite">
        {t('common:state.loading')}
      </p>
    )
  }

  const gameName = t(table.gameSlug, { ns: 'games', defaultValue: table.gameSlug })
  const isHost = you?.isHost ?? false
  const seated = you?.seat != null
  const actingSeat = game.toAct
  const actingName =
    actingSeat === null
      ? ''
      : (table.seats[actingSeat]?.occupant?.displayName ?? t('table:seat.number', { seat: actingSeat }))

  const turnTimeoutMs =
    game.turnEndsAt === null ? 0 : Math.max(1, game.turnEndsAt - serverNow() + 1)

  const reclaimRemaining =
    game.ejected?.reclaimableUntil == null ? 0 : game.ejected.reclaimableUntil - serverNow()
  const canReclaim = reclaimRemaining > 0

  return (
    <div className={styles.shell}>
      {/* ── banners, most urgent first ──────────────────────────────────── */}

      {protocolMismatch && (
        <p className={`${styles.banner} ${styles.bannerDanger}`} role="alert">
          <Icon name="alert" size="sm" />
          <span>{t('table:sync.outOfDate')}</span>
          <Button
            small
            variant="quiet"
            onClick={() => {
              window.location.reload()
            }}
          >
            {t('table:sync.refresh')}
          </Button>
        </p>
      )}

      {socketState === 'reconnecting' && (
        <p className={`${styles.banner} ${styles.bannerWarn}`} role="status">
          <Icon name="refresh" size="sm" />
          <span>{t('table:sync.banner')}</span>
        </p>
      )}

      {game.syncing && (
        <p className={`${styles.banner} ${styles.bannerInfo}`} role="status">
          <span>{t('table:turn.syncing')}</span>
        </p>
      )}

      {/* ★ Seat-private, and it arrives only for the seat about to lose its
          turn. Never a table broadcast — that would tell the other three
          exactly when to expect a free trick (04 §6.2). */}
      {game.ejectionWarning !== null && (
        <p className={`${styles.banner} ${styles.bannerWarn}`} role="alert">
          <Icon name="alert" size="sm" />
          <span>
            <strong>{t('table:warning.title')}</strong>{' '}
            {t('table:warning.body', { seconds: game.ejectionWarning.secondsRemaining })}
          </span>
        </p>
      )}

      {/* ── header ──────────────────────────────────────────────────────── */}

      <header className={`glass ${styles.header}`}>
        <span className={styles.seatPic} aria-hidden="true">
          <Icon name={gameIcon(table.gameSlug)} size="sm" />
        </span>
        <div className={styles.headerTitles}>
          <h1 className={styles.gameName}>{gameName}</h1>
          <p className={styles.tableMeta}>
            {t(`table:status.${statusKey(table.status)}`)}
            {table.hostDisplayName !== null && ` · ${table.hostDisplayName}`}
          </p>
        </div>

        <div className={styles.headerActions}>
          {isHost && table.status === 'WAITING' && (
            <Button
              variant="primary"
              small
              onClick={() => {
                void socketManager.startGame(table.id)
              }}
            >
              <Icon name="play" size="sm" />
              {t('table:toolbar.start')}
            </Button>
          )}
          {seated && table.status === 'WAITING' && (
            <Button
              variant="ghost"
              small
              onClick={() => {
                void socketManager.releaseSeat(table.id)
              }}
            >
              {t('table:seat.leave')}
            </Button>
          )}
        </div>
      </header>

      <div className={styles.layout}>
        <div style={{ display: 'grid', gap: 'var(--space-5)', minInlineSize: 0 }}>
          {/* ── seats ─────────────────────────────────────────────────── */}
          <section className={`glass ${styles.panel}`} aria-label={t('table:seat.number', { seat: '' })}>
            <SeatRing
              seats={table.seats}
              members={members}
              toAct={actingSeat}
              canSit={!seated && table.status === 'WAITING'}
              isHost={isHost}
              busySeat={busySeat}
              onSit={(seat) => {
                setBusySeat(seat)
                void socketManager.takeSeat(table.id, seat).finally(() => {
                  setBusySeat(null)
                })
              }}
              onAddBot={(seat) => {
                setBusySeat(seat)
                void socketManager.addBot(table.id, seat).finally(() => {
                  setBusySeat(null)
                })
              }}
              onRemoveBot={(seat) => {
                setBusySeat(seat)
                void socketManager.removeBot(table.id, seat).finally(() => {
                  setBusySeat(null)
                })
              }}
            />
          </section>

          {/* ── the game surface ──────────────────────────────────────── */}
          <section className={`glass ${styles.panel}`} aria-label={gameName}>
            <div className={styles.surface}>
              {/* The slot a per-game renderer fills from M1. Until then this
                  says what state the table is in rather than pretending to be
                  a board. */}
              {game.gameId === null ? (
                <>
                  <Icon name="clock" />
                  <p>{t('table:status.waiting')}</p>
                </>
              ) : (
                <>
                  <Icon name={gameIcon(table.gameSlug)} />
                  <p>{game.phase ?? t('table:status.inProgress')}</p>
                </>
              )}
            </div>
          </section>

          {game.reward !== null && <RewardSummary reward={game.reward} />}
        </div>

        {/* ── rail ──────────────────────────────────────────────────────── */}
        <aside style={{ display: 'grid', gap: 'var(--space-5)', alignContent: 'start' }}>
          {game.turnEndsAt !== null && actingSeat !== null && (
            <section className={`glass ${styles.panel}`}>
              <TurnTimerRing
                endsAt={game.turnEndsAt}
                totalMs={turnTimeoutMs}
                strikes={game.strikes}
                ejectAfterStrikes={game.ejectAfterStrikes}
                isYou={you?.seat === actingSeat}
                actingName={actingName}
              />
            </section>
          )}

          {/* ★ The ejection panel. It says what happened, what it costs, and
              offers the way back — with a live countdown, because the window is
              short and a static "you may reclaim" is a broken promise the
              moment it expires (04 §6.4). */}
          {game.ejected !== null && (
            <section className={`glass ${styles.panel}`} role="alert">
              <div className={styles.ejection}>
                <h2 className={styles.panelTitle}>{t('table:ejected.title')}</h2>
                <p className={styles.tableMeta}>
                  {game.ejected.reason === 'TURN_TIMEOUT'
                    ? t('table:ejected.bodyTimeout')
                    : game.ejected.reason === 'KICKED'
                      ? t('table:ejected.bodyKicked')
                      : t('table:ejected.bodyAbandon')}
                </p>
                {game.ejected.reason !== 'KICKED' && (
                  <p className={`${styles.banner} ${styles.bannerDanger}`}>
                    <Icon name="info" size="sm" />
                    <span>{t('table:ejected.noReward')}</span>
                  </p>
                )}

                {canReclaim ? (
                  <Button
                    variant="primary"
                    key={reclaimTick}
                    onClick={() => {
                      if (game.gameId !== null) void socketManager.reclaimSeat(game.gameId)
                    }}
                  >
                    {t('table:ejected.reclaimIn', {
                      time: formatDuration(reclaimRemaining, { locale, numerals }),
                    })}
                  </Button>
                ) : (
                  <p className={styles.tableMeta}>{t('table:ejected.reclaimGone')}</p>
                )}
              </div>
            </section>
          )}

          {/* A guest sees the pitch; a user never does. */}
          {status === 'guest' && <SignupNudge />}

          <TableChat
            onSend={async (body) => {
              await socketManager.sendChat(table.id, body)
            }}
          />
        </aside>
      </div>

      {/* ★ Screen-reader announcements for the two things a sighted player
          notices instantly and a blind one otherwise would not: whose turn it
          is, and what just happened. Same i18n keys the chat log uses. */}
      <p className="sr-only" role="status" aria-live="polite">
        {actingSeat === null
          ? ''
          : you?.seat === actingSeat
            ? t('table:turn.yours')
            : t('table:turn.theirs', { name: actingName })}
      </p>
    </div>
  )
}

function statusKey(status: string): string {
  return status === 'IN_PROGRESS'
    ? 'inProgress'
    : status === 'FINISHED'
      ? 'finished'
      : status === 'CLOSED'
        ? 'closed'
        : 'waiting'
}
