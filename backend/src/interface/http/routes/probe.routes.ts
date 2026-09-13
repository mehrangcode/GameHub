import { Router } from 'express'
import { z } from 'zod'
import type { Container } from '../../../container.js'
import { ClaimSeatRequestSchema, type ClaimSeatRequest } from '../../../contracts/dto/tables.js'
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
 *
 * `GET /_probe/wallet` (S21) is **gone**, exactly as dated: S37's real
 * `GET /wallet` and `GET /wallet/transactions` render the same balances at the
 * real access levels, so the window onto the service is no longer needed.
 *
 * **The seat routes were dated for deletion in S24, and are deliberately kept.**
 *
 * S24 shipped `table:takeSeat`, which calls the very same
 * `TableService.claimSeat`, so the original reason to remove these — a second
 * way to do one thing — now applies. They stay anyway, for one concrete reason
 * that only became visible after the Postman collection was written:
 *
 *   **Newman cannot speak Socket.IO.** Folder `07 Wallet & the claim` sets a
 *   guest into seat 2 and then asserts, after the claim, that `memberId` and
 *   `joinedAt` are unchanged — the single assertion that distinguishes a seat
 *   that was *updated* from one that was deleted and recreated, and therefore
 *   the headline check of journey J2 (S22). Deleting these routes would delete
 *   that coverage and leave nothing able to replace it over REST.
 *
 * The duplication is real but narrow: both paths call one method, so they
 * cannot disagree about the rules, and this router is still mounted only when
 * `NODE_ENV !== 'production'`. Re-dated **indefinitely** at S37: the constraint
 * that keeps them is not a missing feature that a later session will supply, it
 * is that Newman speaks HTTP and the seat protocol is a socket. That will not
 * change, so the deletion date has been removed rather than pushed again.
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
