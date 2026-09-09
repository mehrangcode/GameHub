import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { PROTOCOL_VERSION } from '../../../src/contracts/events.js'
import { AUTH_COOKIES } from '../../../src/contracts/dto/auth.js'
import { resetDb } from '../../helpers/db.js'
import {
  cookieHeaderOf,
  expectConnectError,
  startSocketHarness,
  type SocketHarness,
  type Session,
} from '../../helpers/socket.js'

/**
 * S23 — the handshake, and the one property everything else rests on.
 *
 * 04 §1.1: identity is resolved **once**, from cookies, and nothing in any
 * payload can ever change it. These tests are the proof, and they are written
 * against a real upgrade over a real port because a handler tested in isolation
 * would pass with the middleware unmounted.
 */

let harness: SocketHarness
let host: Session
let tableId: string
let inviteCode: string

beforeAll(async () => {
  await resetDb()
  harness = await startSocketHarness()
  host = await harness.register('Mehrang')

  const table = await request(harness.httpServer)
    .post('/api/v1/tables')
    .set('Cookie', host.cookie)
    .send({ gameSlug: 'fixture', seatCount: 4, options: {} })
    .expect(201)
  tableId = (table.body as { id: string }).id

  const invite = await request(harness.httpServer)
    .post(`/api/v1/tables/${tableId}/invites`)
    .set('Cookie', host.cookie)
    .send({})
    .expect(201)
  inviteCode = (invite.body as { code: string }).code
})

afterAll(async () => {
  await harness.close()
})

describe('S23 · handshake identity', () => {
  it('a valid access cookie connects and resolves as a user', async () => {
    const client = await harness.open(host)

    const connected = await client.next<{ serverTime: number; protocolVersion: number }>(
      'connected',
    )
    expect(connected.protocolVersion).toBe(PROTOCOL_VERSION)
    // The client stores `serverTime - Date.now()` and renders every countdown
    // against the offset — a device with a skewed clock must still see the
    // deadline that can eject it (04 §9.7).
    expect(connected.serverTime).toBeGreaterThan(0)

    const sockets = await harness.gateway.io.fetchSockets()
    expect(sockets).toHaveLength(1)
    expect(sockets[0]?.data.identity).toMatchObject({ kind: 'user', displayName: 'Mehrang' })

    client.close()
  })

  it('a guest cookie resolves as a guest bound to its own table', async () => {
    const guest = await harness.guest(inviteCode, 'Sara')
    const client = await harness.open(guest)
    await client.next('connected')

    const socket = (await harness.gateway.io.fetchSockets()).find(
      (candidate) => candidate.data.identity.kind === 'guest',
    )

    expect(socket?.data.identity).toMatchObject({
      kind: 'guest',
      displayName: 'Sara',
      // ★ The binding is part of the identity itself. There is no unbound guest,
      // which is what makes "a guest may only join its own table" checkable
      // without a database read on every event.
      tableId,
    })

    client.close()
  })

  it('★ no cookies at all → connect_error UNAUTHORIZED', async () => {
    const error = await expectConnectError(harness.url, '')

    expect(error.message).toBe('UNAUTHORIZED')
    expect(error.data?.code).toBe('UNAUTHORIZED')
  })

  it('a forged access cookie is refused, and audited', async () => {
    const since = new Date(Date.now() - 60_000)
    const before = await harness.container.repos.securityEvents.countSince('BAD_TOKEN', since)

    const error = await expectConnectError(harness.url, `${AUTH_COOKIES.access}=not.a.real.jwt`)
    expect(error.message).toBe('UNAUTHORIZED')

    // A token we did not mint leaves a trail. Unlike the REST path, the socket
    // cannot *clear* the bad cookie — a WebSocket upgrade has no response the
    // browser takes a Set-Cookie from — so the audit row is the only signal.
    await expect
      .poll(() => harness.container.repos.securityEvents.countSince('BAD_TOKEN', since))
      .toBeGreaterThan(before)
  })

  it('a banned account cannot open a socket, even with a live token', async () => {
    const victim = await harness.register('Doomed')
    const identity = (victim.body as { identity: { userId: string } }).identity

    // The DB read the handshake refuses to skip. It matters more here than on
    // HTTP: a socket is long-lived, so a ban that only took effect at the next
    // handshake could take hours to bite.
    await harness.container.repos.users.update(identity.userId, { status: 'BANNED' })

    const error = await expectConnectError(harness.url, victim.cookie)
    expect(error.message).toBe('UNAUTHORIZED')
  })

  it('★ socket.data.identity is immutable for the socket’s life', async () => {
    const client = await harness.open(host)
    await client.next('connected')

    const [socket] = await harness.gateway.io.fetchSockets()
    const descriptor = Object.getOwnPropertyDescriptor(
      // `fetchSockets` returns a copy of `data`; the property flags live on the
      // real socket, which is what a handler would hold.
      [...harness.gateway.io.sockets.sockets.values()][0]!.data,
      'identity',
    )

    expect(descriptor?.writable).toBe(false)
    expect(descriptor?.configurable).toBe(false)
    expect(Object.isFrozen(socket?.data.identity)).toBe(true)

    client.close()
  })

  it('★ a payload carrying userId / playerId / seat cannot alter identity', async () => {
    const client = await harness.open(host)
    await client.next('connected')
    await client.emit('table:join', { tableId })

    const before = JSON.stringify(
      [...harness.gateway.io.sockets.sockets.values()].map((s) => s.data.identity),
    )

    for (const hostile of [
      { tableId, seat: 1, userId: 'somebody-else' },
      { tableId, seat: 1, playerId: 'somebody-else' },
      { tableId, seat: 1, guestSessionId: 'somebody-else' },
      { tableId, seat: 1, memberId: 'somebody-else' },
    ]) {
      const ack = await client.emit('table:takeSeat', hostile)

      // ★ Rejected, not merely ignored. Every inbound schema is `.strict()`, so
      // an unknown key is a refused event rather than a silently dropped field
      // — strictly stronger than the "is ignored" the build plan asks for, and
      // consistent with how every REST body in this codebase behaves.
      expect(ack.ok).toBe(false)
      if (!ack.ok) {
        expect(ack.code).toBe('VALIDATION_FAILED')
        expect(ack.i18nKey).toBe('errors.validationFailed')
        expect(Object.values(ack.fieldErrors ?? {}).flat()).toContain('errors.field.unknownKey')
      }
    }

    const after = JSON.stringify(
      [...harness.gateway.io.sockets.sockets.values()].map((s) => s.data.identity),
    )
    expect(after).toBe(before)

    // And nobody got seated by any of it.
    const detail = await request(harness.httpServer)
      .get(`/api/v1/tables/${tableId}`)
      .set('Cookie', host.cookie)
      .expect(200)
    expect((detail.body as { seats: Array<{ occupant: unknown }> }).seats[1]?.occupant).toBeNull()

    client.close()
  })

  it('counts spoof-shaped rejections, so a probe is visible', async () => {
    const snapshot = harness.container.metrics.snapshot()
    expect(snapshot.counters.socket_identity_spoof_attempts).toBeGreaterThan(0)
  })

  it('★ a frame over 100 KB is rejected', async () => {
    const client = await harness.open(host)
    await client.next('connected')

    // 04 §1.2: every payload this protocol carries is a few hundred bytes, so a
    // frame over 100 KB is a bug or an attack. Socket.IO closes the transport
    // rather than buffering it.
    const closed = new Promise<string>((resolve) => {
      client.socket.once('disconnect', (reason) => resolve(reason))
    })

    // Cast through a loose emitter: the typed map (correctly) has no way to
    // express a 200 KB body, which is the whole point of the assertion.
    ;(client.socket as unknown as { emit: (e: string, p: unknown) => void }).emit('chat:send', {
      tableId,
      body: 'x'.repeat(200_000),
    })

    await expect(closed).resolves.toBeTruthy()
  })

  it('a protocol-version mismatch is reported, not silently tolerated', async () => {
    const client = await harness.open(host, { protocolVersion: PROTOCOL_VERSION + 41 })

    const connected = await client.next<{ clientProtocolVersion: number | null }>('connected')
    expect(connected.clientProtocolVersion).toBe(PROTOCOL_VERSION + 41)

    const error = await client.next<{ i18nKey: string; details?: Record<string, unknown> }>('error')
    expect(error.i18nKey).toBe('errors.protocolVersionMismatch')
    expect(error.details).toMatchObject({ server: PROTOCOL_VERSION })

    client.close()
  })

  it('a client that declares no version connects without a warning', async () => {
    // An old client that sends nothing at all is exactly the case the field
    // exists for, and it must not be punished for it.
    const client = await harness.open(host, { protocolVersion: null })
    await client.next('connected')

    expect(client.of('error')).toHaveLength(0)
    client.close()
  })
})

