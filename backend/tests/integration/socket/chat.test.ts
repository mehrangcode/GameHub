import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { I18N_KEY_PATTERN, SYSTEM_MESSAGE_KEYS } from '../../../src/contracts/dto/chat.js'
import type { ChatMessageView } from '../../../src/contracts/dto/chat.js'
import type { ChatMessagePayload, TableSnapshotPayload } from '../../../src/contracts/events.js'
import { resetDb } from '../../helpers/db.js'
import {
  settle,
  startSocketHarness,
  type Session,
  type SocketHarness,
  type TestClient,
} from '../../helpers/socket.js'

/**
 * S26 — chat, emotes, and the system narration.
 *
 * M0's exit criterion is *"both see each other join live; chat works both
 * ways"*, including for guests. The half of this session that is easy to get
 * wrong and hard to notice is the **SYSTEM** message: "Sara took seat 2" must
 * never be a sentence the server composed, because the same row has to render
 * in Persian for a Persian reader, months later, in a transcript nobody thought
 * to re-translate.
 */

let harness: SocketHarness
let host: Session

async function makeTable(): Promise<string> {
  const response = await request(harness.httpServer)
    .post('/api/v1/tables')
    .set('Cookie', host.cookie)
    .send({ gameSlug: 'fixture', seatCount: 4, options: {} })
    .expect(201)
  return (response.body as { id: string }).id
}

async function inviteTo(table: string): Promise<string> {
  const response = await request(harness.httpServer)
    .post(`/api/v1/tables/${table}/invites`)
    .set('Cookie', host.cookie)
    .send({})
    .expect(201)
  return (response.body as { code: string }).code
}

beforeEach(() => {
  // Chat is limited per *identity*, and every test here reuses one host. A
  // flood test therefore silences the rest of the file unless the buckets are
  // forgotten between cases.
  harness.resetLimits()
})

async function joined(session: Session, table: string): Promise<TestClient> {
  const client = await harness.open(session)
  await client.emit('table:join', { tableId: table })
  await client.next('table:snapshot')
  client.clear()
  return client
}

beforeAll(async () => {
  await resetDb()
  harness = await startSocketHarness()
  host = await harness.register('Mehrang')
})

afterAll(async () => {
  await harness.close()
})

describe('S26 · user ↔ guest, both ways', () => {
  let table: string
  let user: TestClient
  let guest: TestClient

  beforeEach(async () => {
    table = await makeTable()
    const code = await inviteTo(table)
    const guestSession = await harness.guest(code, 'Sara')

    user = await joined(host, table)
    guest = await joined(guestSession, table)
    user.clear()
    guest.clear()
  })

  it('★ a user speaks and the guest hears it, and back again', async () => {
    const sent = await user.emit<{ messageId: string }>('chat:send', {
      tableId: table,
      body: 'shall we start?',
    })
    expect(sent.ok).toBe(true)

    const heard = await guest.next<ChatMessagePayload>('chat:message')
    expect(heard.message.body).toBe('shall we start?')
    expect(heard.message.author).toMatchObject({
      kind: 'user',
      displayName: 'Mehrang',
      // The reader is the guest, so this is somebody else's message.
      isSelf: false,
    })
    // ★ A transcript is shown to spectators and to anyone holding the invite
    // link, so it carries a display name and never an account identifier.
    expect(JSON.stringify(heard.message)).not.toContain('userId')

    guest.clear()
    user.clear()

    const replied = await guest.emit('chat:send', { tableId: table, body: 'ready' })
    expect(replied.ok).toBe(true)

    const back = await user.next<ChatMessagePayload>('chat:message')
    expect(back.message.body).toBe('ready')
    expect(back.message.author).toMatchObject({ kind: 'guest', displayName: 'Sara' })

    user.close()
    guest.close()
  })

  it('the sender’s ack carries their own copy, marked isSelf', async () => {
    const sent = await user.emit<{ messageId: string }>('chat:send', {
      tableId: table,
      body: 'mine',
    })
    expect(sent.ok).toBe(true)

    // The composer settles its pending state from the ack rather than
    // special-casing the broadcast it is also about to receive.
    if (sent.ok) expect(sent.data.messageId).toBeTruthy()

    const own = await user.next<ChatMessagePayload>('chat:message')
    expect(own.message.author.isSelf).toBe(false) // the broadcast is neutral

    const stored = await harness.container.chat.history(table, {
      kind: 'user',
      userId: hostUserId(),
    })
    expect(stored.at(-1)?.author.isSelf).toBe(true) // read back as the author

    user.close()
    guest.close()
  })

  it('an over-length body is a VALIDATION_FAILED, not a truncation', async () => {
    const ack = await user.emit('chat:send', { tableId: table, body: 'x'.repeat(600) })

    expect(ack.ok).toBe(false)
    if (!ack.ok) {
      expect(ack.code).toBe('VALIDATION_FAILED')
      expect(ack.fieldErrors?.['body']).toEqual(['errors.field.tooBig'])
    }

    user.close()
    guest.close()
  })

  it('an empty body after normalisation is refused', async () => {
    // 500 zero-width characters is not a message, and a client that sends one
    // is not a client.
    const ack = await user.emit('chat:send', { tableId: table, body: '​​​' })
    expect(ack.ok).toBe(false)

    user.close()
    guest.close()
  })

  it('a blocked word is masked, and the rest of the sentence survives', async () => {
    await user.emit('chat:send', { tableId: table, body: 'that was shit, well played' })

    const heard = await guest.next<ChatMessagePayload>('chat:message')
    expect(heard.message.body).toBe('that was ███, well played')

    user.close()
    guest.close()
  })

  it('“Scunthorpe” survives — the mask matches tokens, not substrings', async () => {
    await user.emit('chat:send', { tableId: table, body: 'greetings from Scunthorpe' })

    const heard = await guest.next<ChatMessagePayload>('chat:message')
    expect(heard.message.body).toBe('greetings from Scunthorpe')

    user.close()
    guest.close()
  })
})

