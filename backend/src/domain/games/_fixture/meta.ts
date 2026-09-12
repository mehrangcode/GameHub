import { z } from 'zod'
import type { GameMeta } from '../GameEngine.js'

/**
 * The `fixture` game — 11-build-plan.md §1.1.
 *
 * Not product scope. M0's exit criteria include *"an idle player is warned,
 * struck twice, ejected, and replaced by a bot — the table plays on"*, and that
 * cannot be tested without a game, while the first real engine (Sudoku) is M1.
 * So M0 gets a deliberately trivial one: seats take turns pressing a button and
 * the state is a counter.
 *
 * Three rules keep it from becoming debt:
 *
 *   1. It is registered **only** when `NODE_ENV !== 'production'`, asserted by
 *      a test. It is absent from `GET /games` in every environment — the
 *      welcome page has no business advertising a test rig.
 *   2. Its `projectState` hides one field, so the leak-test harness has
 *      something real to catch (S30).
 *   3. It is **not** deleted at M1. It stays as the interface's regression
 *      fixture and the reference implementation new games are copied from.
 *
 * The meta lands at S17 because the table, invite and seat sessions all need a
 * slug they can actually create a table for; the engine itself arrives at S30.
 */
export const fixtureOptionsSchema = z
  .object({
    /** Presses needed to win. Small, so a full match fits inside one test. */
    target: z.number().int().min(1).max(100).default(5),
    /** Lets S32's strike ladder be exercised both ways without a code change. */
    strikesResetOnAction: z.boolean().default(true),
  })
  .strict()

export const fixtureMeta: GameMeta = {
  slug: 'fixture',
  minPlayers: 2,
  maxPlayers: 4,
  playableCounts: [2, 3, 4],

  optionsSchema: fixtureOptionsSchema,
  defaultOptions: fixtureOptionsSchema.parse({}),

  // Playable wherever it is registered at all — the flag would otherwise make
  // the dev-only slug uncreatable, which is the one thing it exists for.
  comingSoon: false,
  preview: {
    nameKey: 'games.fixture.name',
    taglineKey: 'games.fixture.tagline',
    complexity: 'light',
    avgMinutes: [1, 2],
    art: '/art/games/fixture.svg',
    hasHiddenInfo: true,
    usesStandardDeck: false,
  },

  /** Short on purpose: S31–S33 wait on these deadlines in real time. */
  turnTimeoutMs: 30_000,
  disconnectGraceMs: 15_000,
  reclaimAt: 'IMMEDIATE',

  /**
   * ★ The safest move on a timeout strike (04 §6.5): **pass**, never press.
   *
   * A default action must never spend a resource the player did not authorise,
   * and a press is the only thing in this game that can win or lose the match.
   * So the strike costs the turn and nothing else — which is precisely the
   * distinction S32 exists to preserve between *a strike* and *an ejection*.
   *
   * The state arrives as `unknown` because `GameMeta` is non-generic (it holds
   * six differently-stated engines); it is narrowed structurally rather than
   * cast, so a state shape that changes under it returns `null` instead of
   * producing a move the engine would then reject.
   */
  defaultActionOnTimeout: (state: unknown, seat: number) => {
    const typed = state as { phase?: unknown; toAct?: unknown }
    if (typed.phase !== 'PLAYING' || typed.toAct !== seat) return null
    return { kind: 'pass' }
  },

  supportsSpectators: true,
  supportsBots: true,

  /** Never queueable. A test rig in the matchmaking pool would be a bug. */
  matchmaking: { enabled: false, presets: [] },
}