describe('S23 · cookie handling at the handshake', () => {
  it('the access cookie wins over a guest cookie', async () => {
    // Journey J2: a player who signed up mid-session briefly holds both, and
    // they are now a user. Resolving them as a guest would send them back to a
    // provisional wallet and a table-bound identity they have just outgrown —
    // and would make them a user over HTTP and a guest over the socket.
    const guest = await harness.guest(inviteCode, 'Both')
    const user = await harness.register('RealAccount')

    const client = await harness.open({
      ...user,
      cookie: `${guest.cookie}; ${user.cookie}`,
    })
    await client.next('connected')

    const identities = [...harness.gateway.io.sockets.sockets.values()].map(
      (socket) => socket.data.identity,
    )
    expect(identities.some((identity) => identity.displayName === 'RealAccount')).toBe(true)
    expect(identities.every((identity) => identity.displayName !== 'Both')).toBe(true)

    client.close()
  })

  it('supertest cookies survive the trip into a Cookie header', async () => {
    // Guards the harness itself: a `cookieHeaderOf` that dropped attributes
    // *or* values would make every test above pass for the wrong reason.
    const response = await request(harness.httpServer)
      .post('/api/v1/auth/register')
      .send({
        email: `h${Date.now()}@test.dev`,
        password: 'correct-horse-battery',
        displayName: 'HeaderCheck',
      })
      .expect(201)

    const header = cookieHeaderOf(response)
    expect(header).toContain(`${AUTH_COOKIES.access}=`)
    expect(header).not.toContain('HttpOnly')
  })
})