describe('S26 · rate limits', () => {
  it('★ text is throttled with a retryAfterMs, and the message is not persisted', async () => {
    const table = await makeTable()
    const client = await joined(host, table)

    const acks = []
    for (let index = 0; index < 12; index += 1) {
      acks.push(await client.emit('chat:send', { tableId: table, body: `line ${index}` }))
    }

    const refused = acks.filter((ack) => !ack.ok)
    expect(refused.length).toBeGreaterThan(0)

    const first = refused[0]
    if (first !== undefined && !first.ok) {
      expect(first.code).toBe('RATE_LIMITED')
      // A limit with no "when" reads to a user as a broken button.
      expect(first.retryAfterMs).toBeGreaterThan(0)
    }

    // ★ Dropped, not queued. A transcript containing messages nobody ever saw
    // is worse than a message that failed to send.
    const stored = await harness.container.chat.history(table, null, 100)
    expect(stored.filter((message) => message.kind === 'TEXT')).toHaveLength(
      acks.filter((ack) => ack.ok).length,
    )

    client.close()
  })

  it('★ emotes have their own bucket — spent text does not silence a reaction', async () => {
    const table = await makeTable()
    const client = await joined(host, table)

    // Burn the text budget completely.
    for (let index = 0; index < 12; index += 1) {
      await client.emit('chat:send', { tableId: table, body: `line ${index}` })
    }

    // An emote is a reaction; reacting to four things in a fast hand must not
    // cost you the ability to say "nice one", and a shared bucket would make
    // the cheaper action eat the more valuable one.
    const emote = await client.emit('chat:emote', { tableId: table, emoteId: 'clap' })
    expect(emote.ok).toBe(true)

    client.close()
  })

  it('an emote id that is not a slug is refused', async () => {
    const table = await makeTable()
    const client = await joined(host, table)

    // The shape is enforced so an emote id can never be a URL, a path, or a
    // sentence smuggled through the cheaper limit.
    const ack = await client.emit('chat:emote', {
      tableId: table,
      emoteId: 'https://evil.test/x',
    })
    expect(ack.ok).toBe(false)
    if (!ack.ok) expect(ack.fieldErrors?.['emoteId']).toEqual(['errors.emoteInvalid'])

    client.close()
  })
})

