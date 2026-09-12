import {
  GameMovePayloadSchema,
  GameRequestSyncPayloadSchema,
  GameStartPayloadSchema,
  type GameMoveResult,
  type GameStartResult,
  type GameSyncResult,
} from '../../../contracts/events.js'
import { GAME_MOVE_RULE, GAME_SYNC_RULE, SEAT_CHANGE_RULE } from '../../../config/socketLimits.js'
import { AppError } from '../../../domain/errors/AppError.js'
import { handler, type AckContext } from '../ack.js'
import { actorFor, atTable, type SocketContext } from '../context.js'
import { perSocket, spendSocketBudget } from '../rateLimit.js'

/**
 * The game, over the socket — S28–S30, 04 §3.1.
 *
 * Three events, and the shape of all three is the same: parse, establish *who*
 * from the socket, hand the work to `GameSessionService`, let the ack carry the
 * answer. There is no game logic in this file and there must never be — the
 * handler's entire job is to turn a frame into a service call by a caller whose
 * identity it did not take from the frame.
 *
 * ### The rule this file exists to enforce
 *
 * **The acting seat comes from the socket.** `game:move` carries no `seat` and
 * the schema is `.strict()`, so a payload that adds one is rejected outright
 * rather than ignored; `GameSessionService.applyMove` then reads the seat from
 * `TableMember` by the socket's frozen identity. A client cannot claim to be
 * seat 2 because there is nowhere to put the claim and nothing that would read
 * it.
 *
 * ### The limits, and what actually does the protecting
 *
 * `GAME_MOVE_RULE` (10 per 5 s) and `GAME_SYNC_RULE` (3 per 10 s) are 04 §8
 * transcribed, and both are keyed **per socket**: the cost being controlled is
 * server work on one connection, and a second tab genuinely doubles the
 * legitimate need.
 *
 * Neither is the real defence against a move flood. That is the turn itself —
 * a seat that is not to act gets `NOT_YOUR_TURN` from the engine, which is
 * cheaper than a limiter and produces an `AUDIT` row a limiter would not. The
 * budget here is the backstop for a client looping on its *own* turn.
 */

export interface GameHandlerDeps {
  readonly context: SocketContext
  readonly ack: AckContext
}

export function registerGameHandlers({ context, ack }: GameHandlerDeps): void {
  const { socket, container } = context

  // ── game:start ────────────────────────────────────────────────────────────
  socket.on(
    'game:start',
    handler(ack, GameStartPayloadSchema, async ({ tableId }) => {
      atTable(context, tableId)
      await spendSocketBudget(container, perSocket(socket.id, 'gameStart'), SEAT_CHANGE_RULE)

      const table = await container.tables.require(tableId)
      // Host authority is asserted inside the service, not here: a matchmade
      // table auto-starts with no socket at all (S43), and two gates are how
      // the two paths end up disagreeing about who may deal.
      const instance = await container.games.createInstance(tableId, await actorFor(context, table))

      return {
        gameId: instance.id,
        gameSlug: instance.gameSlug,
        seedCommit: instance.seedCommit,
        seq: instance.seq,
      } satisfies GameStartResult
    }),
  )

  // ── game:move ─────────────────────────────────────────────────────────────
  socket.on(
    'game:move',
    handler(ack, GameMovePayloadSchema, async ({ gameId, move, clientMoveId }) => {
      const instance = await container.games.requireActive(gameId)
      atTable(context, instance.tableId)
      await spendSocketBudget(container, perSocket(socket.id, 'move'), GAME_MOVE_RULE)

      try {
        const applied = await container.games.applyMove({
          gameId,
          identity: context.ref,
          move,
          clientMoveId,
        })

        return {
          gameId,
          seq: applied.seq,
          replayed: applied.replayed,
        } satisfies GameMoveResult
      } catch (error) {
        /**
         * ★ The refusal is delivered **twice**, and both are wanted.
         *
         * The ack answers the request that made it — that is what the client's
         * promise is waiting on. `game:moveRejected` is an event on the socket,
         * which is what a UI that has already optimistically greyed a card can
         * listen to without threading the ack through its render tree. 04 §3.2
         * lists both; the audit row that goes with them is written by the
         * service, where it belongs.
         */
        if (error instanceof AppError) {
          const api = error.toApiError()
          socket.emit('game:moveRejected', {
            gameId,
            clientMoveId,
            code: api.code,
            i18nKey: api.i18nKey,
            ...(api.details === undefined ? {} : { details: api.details }),
          })
        }
        throw error
      }
    }),
  )

  // ── game:requestSync ──────────────────────────────────────────────────────
  socket.on(
    'game:requestSync',
    handler(ack, GameRequestSyncPayloadSchema, async ({ gameId, lastSeq }) => {
      const instance = await container.games.requireActive(gameId)
      atTable(context, instance.tableId)
      await spendSocketBudget(container, perSocket(socket.id, 'requestSync'), GAME_SYNC_RULE)

      const outcome = await container.games.resync({
        gameId,
        identity: context.ref,
        socketId: socket.id,
        ...(lastSeq === undefined ? {} : { lastSeq }),
      })

      return { gameId, ...outcome } satisfies GameSyncResult
    }),
  )
}
