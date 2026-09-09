import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { GameDetailSchema, GameSummarySchema } from '../../../src/contracts/dto/games.js'
import { toGameDetail, toGameSummary } from '../../../src/application/mappers/games.js'
import {
  toJsonSchema,
  UnsupportedSchemaError,
} from '../../../src/application/mappers/jsonSchema.js'
import { GameCatalogService } from '../../../src/application/services/GameCatalogService.js'
import type { GameMeta } from '../../../src/domain/games/GameEngine.js'
import { assertValidMeta } from '../../../src/domain/games/metaSchema.js'
import { buildGameRegistry } from '../../../src/domain/games/registry.js'
import { NotFoundError, ValidationError } from '../../../src/domain/errors/errors.js'
import { fixtureMeta } from '../../../src/domain/games/_fixture/meta.js'

/**
 * S17 — the catalog, at the level where it is cheap to test.
 *
 * The registry is built at container construction, so a malformed entry is a
 * boot failure rather than an empty preview card nobody notices. These tests
 * are what make that claim true: they run the meta-schema over every shipped
 * game, and they prove the schema actually bites by handing it broken metas.
 */
const publicRegistry = buildGameRegistry()
const devRegistry = buildGameRegistry({ includeDevGames: true })

const ALL_V1_GAMES = ['sudoku', 'blackjack', 'shelem', 'poker', 'chess']

describe('the five v1 games', () => {
  it('are all listed, in welcome-page order', () => {
    expect(publicRegistry.list().map((meta) => meta.slug)).toEqual(ALL_V1_GAMES)
  })

  it('are all comingSoon at M0 — no engine has shipped yet', () => {
    for (const meta of publicRegistry.list()) {
      expect(meta.comingSoon, meta.slug).toBe(true)
      expect(publicRegistry.engine(meta.slug), meta.slug).toBeUndefined()
    }
  })

  it.each(ALL_V1_GAMES)('%s satisfies the GameMeta schema', (slug) => {
    expect(() => assertValidMeta(publicRegistry.meta(slug))).not.toThrow()
  })

  /**
   * The property S17 asks for by name. Offering a seat count the engine cannot
   * seat produces a table that either crashes on start or silently plays a
   * different game than the host chose.
   */
  it.each(ALL_V1_GAMES)('%s only offers playableCounts inside [min..max]', (slug) => {
    const meta = publicRegistry.meta(slug)

    expect(meta.playableCounts.length).toBeGreaterThan(0)
    for (const count of meta.playableCounts) {
      expect(count, `${slug} offers ${count}`).toBeGreaterThanOrEqual(meta.minPlayers)
      expect(count, `${slug} offers ${count}`).toBeLessThanOrEqual(meta.maxPlayers)
    }
  })

  it.each(ALL_V1_GAMES)('%s declares its turn limits (04 §6.1)', (slug) => {
    const meta = publicRegistry.meta(slug)

    // `null` is a real answer — Sudoku is a puzzle and chess has its own clock
    // — but *absent* is not: S31 arms a timer from this field.
    expect(meta.turnTimeoutMs === null || meta.turnTimeoutMs > 0, slug).toBe(true)
    expect(meta.disconnectGraceMs, slug).toBeGreaterThanOrEqual(0)
    expect(['IMMEDIATE', 'HAND_BOUNDARY', 'NEVER']).toContain(meta.reclaimAt)
  })

  it('teams divide the seats they are declared for', () => {
    for (const meta of publicRegistry.list()) {
      if (!meta.teams) continue
      const seats = meta.teams.size * meta.teams.count
      expect(meta.playableCounts, `${meta.slug} teams cover ${seats} seats`).toContain(seats)
    }
  })
})

