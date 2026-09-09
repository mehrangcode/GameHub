import type { Logger } from 'pino'
import { toGuestIdentity, toUserIdentity } from '../../application/mappers/identity.js'
import type { GuestSessionService } from '../../application/services/GuestSessionService.js'
import type { MetricsRegistry } from '../../application/services/MetricsRegistry.js'
import type { SecurityEventService } from '../../application/services/SecurityEventService.js'
import type { IRateLimiter } from '../../application/ports/rateLimiter.js'
import { HANDSHAKE_FAILURE_RULE } from '../../config/socketLimits.js'
import type { Env } from '../../config/env.js'
import { AUTH_COOKIES, type Identity } from '../../contracts/dto/auth.js'
import type { IUserRepository } from '../../domain/repositories/identity.js'
import { TokenError, verifyAccessToken } from '../../infrastructure/auth/jwt.js'
import { parseCookieHeader } from './cookies.js'

/**
 * ★ Handshake identity — S23, 04 §1.1. The single most important file in the
 * socket layer.
 *
 * Identity is resolved **once**, here, from the cookies the browser sent with
 * the upgrade request, and is then frozen onto `socket.data` for the life of the
 * connection. Everything else in Phase F depends on that one sentence:
 *
 *   - Re-reading the cookie per event would let a token be swapped
 *     mid-connection, which is a session-fixation primitive.
 *   - Reading identity from a *payload* would let a client claim to be seat 2.
 *     No inbound schema in `contracts/events.ts` has such a field, and every one
 *     of them is `.strict()`, so a payload carrying one is rejected outright.
 *   - `seat` is therefore never asserted by a client. It is looked up from
 *     `TableMember` by identity + table, every time.
 *
 * Resolution order mirrors the REST `authenticate` middleware exactly, and for
 * the same reason: **the access cookie wins over the guest cookie.** A player
 * who signed up mid-session (journey J2) briefly holds both, and they are now a
 * user. Divergence between the two paths would mean a player who is a user over
 * HTTP and a guest over the socket, which is a bug with a very long fuse.
 *
 * ### What this does *not* share with the REST path
 *
 * `authenticate` never rejects — it leaves the request anonymous and lets
 * `authorize` decide. A socket has no equivalent of a public route: there is
 * nothing to subscribe to without an identity, and an anonymous socket would be
 * a connection we hold open, count against limits, and can never usefully
 * serve. So an unresolved handshake is a `connect_error UNAUTHORIZED`, and the
 * client's documented response is one `POST /auth/refresh` then one retry
 * (04 §9.6).
 *
 * It also cannot clear a bad cookie the way `authenticate` does: a WebSocket
 * upgrade has no response the browser will take a `Set-Cookie` from. A forged
 * cookie is therefore audited and refused, and the browser will keep presenting
 * it until an HTTP request clears it — which is exactly what the client's
 * refresh-then-retry does.
 */

/** Socket.IO's `connect_error` carries `message` plus whatever we hang on `data`. */
export class HandshakeError extends Error {
  readonly data: { code: string; i18nKey: string }

  constructor(code: string, i18nKey: string) {
    super(code)
    this.name = 'HandshakeError'
    this.data = { code, i18nKey }
  }
}

export const UNAUTHORIZED = () => new HandshakeError('UNAUTHORIZED', 'errors.unauthorized')
export const RATE_LIMITED = () => new HandshakeError('RATE_LIMITED', 'errors.rateLimited')

export interface HandshakeRequest {
  readonly cookieHeader: string | undefined
  readonly ip: string | null
  readonly userAgent: string | null
  /** Whatever the client put in `io(url, { auth })`. Never trusted for identity. */
  readonly auth: Record<string, unknown>
}

export interface HandshakeDeps {
  readonly users: IUserRepository
  readonly guests: GuestSessionService
  readonly security: SecurityEventService
  readonly metrics: MetricsRegistry
  readonly rateLimiter: IRateLimiter
  readonly logger: Logger
  readonly env: Env
}

export interface ResolvedHandshake {
  readonly identity: Identity
  readonly clientProtocolVersion: number | null
}

