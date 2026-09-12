import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ★ The projection boundary, guarded before there is anything to leak — 04 §4.1.
 *
 * The rule the whole platform hangs on: **the server never broadcasts game
 * state.** It sends N personalized projections. Public state goes to
 * `table:{id}`; a seat's private view goes to `seat:{id}:{n}` and nowhere else.
 * There is deliberately no code path that emits the same game payload to two
 * different seats.
 *
 * 04 §4.1 specifies an ESLint `no-restricted-syntax` rule for this. It is a
 * **test** instead, for one honest reason: `game:state` does not exist yet
 * (Phase G), so a lint rule would today be guarding a door with no room behind
 * it, and would sit unproven until S30 — while `tests/unit/lint-guards.test.ts`
 * proves every real guard rejects a deliberate violation. A source scan gives
 * the identical protection now and costs nothing to convert later.
 *
 * Phase F carries **no game state at all**, and that is exactly why the guard
 * lands now: the structure has to be right before it matters. When S30 puts
 * cards in these payloads, the door is already shut.
 */

const srcDir = join(process.cwd(), 'src')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return entry.endsWith('.ts') ? [full] : []
  })
}

const sources = walk(srcDir).map((file) => ({
  path: relative(srcDir, file).replaceAll('\\', '/'),
  text: readFileSync(file, 'utf8'),
}))

/** The four room builders. Every room name in the platform comes from one of them. */
const ROOM_BUILDERS = ['tableRoom', 'seatRoom', 'spectatorRoom', 'userRoom'] as const

describe('the room model is the only way to address anybody', () => {
  /**
   * A room name being *assembled*, in the two forms it can take: a template
   * literal that interpolates (`` `seat:${id}:${n}` ``) and string
   * concatenation (`'seat:' + id`).
   *
   * Matching on the interpolation rather than on the prefix alone is what keeps
   * the docblocks out of it — this codebase mentions `table:join` and
   * `seat:{tableId}:{seat}` in prose constantly, and a check that flagged those
   * would be turned off within a week.
   *
   * `user:` is deliberately **not** checked. `holderKey` (03 §2) produces the
   * byte-identical `user:{id}` for wallet ownership and rate-limit buckets, and
   * has done since Phase B — so the two are indistinguishable by shape. The
   * collision is harmless (a Socket.IO room and a Redis bucket share no
   * namespace) and the `user:` room carries only cross-table notifications,
   * never a projection. The three rooms that *can* carry hidden information are
   * the three checked here.
   */
  const HAND_BUILT = [/`(?:table|seat|spectators):\$\{/, /['"](?:table|seat|spectators):['"]\s*\+/]

  it.each(sources.filter((file) => file.path !== 'application/ports/realtime.ts'))(
    '$path builds no room name by hand',
    ({ text, path }) => {
      // A hand-assembled `seat:` name would be invisible to `rg 'seatRoom\\('`,
      // and invisible is how a hand leaks. Every room name comes from a builder
      // so that the audit is a single grep.
      for (const pattern of HAND_BUILT) {
        expect(
          pattern.test(text),
          `${path} assembles a room name by hand — use the builders in application/ports/realtime.ts`,
        ).toBe(false)
      }
    },
  )

  it('the builders exist and are exported from exactly one place', () => {
    const port = sources.find((file) => file.path === 'application/ports/realtime.ts')
    expect(port).toBeDefined()

    for (const builder of ROOM_BUILDERS) {
      expect(port?.text).toMatch(new RegExp(`export function ${builder}\\(`))
    }
  })
})

describe('★ no private projection may be addressed to a public room', () => {
  /**
   * The forbidden shape, in the two forms it can take:
   * `publish(tableRoom(x), 'game:state', …)` and
   * `io.to(tableRoom(x)).emit('game:state', …)`.
   *
   * ### Why `spectatorRoom` is not on this list (changed at S30)
   *
   * It was, when this file was written and there was nothing to send. 04 §3.2
   * settles it the other way: `game:state` is addressed to `seat:*` **and**
   * `spectators:*`, and that is correct rather than a concession. The spectator
   * projection is built from the `SPECTATOR` viewer, which by definition holds
   * no seat's hidden information — so one payload to many spectators leaks
   * nothing, while one payload to `table:{id}` would reach the *players* too
   * and hand every seat every other seat's hand.
   *
   * The syntactic guard is therefore narrowed to the room that genuinely
   * cannot receive a projection, and the semantic guarantee is covered by
   * something stronger: `tests/helpers/leak.ts` serializes the spectator
   * projection and asserts no seat's secret appears anywhere in it, for every
   * seat, for every game — which is a property a regex could never check.
   */
  const LEAKY = [
    /tableRoom\([^)]*\)\s*,\s*'game:state'/,
    /to\(\s*tableRoom\([^)]*\)\s*\)[\s\S]{0,40}?emit\(\s*'game:state'/,
  ]

  it.each(sources)('$path never sends game:state to a table room', ({ text, path }) => {
    for (const pattern of LEAKY) {
      expect(
        pattern.test(text),
        `${path} emits game:state to a shared room — it must go to seat:{id}:{n}, once per viewer (04 §4.1)`,
      ).toBe(false)
    }
  })

  it('★ the only thing that projects state is GameSessionService.broadcastState', () => {
    // The canary this replaces ("nothing emits game state at all yet") did its
    // job and was deleted at S30, exactly as its comment said it should be.
    // What takes its place is stronger: game state has exactly one emitter, so
    // "where can a hand go?" stays a one-file question rather than a grep.
    const emitters = sources
      // `keys.ts` names the string in its forbidden-Redis-key vocabulary, which
      // is the opposite of emitting it; `events.ts` and the port *declare* the
      // event rather than sending it.
      .filter((file) => file.path !== 'infrastructure/redis/keys.ts')
      .filter((file) => file.path !== 'contracts/events.ts')
      .filter(({ text }) => /emit\(\s*'game:state'|,\s*'game:state'/.test(text))
      .map((file) => file.path)

    expect(emitters).toEqual(['application/services/GameSessionService.ts'])
  })
})

describe('the seat room is reachable from the projection path only', () => {
  /**
   * The projection path itself — the one place outside the socket layer that
   * may name a seat room, because it *is* the mechanism the room exists for.
   * Adding a second entry here should feel expensive; that is the point.
   */
  const PROJECTION_PATH = 'application/services/GameSessionService.ts'

  it('nothing outside the socket layer and the projection path names a seat room', () => {
    // Keeps the private channel from acquiring a second caller by accident. A
    // service that wants to reach a seat should be publishing through the port,
    // where the addressing decision is reviewable.
    const callers = sources
      .filter(({ text }) => /\bseatRoom\(/.test(text))
      .map((file) => file.path)
      .filter(
        (path) =>
          !path.startsWith('interface/socket/') &&
          path !== 'application/ports/realtime.ts' &&
          path !== PROJECTION_PATH,
      )

    expect(callers).toEqual([])
  })
})
