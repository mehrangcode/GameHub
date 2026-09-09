import type { GameDetail, GameSummary } from '../../contracts/dto/games.js'
import type { GameMeta } from '../../domain/games/GameEngine.js'
import type { GameRegistry } from '../../domain/games/registry.js'
import { ValidationError } from '../../domain/errors/errors.js'
import { toGameDetail, toGameSummary } from '../mappers/games.js'

/**
 * The catalog, as the API sees it — S17.
 *
 * Thin by design: the registry owns *what games exist* and this owns *what a
 * caller is told about them*. It is a service rather than a bare mapper call in
 * the route because `assertPlayable` belongs here — S18 needs the same three
 * checks ("does this game exist / is it playable / are these options valid")
 * and `TableService` must not reach into the registry to re-derive them.
 */
export class GameCatalogService {
  constructor(private readonly registry: GameRegistry) {}

  list(): GameSummary[] {
    return this.registry.list().map(toGameSummary)
  }

  /** @throws {NotFoundError} on an unknown slug. */
  detail(slug: string): GameDetail {
    return toGameDetail(this.registry.meta(slug))
  }

  /**
   * The gate `POST /tables` runs before it writes anything.
   *
   * @throws {NotFoundError} the slug does not exist (or is dev-only in prod)
   * @throws {ValidationError} the game is `comingSoon`, or `seatCount` is not
   *         one the game can actually seat
   *
   * `seatCount` is a `fieldErrors` entry rather than a bare 400 because the
   * create-table form renders it under the seat picker, in the reader's own
   * language.
   */
  assertPlayable(slug: string, seatCount: number): GameMeta {
    const meta = this.registry.meta(slug)

    if (meta.comingSoon) {
      throw new ValidationError(`game '${slug}' is not playable yet`, {
        gameSlug: ['errors.gameComingSoon'],
      })
    }

    if (!meta.playableCounts.includes(seatCount)) {
      throw new ValidationError(
        `seatCount ${seatCount} is not playable for '${slug}' (${meta.playableCounts.join(', ')})`,
        { seatCount: ['errors.seatCountNotPlayable'] },
        { playableCounts: [...meta.playableCounts] },
      )
    }

    return meta
  }

  /**
   * Parses table options with the **engine's own** schema.
   *
   * The parsed output is what gets stored, so a table records the options the
   * game will actually be played with — defaults filled in, unknown keys
   * refused — rather than whatever fragment the client happened to send. That
   * is what makes a stored table replayable a year later when a default moves.
   */
  parseOptions(meta: GameMeta, options: unknown): Record<string, unknown> {
    const result = meta.optionsSchema.safeParse(options ?? {})
    if (!result.success) {
      const fieldErrors: Record<string, string[]> = {}
      for (const issue of result.error.issues) {
        // An unrecognised key has an empty path, so name the offending keys
        // rather than filing them all under the options object itself.
        const paths =
          issue.code === 'unrecognized_keys'
            ? issue.keys.map((key) => [...issue.path, key].join('.'))
            : [issue.path.join('.')]

        for (const path of paths) {
          const key = `options.${path || '_'}`
          ;(fieldErrors[key] ??= []).push(i18nKeyFor(issue.code, issue.message))
        }
      }
      throw new ValidationError(
        `options rejected by ${meta.slug}: ${result.error.issues
          .map((issue) => `${issue.path.join('.')} ${issue.message}`)
          .join('; ')}`,
        fieldErrors,
      )
    }
    return result.data as Record<string, unknown>
  }
}

/**
 * Same contract as `zodValidate`'s mapping: a `fieldErrors` value is an i18n
 * key, never Zod's English. Kept local because a game's option schema may
 * supply its own key as a message, exactly as `PasswordSchema` does.
 */
const ISSUE_KEYS: Record<string, string> = {
  invalid_type: 'errors.field.invalidType',
  invalid_literal: 'errors.field.invalidValue',
  invalid_enum_value: 'errors.field.invalidOption',
  invalid_union: 'errors.field.invalidValue',
  invalid_union_discriminator: 'errors.field.invalidOption',
  invalid_string: 'errors.field.invalidFormat',
  too_small: 'errors.field.tooSmall',
  too_big: 'errors.field.tooBig',
  not_multiple_of: 'errors.field.invalidValue',
  unrecognized_keys: 'errors.field.unknownKey',
  custom: 'errors.field.invalid',
}

function i18nKeyFor(code: string, message: string): string {
  if (message.startsWith('errors.')) return message
  return ISSUE_KEYS[code] ?? 'errors.field.invalid'
}
