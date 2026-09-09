import { NotFoundError } from '../errors/errors.js'
import { fixtureMeta } from './_fixture/meta.js'
import { blackjackMeta } from './blackjack/meta.js'
import { chessMeta } from './chess/meta.js'
import type { AnyGameEngine, GameMeta } from './GameEngine.js'
import { assertValidMeta } from './metaSchema.js'
import { pokerMeta } from './poker/meta.js'
import { shelemMeta } from './shelem/meta.js'
import { sudokuMeta } from './sudoku/meta.js'

/**
 * The game registry — 05-game-engine-spec.md §5.
 *
 * This is P5 made concrete: **`GET /api/v1/games` is registry-driven**, so the
 * welcome page renders whatever `list()` returns and adding game #6 needs no
 * frontend deploy for the catalog — only the per-game renderer.
 *
 * It holds `GameMeta` and, separately, engines. At S17 there are five metas and
 * zero engines, which is exactly the state the catalog has to survive: a game
 * can be announced long before it can be played, and `comingSoon` is how the
 * card says so.
 */

/** The five v1 games, in the order the welcome page shows them. */
const PUBLIC_METAS: readonly GameMeta[] = [
  sudokuMeta,
  blackjackMeta,
  shelemMeta,
  pokerMeta,
  chessMeta,
]

export interface GameRegistry {
  /**
   * @throws {NotFoundError} for an unknown slug — including a dev-only slug in
   * production, which must be indistinguishable from a slug that never existed.
   */
  meta(slug: string): GameMeta
  /** The public catalog. Never includes `fixture`. */
  list(): readonly GameMeta[]
  has(slug: string): boolean

  /**
   * The engine for a slug, or `undefined` while the game is still `comingSoon`.
   *
   * Returning `undefined` rather than throwing keeps "announced but unplayable"
   * an ordinary state instead of an error path, which is what the catalog spends
   * all of M0 in.
   */
  engine(slug: string): AnyGameEngine | undefined
  /**
   * @throws {NotFoundError} when no engine has shipped for the slug.
   * For the paths that genuinely need to play a game — the session service.
   */
  requireEngine(slug: string): AnyGameEngine
}

export interface GameRegistryOptions {
  /**
   * Register the `fixture` game (11-build-plan.md §1.1). Off in production, and
   * a test asserts it: a dev-only test rig reachable in production would be a
   * game nobody wrote a renderer, a reward rule or a bot for.
   */
  readonly includeDevGames?: boolean
  /** Engines by slug. Empty until S30 registers `_fixture`. */
  readonly engines?: readonly AnyGameEngine[]
}

export function buildGameRegistry(options: GameRegistryOptions = {}): GameRegistry {
  const includeDevGames = options.includeDevGames ?? false

  const metas = includeDevGames ? [...PUBLIC_METAS, fixtureMeta] : PUBLIC_METAS
  // Validated here, at construction, so a malformed catalog entry fails at boot
  // with a message naming the slug and the field — rather than rendering as an
  // empty preview card that nobody notices for a week.
  const bySlug = new Map(metas.map((meta) => [assertValidMeta(meta).slug, meta]))

  const engines = new Map<string, AnyGameEngine>()
  for (const engine of options.engines ?? []) {
    if (!bySlug.has(engine.meta.slug)) {
      throw new TypeError(
        `engine '${engine.meta.slug}' has no catalog entry — add its meta to registry.ts first`,
      )
    }
    engines.set(engine.meta.slug, engine)
  }

  return {
    meta(slug) {
      const meta = bySlug.get(slug)
      if (!meta) throw new NotFoundError('Game', { slug })
      return meta
    },
    list() {
      // `fixture` is registered for `meta()`/`engine()` in dev but never
      // advertised: the welcome page's contract is "the games we offer".
      return PUBLIC_METAS
    },
    has(slug) {
      return bySlug.has(slug)
    },
    engine(slug) {
      return engines.get(slug)
    },
    requireEngine(slug) {
      const engine = engines.get(slug)
      if (!engine) throw new NotFoundError('Game engine', { slug })
      return engine
    },
  }
}
