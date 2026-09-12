import type { Container } from '../../src/container.js'
import type { GameInstance } from '../../src/domain/entities/game.js'
import { userRef, type IdentityRef } from '../../src/domain/value-objects/identity.js'
import { seatId } from '../../src/domain/value-objects/seat.js'
import { makeUser } from './db.js'

/**
 * A `fixture` table with people sitting at it, and optionally a game already
 * dealt — the setup every Phase G test needs and none of them should re-derive.
 *
 * Seats are claimed through `TableService`, not by inserting `TableMember`
 * rows, so a test never runs against a seating arrangement the real seat-claim
 * path would have refused. The one thing it does bypass is HTTP: registering
 * four users over `/auth/register` for every test would spend the `auth:create`
 * budget and add a second of argon2 per case for no coverage — the auth flow
 * has its own suite.
 */

export interface SeatedTable {
  readonly tableId: string
  readonly hostUserId: string
  /** Seat index → the identity sitting in it. */
  readonly identities: readonly IdentityRef[]
}

export interface SeatTableOptions {
  readonly seats?: number
  /** Presses needed to win. Small keeps a full match inside one test. */
  readonly target?: number
  readonly allowSpectators?: boolean
}

export async function seatTable(
  container: Container,
  options: SeatTableOptions = {},
): Promise<SeatedTable> {
  const seats = options.seats ?? 2
  const host = await makeUser({ displayName: 'Host' })

  const table = await container.tables.create(host.id, {
    gameSlug: 'fixture',
    seatCount: seats,
    options: { target: options.target ?? 3 },
    ...(options.allowSpectators === undefined ? {} : { allowSpectators: options.allowSpectators }),
  })

  const identities: IdentityRef[] = []
  for (let seat = 0; seat < seats; seat += 1) {
    const player = seat === 0 ? host : await makeUser({ displayName: `P${seat}` })
    const identity = userRef(player.id)

    await container.tables.claimSeat(table.id, seat, identity, {
      identity: userRef(host.id),
      isHost: true,
    })
    identities.push(identity)
  }

  return { tableId: table.id, hostUserId: host.id, identities }
}

export interface DealtGame extends SeatedTable {
  readonly game: GameInstance
}

export async function dealGame(
  container: Container,
  options: SeatTableOptions = {},
): Promise<DealtGame> {
  const seated = await seatTable(container, options)
  const game = await container.games.createInstance(seated.tableId, {
    identity: userRef(seated.hostUserId),
    isHost: true,
  })

  return { ...seated, game }
}

/** Presses in turn order, `count` times, returning the seq after each move. */
export async function pressTurns(
  container: Container,
  game: DealtGame,
  count: number,
  startAt = 0,
): Promise<number[]> {
  const seqs: number[] = []

  for (let index = 0; index < count; index += 1) {
    const seat = (startAt + index) % game.identities.length
    const applied = await container.games.applyMove({
      gameId: game.game.id,
      identity: game.identities[seat] as IdentityRef,
      move: { kind: 'press' },
      clientMoveId: `m${index}-${seatId(seat)}`,
    })
    seqs.push(applied.seq)
  }

  return seqs
}
