import { Router } from 'express'
import type { Container } from '../../../container.js'
import {
  CreateInviteBodySchema,
  TableInviteCodeParamsSchema,
  type CreateInviteRequest,
  type TableInviteCodeParams,
} from '../../../contracts/dto/invites.js'
import {
  CreateTableRequestSchema,
  PatchTableRequestSchema,
  TableIdParamsSchema,
  type CreateTableRequest,
  type PatchTableRequest,
  type TableIdParams,
} from '../../../contracts/dto/tables.js'
import {
  asUser,
  enforceGuestBinding,
  identityRefOrNull,
  requireHost,
  requireIdentity,
  requireUser,
} from '../middleware/authorize.js'
import { asyncHandler } from '../middleware/error.js'
import { validBody, validParams, zodValidate } from '../middleware/validate.js'

/**
 * `/api/v1/tables/*` — 02 §5, and the access levels are the interesting part:
 *
 * | Route | Level | Why that one |
 * |---|---|---|
 * | `POST /tables` | **U** | Hosting needs an account. A guest exists only inside one table |
 * | `GET /tables/mine` | **U** | A guest has exactly one table and no list to browse |
 * | `GET /tables/:id` | **G** + binding | Guests at *this* table read it; guests elsewhere get 403 |
 * | `PATCH`/`DELETE /tables/:id` | **H** | Host only, and `WAITING` only |
 * | `POST`/`DELETE /tables/:id/invites` | **H** | Minting a join capability is a host act |
 *
 * `enforceGuestBinding` sits on the one G-level route and is what makes S16's
 * central property observable through the real API: a guest token for table A
 * against table B is a 403 *and* a `SEAT_IMPERSONATION` audit row. It reads
 * `:id` from the path, so no handler has to remember the check.
 */
export function buildTablesRouter(container: Container): Router {
  const router = Router()
  const { tables, invites, guests } = container

  const host = requireHost(tables)

  router.post(
    '/tables',
    requireUser(),
    zodValidate({ body: CreateTableRequestSchema }),
    asyncHandler(async (req, res) => {
      const table = await tables.create(asUser(req).userId, validBody<CreateTableRequest>(req))
      res.status(201).json(table)
    }),
  )

  /** Before `/tables/:id`, or Express reads "mine" as an id. */
  router.get(
    '/tables/mine',
    requireUser(),
    asyncHandler(async (req, res) => {
      res.json(await tables.listMine(asUser(req).userId))
    }),
  )

  router.get(
    '/tables/:id',
    requireIdentity(),
    zodValidate({ params: TableIdParamsSchema }),
    enforceGuestBinding(guests),
    asyncHandler(async (req, res) => {
      const { id } = validParams<TableIdParams>(req)
      res.json(await tables.detail(id, identityRefOrNull(req)))
    }),
  )

  router.patch(
    '/tables/:id',
    zodValidate({ params: TableIdParamsSchema, body: PatchTableRequestSchema }),
    host,
    asyncHandler(async (req, res) => {
      const { id } = validParams<TableIdParams>(req)
      res.json(await tables.patch(id, validBody<PatchTableRequest>(req), identityRefOrNull(req)))
    }),
  )

  router.delete(
    '/tables/:id',
    zodValidate({ params: TableIdParamsSchema }),
    host,
    asyncHandler(async (req, res) => {
      await tables.close(validParams<TableIdParams>(req).id)
      // 204: closing is idempotent and there is nothing left worth returning.
      res.status(204).end()
    }),
  )

  // ── Invites (S19). Minting and revoking are host acts; resolving is public
  //    and lives in `invites.routes.ts` with no auth at all. ────────────────

  router.get(
    '/tables/:id/invites',
    zodValidate({ params: TableIdParamsSchema }),
    host,
    asyncHandler(async (req, res) => {
      res.json(await invites.listByTable(validParams<TableIdParams>(req).id))
    }),
  )

  router.post(
    '/tables/:id/invites',
    zodValidate({ params: TableIdParamsSchema, body: CreateInviteBodySchema }),
    host,
    asyncHandler(async (req, res) => {
      const { id } = validParams<TableIdParams>(req)
      const invite = await invites.mint(id, asUser(req).userId, validBody<CreateInviteRequest>(req))
      res.status(201).json(invite)
    }),
  )

  router.delete(
    '/tables/:id/invites/:code',
    zodValidate({ params: TableInviteCodeParamsSchema }),
    host,
    asyncHandler(async (req, res) => {
      const { id, code } = validParams<TableInviteCodeParams>(req)
      res.json(await invites.revoke(id, code))
    }),
  )

  return router
}