/**
 * @throws {HandshakeError} `UNAUTHORIZED` when no cookie resolves, or
 * `RATE_LIMITED` when this address has burned its failure budget.
 */
export async function resolveHandshake(
  request: HandshakeRequest,
  deps: HandshakeDeps,
): Promise<ResolvedHandshake> {
  const cookies = parseCookieHeader(request.cookieHeader)

  const identity =
    (await resolveUser(cookies, deps, request)) ?? (await resolveGuest(cookies, deps))

  if (identity === null) {
    await chargeFailure(request, deps)
    deps.metrics.increment('socket_handshake_rejected')
    throw UNAUTHORIZED()
  }

  return { identity, clientProtocolVersion: readProtocolVersion(request.auth) }
}

async function resolveUser(
  cookies: Record<string, string>,
  deps: HandshakeDeps,
  request: HandshakeRequest,
): Promise<Identity | null> {
  const token = cookies[AUTH_COOKIES.access]
  if (token === undefined || token.length === 0) return null

  try {
    const claims = await verifyAccessToken(token, deps.env)

    /**
     * The same read `authenticate` refuses to skip, and for the same reason: a
     * **banned** player must lose access now, not when their ten-minute token
     * expires. It matters more here than on HTTP — a socket is long-lived, so a
     * ban that only takes effect at the next handshake could take hours.
     */
    const user = await deps.users.findById(claims.sub)
    if (user === null || user.status !== 'ACTIVE') return null

    return toUserIdentity(user)
  } catch (error) {
    // An *expired* access token is the normal end of every ten-minute window,
    // not an attack: the client refreshes over HTTP and reconnects. A token we
    // did not mint is a different matter and leaves a trail.
    if (error instanceof TokenError && error.failure === 'expired') return null

    deps.security.record('BAD_TOKEN', {
      ip: request.ip,
      userAgent: request.userAgent,
      details: { cookie: AUTH_COOKIES.access, reason: 'ACCESS_TOKEN_INVALID', transport: 'socket' },
    })
    return null
  }
}

async function resolveGuest(
  cookies: Record<string, string>,
  deps: HandshakeDeps,
): Promise<Identity | null> {
  const token = cookies[AUTH_COOKIES.guest]
  if (token === undefined || token.length === 0) return null

  // `resolve` already refuses an expired, swept or *claimed* session, and
  // re-checks that the row's table matches the signed one. A claimed token that
  // still authenticated would be a second, weaker credential for a real user's
  // seat (07 §5.1) — which is precisely the credential a socket would hold open
  // for hours.
  const session = await deps.guests.resolve(token)
  if (session === null) return null

  return toGuestIdentity(session)
}

/**
 * Handshake failures are budgeted per IP (04 §8) — the only limit that can
 * apply before an identity exists, which is why it is keyed by address.
 *
 * **Failures only.** A phone in a tunnel reconnecting fifty times is the
 * product working as designed; fifty *rejected* handshakes from one address is
 * somebody trying cookies.
 */
async function chargeFailure(request: HandshakeRequest, deps: HandshakeDeps): Promise<void> {
  if (request.ip === null) return

  const decision = await deps.rateLimiter.consume(
    `socket:handshake:${request.ip}`,
    HANDSHAKE_FAILURE_RULE,
  )
  if (decision.allowed) return

  deps.security.record('RATE_LIMIT', {
    ip: request.ip,
    userAgent: request.userAgent,
    details: { bucket: 'socket:handshake', retryAfterMs: decision.retryAfterMs },
  })
  throw RATE_LIMITED()
}

/**
 * The client declares its protocol version in the handshake `auth`.
 *
 * Read here rather than trusted anywhere: it changes nothing about what the
 * connection may do. Its only job is to let the server tell an out-of-date page
 * to refresh, instead of the page half-working after a deploy mid-game
 * (04 §1.1). A missing or malformed value is `null` — an old client that does
 * not send one at all is exactly the case this exists for.
 */
function readProtocolVersion(auth: Record<string, unknown>): number | null {
  const declared = auth['protocolVersion']
  return typeof declared === 'number' && Number.isInteger(declared) ? declared : null
}
