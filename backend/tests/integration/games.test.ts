import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { GameDetailSchema, GameSummarySchema } from '../../src/contracts/dto/games.js'
import { buildTestApp, productionEnv } from '../helpers/app.js'

/**
 * S17 — `GET /games`, the endpoint the welcome page is built from.
 *
 * Two properties carry the session, and both are about what is *not* in the
 * response: no authentication is required to read it, and no English appears
 * in it. The first makes the front page work for a stranger; the second is what
 * lets a Persian reader see a Persian game name (02 §8.1).
 */
const { app, resetLimits } = buildTestApp()

beforeEach(() => {
  resetLimits()
})

describe('GET /games', () => {
  it('★ answers with no cookie at all — the welcome page has no login', async () => {
    const res = await request(app).get('/api/v1/games')

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(5)
  })

  it('lists the five v1 games, all comingSoon at M0', async () => {
    const res = await request(app).get('/api/v1/games')

    expect(res.body.map((game: { slug: string }) => game.slug)).toEqual([
      'sudoku',
      'blackjack',
      'shelem',
      'poker',
      'chess',
    ])
    for (const game of res.body) {
      expect(game.comingSoon, game.slug).toBe(true)
    }
  })

  it('every entry satisfies GameSummary', async () => {
    const res = await request(app).get('/api/v1/games')

    for (const game of res.body) {
      const parsed = GameSummarySchema.safeParse(game)
      expect(parsed.success, `${game.slug}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true)
    }
  })

  it('★ carries i18n keys and no literal English', async () => {
    const res = await request(app).get('/api/v1/games')
    const wire = JSON.stringify(res.body)

    for (const game of res.body) {
      expect(game.preview.nameKey, game.slug).toMatch(/^games\.[a-z-]+\.name$/)
      expect(game.preview.taglineKey, game.slug).toMatch(/^games\.[a-z-]+\./)
      // A `name` field would be the exact regression this guards: the moment
      // the server renders a language, the client cannot switch it.
      expect(game).not.toHaveProperty('name')
      expect(game).not.toHaveProperty('tagline')
    }

    for (const english of ['Shelem', 'Blackjack', 'Sudoku', 'Chess', "Hold'em", 'Coming soon']) {
      expect(wire, `payload contains "${english}"`).not.toContain(english)
    }
  })

  it('declares turn limits and playable counts for the client to render', async () => {
    const res = await request(app).get('/api/v1/games')

    for (const game of res.body) {
      expect(game.playableCounts.length, game.slug).toBeGreaterThan(0)
      expect(game).toHaveProperty('turnTimeoutMs')
      for (const count of game.playableCounts) {
        expect(count).toBeGreaterThanOrEqual(game.minPlayers)
        expect(count).toBeLessThanOrEqual(game.maxPlayers)
      }
    }
  })

  it('never advertises the dev-only fixture game', async () => {
    const res = await request(app).get('/api/v1/games')

    expect(res.body.map((game: { slug: string }) => game.slug)).not.toContain('fixture')
  })
})

describe('GET /games/:slug', () => {
  it('publishes the options schema the create-table form renders from', async () => {
    const res = await request(app).get('/api/v1/games/shelem')

    expect(res.status).toBe(200)
    const parsed = GameDetailSchema.safeParse(res.body)
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)

    expect(res.body.optionsSchema.type).toBe('object')
    // `.strict()` on the server reaching the client as a refusal is what keeps
    // the form from offering a field the server will reject.
    expect(res.body.optionsSchema.additionalProperties).toBe(false)
    expect(res.body.defaultOptions).toBeTypeOf('object')
  })

  it('unknown slug → 404 NOT_FOUND', async () => {
    const res = await request(app).get('/api/v1/games/nope')

    expect(res.status).toBe(404)
    expect(res.body.code).toBe('NOT_FOUND')
    expect(res.body.i18nKey).toBe('errors.notFound')
  })

  it('an odd-looking slug is a 404, not a 400 — the registry gives the one honest answer', async () => {
    expect((await request(app).get('/api/v1/games/NOPE!')).status).toBe(404)
  })

  it('reaches the fixture game by slug in dev, though it is never listed', async () => {
    const res = await request(app).get('/api/v1/games/fixture')

    expect(res.status).toBe(200)
    expect(res.body.comingSoon).toBe(false)
  })

  it('★ 404s the fixture game in production, indistinguishably from a slug that never was', async () => {
    const production = buildTestApp({ env: productionEnv() })

    const dev = await request(app).get('/api/v1/games/fixture')
    const prod = await request(production.app).get('/api/v1/games/fixture')
    const never = await request(production.app).get('/api/v1/games/never-existed')

    expect(dev.status).toBe(200)
    expect(prod.status).toBe(404)
    // Identical but for the slug the caller supplied themselves: `code`,
    // `i18nKey` and the detail *shape* match a slug that never existed, so the
    // response never confirms that `fixture` is a real game somewhere. (An
    // invite code gets the stricter byte-identical treatment, because there
    // the code is a secret rather than the caller's own input — see
    // `invites.test.ts`.)
    expect({ ...prod.body, details: {} }).toEqual({ ...never.body, details: {} })
    expect(prod.body.details).toEqual({ slug: 'fixture' })
    expect(never.body.details).toEqual({ slug: 'never-existed' })
  })
})