describe('the meta-schema bites', () => {
  const broken = (patch: Partial<GameMeta>): GameMeta => ({ ...fixtureMeta, ...patch }) as GameMeta

  it('rejects a playable count the game cannot seat', () => {
    expect(() => assertValidMeta(broken({ playableCounts: [2, 9] }))).toThrow(/outside \[2\.\.4\]/)
  })

  it('★ rejects literal English where an i18n key belongs', () => {
    // The failure this exists to catch: a Persian reader receiving the string
    // "Fixture Game" from a server that cannot translate it (02 §8.1).
    expect(() =>
      assertValidMeta(broken({ preview: { ...fixtureMeta.preview, nameKey: 'Fixture Game' } })),
    ).toThrow(/dotted i18n key/)
  })

  it('rejects reversed minutes and inverted player bounds', () => {
    expect(() =>
      assertValidMeta(broken({ preview: { ...fixtureMeta.preview, avgMinutes: [9, 2] } })),
    ).toThrow(/avgMinutes is reversed/)
    expect(() => assertValidMeta(broken({ minPlayers: 5 }))).toThrow(/exceeds maxPlayers/)
  })

  it('rejects defaultOptions its own schema would refuse', () => {
    expect(() => assertValidMeta(broken({ defaultOptions: { target: 'five' } }))).toThrow(
      /defaultOptions/,
    )
  })

  it('rejects a matchmaking preset that forms an unplayable seat count', () => {
    expect(() =>
      assertValidMeta(
        broken({
          matchmaking: {
            enabled: true,
            presets: [
              {
                id: 'bad-preset',
                nameKey: 'games.fixture.preset',
                seatCount: 7,
                options: {},
                preferHumansMs: 0,
              },
            ],
          },
        }),
      ),
    ).toThrow(/not playable/)
  })

  it('names the offending slug and field', () => {
    expect(() => assertValidMeta(broken({ slug: 'Not A Slug' }))).toThrow(
      /GameMeta for 'Not A Slug' is malformed[\s\S]*slug/,
    )
  })
})

describe('the dev-only fixture game', () => {
  it('★ is absent from a production registry entirely', () => {
    expect(publicRegistry.has('fixture')).toBe(false)
    expect(() => publicRegistry.meta('fixture')).toThrow(NotFoundError)
    // Indistinguishable from a slug that never existed — a dev rig reachable
    // in production is a game with no renderer, no reward rule and no bot.
    expect(() => publicRegistry.meta('fixture')).toThrow(/Game/)
  })

  it('is reachable by slug in dev but never advertised', () => {
    expect(devRegistry.has('fixture')).toBe(true)
    expect(devRegistry.meta('fixture').slug).toBe('fixture')
    expect(devRegistry.list().map((meta) => meta.slug)).not.toContain('fixture')
  })

  it('is playable — the one thing it exists for', () => {
    expect(devRegistry.meta('fixture').comingSoon).toBe(false)
  })
})

describe('engines', () => {
  it('requireEngine throws for a game that has none yet', () => {
    expect(() => devRegistry.requireEngine('fixture')).toThrow(NotFoundError)
    expect(devRegistry.engine('fixture')).toBeUndefined()
  })

  it('refuses an engine with no catalog entry', () => {
    const orphan = { meta: { ...fixtureMeta, slug: 'not-registered' } }

    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      buildGameRegistry({ includeDevGames: true, engines: [orphan as any] }),
    ).toThrow(/has no catalog entry/)
  })
})