describe('S26 · SYSTEM messages are i18n keys', () => {
  it('★ a seat change narrates with a key and params, never English', async () => {
    const table = await makeTable()
    const client = await joined(host, table)

    await client.emit('table:takeSeat', { tableId: table, seat: 3 })
    await settle()

    const system = client
      .of('chat:message')
      .map((payload) => (payload as ChatMessagePayload).message)
      .filter((message) => message.kind === 'SYSTEM')

    expect(system.length).toBeGreaterThan(0)
    const seatTaken = system.find((message) => message.body === SYSTEM_MESSAGE_KEYS.seatTaken)
    expect(seatTaken).toBeDefined()
    expect(seatTaken?.params).toMatchObject({ name: 'Mehrang', seat: 3 })
    expect(seatTaken?.author.kind).toBe('system')

    client.close()
  })

  it('★ every SYSTEM body in the database matches the i18n-key shape', async () => {
    // The assertion that makes the rule enforceable rather than remembered: the
    // pattern forbids whitespace, which no English sentence can satisfy. If
    // somebody ever writes `body: \`${name} took seat ${seat}\``, this fails.
    const table = await makeTable()
    const client = await joined(host, table)

    await client.emit('table:takeSeat', { tableId: table, seat: 0 })
    await client.emit('table:addBot', { tableId: table, seat: 1, difficulty: 'easy' })
    await client.emit('table:removeBot', { tableId: table, seat: 1 })
    await client.emit('table:updateOptions', { tableId: table, options: { target: 4 } })
    await client.emit('table:releaseSeat', { tableId: table })
    await settle()

    const rows = await harness.container.repos.chat.listByTable(table, { limit: 100 })
    const system = rows.filter((row) => row.kind === 'SYSTEM')

    expect(system.length).toBeGreaterThanOrEqual(5)
    for (const row of system) {
      expect(row.body, `"${row.body}" is not an i18n key`).toMatch(I18N_KEY_PATTERN)
      expect(row.body).not.toMatch(/\s/)
    }

    // And every key the server emits is one the client has been told about.
    const declared = new Set<string>(Object.values(SYSTEM_MESSAGE_KEYS))
    for (const row of system) expect(declared.has(row.body)).toBe(true)

    client.close()
  })
})

describe('S26 · history in the snapshot', () => {
  it('★ a late joiner sees the conversation that happened before they arrived', async () => {
    const table = await makeTable()
    const code = await inviteTo(table)

    const early = await joined(host, table)
    await early.emit('chat:send', { tableId: table, body: 'first' })
    await early.emit('chat:send', { tableId: table, body: 'second' })
    await settle()

    const guestSession = await harness.guest(code, 'Latecomer')
    const late = await harness.open(guestSession)
    await late.emit('table:join', { tableId: table })

    const snapshot = await late.next<TableSnapshotPayload>('table:snapshot')
    const bodies = snapshot.chat
      .filter((message: ChatMessageView) => message.kind === 'TEXT')
      .map((message) => message.body)

    // Oldest first, so the client appends rather than reverses.
    expect(bodies).toEqual(['first', 'second'])

    early.close()
    late.close()
  })

  it('a redacted message keeps its place and loses its text', async () => {
    const table = await makeTable()
    const client = await joined(host, table)

    const sent = await client.emit<{ messageId: string }>('chat:send', {
      tableId: table,
      body: 'regrettable',
    })
    expect(sent.ok).toBe(true)
    if (!sent.ok) return

    await harness.container.repos.chat.redact(sent.data.messageId, new Date())

    // Moderation (12 §6) is a tombstone: the message's place in the
    // conversation stays, so the replies around it still make sense, and the
    // audit trail still knows who said something worth removing.
    const history = await harness.container.chat.history(table, null)
    const redacted = history.find((message) => message.id === sent.data.messageId)

    expect(redacted).toBeDefined()
    expect(redacted?.body).toBeNull()
    expect(redacted?.redactedAt).not.toBeNull()
    expect(JSON.stringify(history)).not.toContain('regrettable')

    client.close()
  })
})

describe('S26 · chat is table-scoped', () => {
  it('a guest cannot speak at a table it is not bound to', async () => {
    const bound = await makeTable()
    const other = await makeTable()
    const code = await inviteTo(bound)

    const guestSession = await harness.guest(code, 'Bound')
    const client = await joined(guestSession, bound)

    const ack = await client.emit('chat:send', { tableId: other, body: 'hello?' })
    expect(ack.ok).toBe(false)
    if (!ack.ok) expect(ack.code).toBe('FORBIDDEN')

    client.close()
  })

  it('a closed table keeps its transcript and stops taking new lines', async () => {
    const table = await makeTable()
    const client = await joined(host, table)
    await client.emit('chat:send', { tableId: table, body: 'gg' })
    await settle()

    await request(harness.httpServer)
      .delete(`/api/v1/tables/${table}`)
      .set('Cookie', host.cookie)
      .expect(204)

    // Refused rather than ignored: a message box that accepts input and drops
    // it is indistinguishable, from the player's side, from a network problem.
    const ack = await client.emit('chat:send', { tableId: table, body: 'anyone?' })
    expect(ack.ok).toBe(false)
    if (!ack.ok) expect(ack.code).toBe('ILLEGAL_PHASE_TRANSITION')

    const history = await harness.container.chat.history(table, null)
    expect(history.some((message) => message.body === 'gg')).toBe(true)

    client.close()
  })
})

function hostUserId(): string {
  return (host.body as { identity: { userId: string } }).identity.userId
}
