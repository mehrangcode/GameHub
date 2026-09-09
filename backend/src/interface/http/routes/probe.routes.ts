import { Router } from 'express'
import { z } from 'zod'
import type { Container } from '../../../container.js'
import { toWalletBalanceDto, toWalletTransactionDto } from '../../../application/mappers/wallet.js'
import { ClaimSeatRequestSchema, type ClaimSeatRequest } from '../../../contracts/dto/tables.js'
import { ASSET_CODES } from '../../../contracts/enums.js'
import { botRef } from '../../../domain/value-objects/identity.js'
import type { OccupantRef } from '../../../domain/value-objects/identity.js'
import { enforceGuestBinding, identityRefOf, requireIdentity } from '../middleware/authorize.js'
import { asyncHandler } from '../middleware/error.js'
import { validBody, validParams, zodValidate } from '../middleware/validate.js'

/**
 * Routes that exist so a behaviour can be *seen* from `curl`, mounted only
 * when `NODE_ENV !== 'production'`.
 *
 * Two different jobs live here:
 *
 *   1. `POST /_probe` (S12) — a deliberately picky schema, so one request
 *      demonstrates each boundary guarantee: a required field, a refusal to
 *      coerce `"5"` into `5`, and rejection of an unknown key.
 *   2. `/_probe/tables/:id/seats` (S20) — seat claim and release over HTTP.
 *   3. `GET /_probe/wallet` (S21) — a balance to read, until S37 ships the real
 *      `GET /wallet`.
 *
 * **The seat routes are temporary and dated.** Seat changes are socket
 * traffic: if a friend at the table would watch it happen, it goes over the
 * socket (02 §3.1), and `02` §5's REST surface deliberately lists no seat
 * routes. But S20's concurrency work lands four sessions before the gateway,
 * and "claim seat 1 as your user, then as the guest → 409" is a check worth
 * being able to run by hand. So the *service* is the real deliverable and these
 * are a window onto it, to be **deleted in S24** once `table:takeSeat` calls
 * the very same `TableService.claimSeat`.
 *
 * S16's `/_probe/table/:tableId` is gone: `GET /tables/:id` now carries
 * `enforceGuestBinding` itself, so the cross-table 403 and its
 * `SEAT_IMPERSONATION` row are observable on the real route.
 */
export const ProbeRequestSchema = z
  .object({
    /** No `z.coerce` — that is the point. `"5"` must fail. */
    n: z.number().int().min(1).max(10),
    label: z.string().min(2).max(20).optional(),
  })
  .strict()

export type ProbeRequest = z.infer<typeof ProbeRequestSchema>

/**
 * A path segment is always a string, so coercion here is required rather than
 * sloppy — the no-coercion rule (P7) is about *bodies*, where `"5"` means the
 * client has a bug.
 */
const SeatPathParamsSchema = z.object({
  id: z.string().min(1).max(64),
  seat: z.coerce.number().int().min(0).max(9),
})

type SeatPathParams = z.infer<typeof SeatPathParamsSchema>

const TableIdOnlySchema = z.object({ id: z.string().min(1).max(64) })
type TableIdOnly = z.infer<typeof TableIdOnlySchema>

export function buildProbeRouter(container: Container): Router {
  const router = Router()
  const { tables, guests } = container

  router.post('/_probe', zodValidate({ body: ProbeRequestSchema }), (req, res) => {
    res.json({ ok: true, echo: validBody<ProbeRequest>(req) })
  })

  /** Everything table-scoped below is guest-bound, exactly as the real routes are. */
  const atTable = [requireIdentity(), enforceGuestBinding(guests)] as const

  router.post(
    '/_probe/tables/:id/seats',
    ...atTable,
    zodValidate({ params: TableIdOnlySchema, body: ClaimSeatRequestSchema }),
    asyncHandler(async (req, res) => {
      const { id } = validParams<TableIdOnly>(req)
      const body = validBody<ClaimSeatRequest>(req)
      const actor = await actorFor(container, id, req.identity!)

      // ★ Seat identity comes from the authenticated caller, never from the
      // payload. A body may say which *seat* it wants; it can never say who is
      // sitting in it. Only the host may name a bot as the occupant, which the
      // service enforces.
      const occupant: OccupantRef = body.asBot === undefined ? actor.identity : botRef(body.asBot)

      res.status(201).json(await tables.claimSeat(id, body.seat, occupant, actor))
    }),
  )

  router.delete(
    '/_probe/tables/:id/seats/:seat',
    ...atTable,
    zodValidate({ params: SeatPathParamsSchema }),
    asyncHandler(async (req, res) => {
      const { id, seat } = validParams<SeatPathParams>(req)
      const actor = await actorFor(container, id, req.identity!)
      res.json(await tables.releaseSeat(id, seat, actor))
    }),
  )

  /**
   * `GET /_probe/wallet` — dev-only, **delete in S37**.
   *
   * The real `GET /wallet` and `/wallet/transactions` are S37's deliverable
   * (02 §5). This exists because S22's verification is "provisional 120 before,
   * vested 120 after" and that sentence needs something to read. Same
   * precedent, same reasoning and same fate as S16's `/_probe/table/:tableId`:
   * the *service* is the deliverable, and this is a window onto it.
   *
   * Level **G** — a guest may read their own provisional balance, which is the
   * whole point of accruing it (10 §3.4). A holder can only ever see their own:
   * there is no id parameter to point at somebody else.
   */
  router.get(
    '/_probe/wallet',
    requireIdentity(),
    asyncHandler(async (req, res) => {
      const holder = identityRefOf(req.identity!)
      const assets = holder.kind === 'user' ? ASSET_CODES : (['COIN'] as const)
      const balances = await container.wallets.balances(holder, assets)

      res.json({
        balances: balances.map(toWalletBalanceDto),
        transactions: (await container.wallets.statement(holder, 'COIN', { limit: 20 })).map(
          toWalletTransactionDto,
        ),
      })
    }),
  )

  router.post(
    '/_probe/tables/:id/spectators',
    ...atTable,
    zodValidate({ params: TableIdOnlySchema }),
    asyncHandler(async (req, res) => {
      const { id } = validParams<TableIdOnly>(req)
      const ref = identityRefOf(req.identity!)
      res.status(201).json(await tables.joinAsSpectator(id, ref, ref))
    }),
  )

  return router
}

/**
 * Resolves "who is asking, and are they the host" in one read.
 *
 * `isHost` is what separates *taking a seat* from *seating a bot* and *kicking
 * someone*; it is derived from the table row, never from the request.
 */
async function actorFor(
  container: Container,
  tableId: string,
  identity: NonNullable<Awaited<ReturnType<() => Express.Request['identity']>>>,
) {
  const table = await container.tables.require(tableId)
  const ref = identityRefOf(identity)
  return {
    identity: ref,
    isHost: ref.kind === 'user' && table.hostUserId === ref.userId,
  }
}
