import type { Request, RequestHandler } from 'express'
import type { GuestSessionService } from '../../../application/services/GuestSessionService.js'
import type { GuestIdentity, Identity, UserIdentity } from '../../../contracts/dto/auth.js'
import type { UserRole } from '../../../contracts/enums.js'
import { ForbiddenError, UnauthorizedError } from '../../../domain/errors/errors.js'
import { clientIp } from './rateLimit.js'

/**
 * The access levels from 02 §7's `Auth` column — the `authorize` slot.
 *
 * | Level | Guard | Meaning |
 * |---|---|---|
 * | **P** | *(none)* | Public. Anonymous callers welcome |
 * | **G** | {@link requireIdentity} | A user **or** a guest |
 * | **U** | {@link requireUser} | A real account. Guests refused |
 * | **H** | *(S18)* | Host of the table — needs the table repository |
 * | **A** | {@link requireRole} | `ADMIN`/`SUPPORT`. See the caveat below |
 *
 * Each is a separate middleware rather than one `authorize('U')` call, so the
 * requirement of a route is legible at its declaration and a typo is a compile
 * error instead of a silently-public endpoint.
 *
 * > **On level A:** it exists because 02 §7 lists it, and `requireRole` is used
 * > by the admin process. It must **never** appear on a router mounted by
 * > `app.ts`. A role check on `:3000` is precisely the bug the admin-isolation
 * > guards exist to prevent (12 §2.4) — if you are reaching for it here, the
 * > route belongs in `interface/admin/**` instead.
 */

export function identityOf(req: Request): Identity | undefined {
  return req.identity
}

/** Level **G** — a user or a guest, but not an anonymous caller. */
export function requireIdentity(): RequestHandler {
  return (req, _res, next) => {
    if (!req.identity) {
      next(new UnauthorizedError('Authentication required', { reason: 'NO_IDENTITY' }))
      return
    }
    next()
  }
}

/**
 * Level **U** — a real account.
 *
 * A guest hitting one of these gets **403, not 401**, and the distinction is
 * load-bearing: 401 tells the client "your credentials are stale, go refresh",
 * which would send a guest into a refresh loop it can never win. 403 says
 * "you are authenticated, and this still is not for you" — which is the truth,
 * and which the client renders as "sign up to do this".
 */
export function requireUser(): RequestHandler {
  return (req, _res, next) => {
    const identity = req.identity
    if (!identity) {
      next(new UnauthorizedError('Authentication required', { reason: 'NO_IDENTITY' }))
      return
    }
    if (identity.kind !== 'user') {
      next(new ForbiddenError('This action requires an account', { reason: 'ACCOUNT_REQUIRED' }))
      return
    }
    next()
  }
}

/** Level **A**. Read the caveat in this file's docblock before using it. */
export function requireRole(...roles: readonly UserRole[]): RequestHandler {
  return (req, _res, next) => {
    const identity = req.identity
    if (!identity || identity.kind !== 'user') {
      next(new UnauthorizedError('Authentication required', { reason: 'NO_IDENTITY' }))
      return
    }
    if (!roles.includes(identity.role)) {
      next(new ForbiddenError('Insufficient role', { reason: 'ROLE_REQUIRED' }))
      return
    }
    next()
  }
}

/**
 * ★ The guest-binding check — 07 §3, the core of S16.
 *
 * Mounted on every table-scoped route. A guest touching a table other than the
 * one its token names is refused **and** audited; a user or an anonymous caller
 * passes straight through, because their access is decided by ownership and
 * membership rules instead (S18–S20).
 *
 * This is a separate middleware rather than a line inside each handler for the
 * same reason projection is a single function: the guarantee has to hold for
 * routes nobody has written yet, and a rule that must be remembered per route
 * is a rule that will eventually be forgotten on one.
 */
export function enforceGuestBinding(
  guests: GuestSessionService,
  tableIdOf: (req: Request) => string | undefined = defaultTableId,
): RequestHandler {
  return (req, _res, next) => {
    const identity = req.identity
    if (!identity || identity.kind !== 'guest') {
      next()
      return
    }

    const tableId = tableIdOf(req)
    if (tableId === undefined) {
      next()
      return
    }

    try {
      guests.assertBoundTo(identity, tableId, {
        ip: clientIp(req),
        userAgent: req.get('user-agent') ?? null,
      })
      next()
    } catch (error) {
      next(error)
    }
  }
}

/** `:tableId` where a route names it explicitly, `:id` on `/tables/:id`. */
function defaultTableId(req: Request): string | undefined {
  const params = req.params as Record<string, string | undefined>
  return params.tableId ?? params.id
}

/** Narrowing helpers, so handlers read the identity without re-checking `kind`. */
export function asUser(req: Request): UserIdentity {
  const identity = req.identity
  if (!identity || identity.kind !== 'user') {
    // Unreachable behind `requireUser`. Reaching it means a route forgot the
    // guard, which is our bug — and it must fail closed, not read `undefined`.
    throw new UnauthorizedError('Authentication required', { reason: 'NO_IDENTITY' })
  }
  return identity
}

export function asGuest(req: Request): GuestIdentity {
  const identity = req.identity
  if (!identity || identity.kind !== 'guest') {
    throw new ForbiddenError('This action requires a guest session', { reason: 'GUEST_REQUIRED' })
  }
  return identity
}
