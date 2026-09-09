import type { GameDetail, GameSummary } from '../../contracts/dto/games.js'
import type { GameMeta } from '../../domain/games/GameEngine.js'
import { toJsonSchema } from './jsonSchema.js'

/**
 * `GameMeta` → the wire.
 *
 * Named functions with explicit return types, for the same reason
 * `toUserIdentity` is one: the domain meta holds a live Zod schema and two
 * functions, and spreading it into a response would either throw in
 * `JSON.stringify` or silently drop them. Listing the fields makes the wire
 * shape a decision instead of an accident.
 */

export function toGameSummary(meta: GameMeta): GameSummary {
  return {
    slug: meta.slug,
    comingSoon: meta.comingSoon,
    minPlayers: meta.minPlayers,
    maxPlayers: meta.maxPlayers,
    playableCounts: [...meta.playableCounts],
    teams: meta.teams ? { size: meta.teams.size, count: meta.teams.count } : null,
    preview: {
      nameKey: meta.preview.nameKey,
      taglineKey: meta.preview.taglineKey,
      complexity: meta.preview.complexity,
      avgMinutes: [meta.preview.avgMinutes[0], meta.preview.avgMinutes[1]],
      art: meta.preview.art,
      hasHiddenInfo: meta.preview.hasHiddenInfo,
      usesStandardDeck: meta.preview.usesStandardDeck,
    },
    turnTimeoutMs: meta.turnTimeoutMs,
    supportsSpectators: meta.supportsSpectators,
    supportsBots: meta.supportsBots,
    matchmakingEnabled: meta.matchmaking.enabled,
  }
}

export function toGameDetail(meta: GameMeta): GameDetail {
  return {
    ...toGameSummary(meta),
    optionsSchema: toJsonSchema(meta.optionsSchema),
    defaultOptions: meta.defaultOptions,
    turnTimeoutByPhaseMs: meta.turnTimeoutByPhaseMs ? { ...meta.turnTimeoutByPhaseMs } : null,
    disconnectGraceMs: meta.disconnectGraceMs,
    reclaimAt: meta.reclaimAt,
    matchmakingPresets: meta.matchmaking.presets.map((preset) => ({
      id: preset.id,
      nameKey: preset.nameKey,
      seatCount: preset.seatCount,
      options: preset.options,
      preferHumansMs: preset.preferHumansMs,
    })),
  }
}
