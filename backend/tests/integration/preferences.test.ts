import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildTestApp, client, registerUser, uniqueSuffix } from '../helpers/app.js'
import { db, resetDb } from '../helpers/db.js'
import {
  DEFAULT_PREFERENCES,
  PreferencesResponseSchema,
} from '../../src/contracts/dto/preferences.js'

/**
 * S40 — `GET/PUT /me/preferences`.
 *
 * The interesting properties here are not the round-trip (a column read back is
 * rarely worth a test) but the three edges around it:
 *
 *   - a brand-new account has **no row**, and must still get a settings page;
 *   - a **guest is refused**, because their preferences live in `localStorage`
 *     and arrive with them at signup (03 §6.1 step 3) — a guest row here would
 *     be half an account for somebody who has not made one;
 *   - a patch is **partial**, so two tabs changing two different settings do
 *     not overwrite each other.
 */

const { app, container, resetLimits } = buildTestApp()

beforeEach(async () => {
  await resetDb()
  resetLimits()
})

afterAll(async () => {
  await container.shutdown()
})

describe('GET /me/preferences', () => {
  it('★ answers a user with no row with the defaults, never a 404', async () => {
    const { agent } = await registerUser(app)
    // Registration seeds a row, so remove it to reach the state the repository
    // documents as valid: a user who has never expressed a preference.
    await db.userPreferences.deleteMany({})

    const response = await agent.get('/api/v1/me/preferences')

    expect(response.status).toBe(200)
    expect(PreferencesResponseSchema.safeParse(response.body).success).toBe(true)
    expect(response.body).toMatchObject(DEFAULT_PREFERENCES)
    expect(response.body.updatedAt).toBe(new Date(0).toISOString())
  })

  it('the seeded row matches the contract defaults — schema and DTO cannot drift', async () => {
    const { agent } = await registerUser(app)

    const response = await agent.get('/api/v1/me/preferences')

    expect(response.status).toBe(200)
    // Registration writes the row with Prisma's column defaults; if those ever
    // diverge from DEFAULT_PREFERENCES, a client rendering before the fetch
    // resolves would flash the wrong theme.
    expect(response.body).toMatchObject({
      theme: DEFAULT_PREFERENCES.theme,
      numeralSystem: DEFAULT_PREFERENCES.numeralSystem,
      animationSpeed: DEFAULT_PREFERENCES.animationSpeed,
      soundEnabled: DEFAULT_PREFERENCES.soundEnabled,
      soundVolume: DEFAULT_PREFERENCES.soundVolume,
      showLegalMoveHints: DEFAULT_PREFERENCES.showLegalMoveHints,
      reducedMotion: DEFAULT_PREFERENCES.reducedMotion,
    })
  })

  it('★ refuses an anonymous caller', async () => {
    const response = await client(app).get('/api/v1/me/preferences')

    expect(response.status).toBe(401)
    expect(response.body.code).toBe('UNAUTHORIZED')
  })
})

describe('PUT /me/preferences', () => {
  it('★ a partial patch changes one field and leaves the rest alone', async () => {
    const { agent } = await registerUser(app)

    const first = await agent.put('/api/v1/me/preferences').send({ theme: 'dark' })
    expect(first.status).toBe(200)
    expect(first.body.theme).toBe('dark')

    const second = await agent.put('/api/v1/me/preferences').send({ numeralSystem: 'persian' })

    expect(second.status).toBe(200)
    expect(second.body.numeralSystem).toBe('persian')
    // ★ The point: the second call named only one field, and the first call's
    // choice survived it. A whole-object PUT would have reset this to 'system'.
    expect(second.body.theme).toBe('dark')
  })

  it('accepts a null cosmetic id — "back to the default" is a real choice', async () => {
    const { agent } = await registerUser(app)

    await agent.put('/api/v1/me/preferences').send({ cardBackId: 'persian-tile' })
    const response = await agent.put('/api/v1/me/preferences').send({ cardBackId: null })

    expect(response.status).toBe(200)
    expect(response.body.cardBackId).toBeNull()
  })

  it('rejects an empty patch rather than reporting success for a no-op', async () => {
    const { agent } = await registerUser(app)

    const response = await agent.put('/api/v1/me/preferences').send({})

    expect(response.status).toBe(400)
    expect(response.body.code).toBe('VALIDATION_FAILED')
  })

  it('★ rejects an unknown key rather than silently dropping it', async () => {
    const { agent } = await registerUser(app)

    const response = await agent
      .put('/api/v1/me/preferences')
      .send({ theme: 'dark', isAdmin: true })

    expect(response.status).toBe(400)
    expect(response.body.fieldErrors.isAdmin).toEqual(['errors.field.unknownKey'])
  })

  it('rejects a value outside the enum', async () => {
    const { agent } = await registerUser(app)

    const response = await agent.put('/api/v1/me/preferences').send({ theme: 'neon' })

    expect(response.status).toBe(400)
    expect(response.body.code).toBe('VALIDATION_FAILED')
  })

  it('clamps nothing silently — a volume above 100 is refused, not corrected', async () => {
    const { agent } = await registerUser(app)

    const response = await agent.put('/api/v1/me/preferences').send({ soundVolume: 250 })

    expect(response.status).toBe(400)
    expect(response.body.fieldErrors.soundVolume).toEqual(['errors.field.tooBig'])
  })
})

describe('guests', () => {
  it('★ a guest is refused: preferences are an account feature', async () => {
    const host = await registerUser(app)
    const table = await host.agent
      .post('/api/v1/tables')
      .send({ gameSlug: 'fixture', seatCount: 4, options: {} })
    const invite = await host.agent.post(`/api/v1/tables/${table.body.id}/invites`).send({})

    const guest = client(app)
    await guest
      .post('/api/v1/auth/guest')
      .send({ inviteCode: invite.body.code, displayName: `G${uniqueSuffix().slice(0, 8)}` })

    const read = await guest.get('/api/v1/me/preferences')
    const write = await guest.put('/api/v1/me/preferences').send({ theme: 'dark' })

    // FORBIDDEN, not UNAUTHORIZED: they *are* authenticated, as a guest. The
    // client renders "create an account" from this, not "sign in".
    expect(read.status).toBe(403)
    expect(read.body.code).toBe('FORBIDDEN')
    expect(write.status).toBe(403)
  })
})