describe('the published wire shapes', () => {
  it.each(ALL_V1_GAMES)('%s maps to a valid GameSummary and GameDetail', (slug) => {
    const meta = publicRegistry.meta(slug)

    expect(GameSummarySchema.safeParse(toGameSummary(meta)).success, slug).toBe(true)
    expect(GameDetailSchema.safeParse(toGameDetail(meta)).success, slug).toBe(true)
  })

  /**
   * ★ Every option schema we ship must be expressible as JSON Schema, because
   * the client renders the create-table form from it. `toJsonSchema` throws on
   * a node it cannot express rather than truncating, so this test is what turns
   * "someone used `z.map()` in an options schema" into a failed build instead
   * of a form with a missing field.
   */
  it.each([...ALL_V1_GAMES, 'fixture'])('%s publishes a convertible optionsSchema', (slug) => {
    const meta = devRegistry.meta(slug)
    const json = toJsonSchema(meta.optionsSchema)

    expect(json.type).toBe('object')
    // `.strict()` on the domain side must reach the client as a refusal too.
    expect(json.additionalProperties).toBe(false)
    // Whatever the schema accepts by default is what a table gets when the
    // form sends nothing.
    expect(meta.optionsSchema.safeParse(meta.defaultOptions).success, slug).toBe(true)
  })

  it('carries no literal English anywhere in the catalog payload', () => {
    const wire = JSON.stringify(publicRegistry.list().map(toGameSummary))

    for (const english of ['Shelem', 'Blackjack', 'Sudoku', 'Chess', "Texas Hold'em"]) {
      expect(wire, `catalog contains "${english}"`).not.toContain(english)
    }
  })

  it('converts defaults, enums and bounds the way a form needs them', () => {
    const schema = z
      .object({
        target: z.number().int().min(1).max(100).default(5),
        mode: z.enum(['fast', 'slow']),
        label: z.string().min(2).optional(),
      })
      .strict()

    expect(toJsonSchema(schema)).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      properties: {
        target: { type: 'integer', minimum: 1, maximum: 100, default: 5 },
        mode: { type: 'string', enum: ['fast', 'slow'] },
        label: { type: 'string', minLength: 2 },
      },
    })
  })

  it('throws rather than truncating on a node it cannot express', () => {
    expect(() => toJsonSchema(z.object({ when: z.date() }).strict())).toThrow(
      UnsupportedSchemaError,
    )
  })
})

describe('GameCatalogService.assertPlayable', () => {
  const catalog = new GameCatalogService(devRegistry)

  it('refuses a comingSoon game with a field error, not a 404', () => {
    const error = catch_(() => catalog.assertPlayable('shelem', 4))

    // The create-table form renders this under the game picker, translated.
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).code).toBe('VALIDATION_FAILED')
    expect((error as ValidationError).fieldErrors?.gameSlug).toEqual(['errors.gameComingSoon'])
  })

  it('refuses a seat count the game cannot seat, and says which it can', () => {
    const error = catch_(() => catalog.assertPlayable('fixture', 5)) as ValidationError

    expect(error.fieldErrors?.seatCount).toEqual(['errors.seatCountNotPlayable'])
    expect(error.details?.playableCounts).toEqual([2, 3, 4])
  })

  it('404s an unknown slug before it considers anything else', () => {
    expect((catch_(() => catalog.assertPlayable('nope', 4)) as NotFoundError).code).toBe(
      'NOT_FOUND',
    )
  })

  it('★ stores post-parse options, so a table records what will actually be played', () => {
    const meta = catalog.assertPlayable('fixture', 4)

    // Defaults filled in — the stored row is replayable a year later even if
    // the default moves.
    expect(catalog.parseOptions(meta, {})).toEqual({ target: 5, strikesResetOnAction: true })
    expect(catalog.parseOptions(meta, { target: 9 })).toEqual({
      target: 9,
      strikesResetOnAction: true,
    })
  })

  it('rejects unknown option keys by name, with i18n keys', () => {
    const meta = catalog.assertPlayable('fixture', 4)
    const error = catch_(() => catalog.parseOptions(meta, { nope: 1 })) as ValidationError

    expect(error.code).toBe('VALIDATION_FAILED')
    expect(error.fieldErrors?.['options.nope']).toEqual(['errors.field.unknownKey'])
  })

  it('does not coerce an option, and reports the field that failed', () => {
    const meta = catalog.assertPlayable('fixture', 4)
    const error = catch_(() => catalog.parseOptions(meta, { target: '9' })) as ValidationError

    expect(error.fieldErrors?.['options.target']).toEqual(['errors.field.invalidType'])
    // Zod's English stays in the logged message, never in `fieldErrors`.
    for (const values of Object.values(error.fieldErrors ?? {})) {
      for (const value of values) expect(value).toMatch(/^errors\./)
    }
  })
})

function catch_(fn: () => unknown): unknown {
  try {
    fn()
    throw new Error('expected the call to throw, and it did not')
  } catch (error) {
    return error
  }
}
