import { useTranslation } from 'react-i18next'
import { Button } from '@/components/Button'
import { Icon } from '@/components/Icon'
import type { SeatView } from '@/contracts/dto/tables'
import type { MemberView } from '@/contracts/dto/tables'
import { initialsOf } from '@/lib/format'
import styles from './Table.module.css'

/**
 * The seat map — S44, 06 §5.1.
 *
 * ★ It **mirrors under RTL for free**, because it is a CSS grid built from
 * logical properties and nothing here positions a seat by `left`. There is no
 * RTL stylesheet and no `dir`-conditional layout code; that is the entire point
 * of the logical-properties rule.
 *
 * Every occupant kind renders distinctly — user, guest, bot, bot-substituted,
 * empty — because a seat map that cannot tell a bot from a disconnected human
 * is how "why isn't anyone playing?" becomes a support question.
 */
export function SeatRing({
  seats,
  members,
  toAct,
  canSit,
  isHost,
  onSit,
  onAddBot,
  onRemoveBot,
  busySeat,
}: {
  seats: readonly SeatView[]
  members: readonly MemberView[]
  toAct: number | null
  canSit: boolean
  isHost: boolean
  onSit: (seat: number) => void
  onAddBot: (seat: number) => void
  onRemoveBot: (seat: number) => void
  busySeat: number | null
}) {
  const { t } = useTranslation(['table', 'common'])

  // Presence lives on the member row, not the seat row — a seat map without it
  // is the frozen-table bug: a disconnected player and a thinking player
  // render identically.
  const presenceOf = (memberId: string | null) =>
    memberId === null ? null : (members.find((m) => m.memberId === memberId)?.presence ?? null)

  return (
    <ul className={styles.seats} aria-label={t('table:seat.number', { seat: '' })}>
      {seats.map((seat) => {
        const occupant = seat.occupant
        const empty = occupant === null
        const isBot = occupant?.kind === 'bot'
        const presence = presenceOf(seat.memberId)

        const name = empty
          ? t('table:seat.empty')
          : isBot
            ? t('table:seat.bot')
            : seat.isSelf
              ? t('table:seat.you')
              : (occupant.displayName ?? t('table:seat.number', { seat: seat.seat }))

        return (
          <li
            key={seat.seat}
            className={styles.seat}
            data-turn={toAct === seat.seat}
            data-self={seat.isSelf}
            data-empty={empty}
          >
            <span className={styles.seatPic} aria-hidden="true">
              {empty ? <Icon name="plus" size="sm" /> : isBot ? <Icon name="bot" size="sm" /> : initialsOf(name)}
              {presence !== null && !isBot && (
                <span className={styles.presenceDot} data-state={presence} />
              )}
            </span>

            <span className={styles.seatBody}>
              <span className={styles.seatName}>{name}</span>
              <span className={styles.seatTags}>
                {seat.team !== null && (
                  <span className={`${styles.tag} ${styles.tagTeam}`}>
                    {t('table:seat.team', { team: seat.team + 1 })}
                  </span>
                )}
                {isBot && <span className={`${styles.tag} ${styles.tagBot}`}>{t('table:seat.bot')}</span>}
                {/* A bot holding an ejected human's seat is a different thing
                    from a bot the host added, and the reclaim window depends on
                    knowing which. */}
                {seat.botSubstituted && (
                  <span className={`${styles.tag} ${styles.tagWarn}`}>
                    {t('table:system.playerEjected', { name: '' }).trim()}
                  </span>
                )}
                {presence === 'disconnected' && (
                  <span className={`${styles.tag} ${styles.tagWarn}`}>
                    {t('common:presence.disconnected')}
                  </span>
                )}
              </span>
            </span>

            <span className={styles.seatAction}>
              {empty && canSit && (
                <Button
                  small
                  onClick={() => {
                    onSit(seat.seat)
                  }}
                  pending={busySeat === seat.seat}
                >
                  {t('table:seat.sitHere')}
                </Button>
              )}
              {empty && !canSit && isHost && (
                <Button
                  small
                  variant="ghost"
                  onClick={() => {
                    onAddBot(seat.seat)
                  }}
                  pending={busySeat === seat.seat}
                >
                  {t('table:seat.addBot')}
                </Button>
              )}
              {isBot && isHost && !seat.botSubstituted && (
                <Button
                  small
                  variant="ghost"
                  onClick={() => {
                    onRemoveBot(seat.seat)
                  }}
                  pending={busySeat === seat.seat}
                >
                  {t('table:seat.removeBot')}
                </Button>
              )}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
