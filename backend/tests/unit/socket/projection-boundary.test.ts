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
   */
  const LEAKY = [
    /tableRoom\([^)]*\)\s*,\s*'game:state'/,
    /spectatorRoom\([^)]*\)\s*,\s*'game:state'/,
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

  it('and nothing emits game state at all yet, which is why the guard is cheap now', () => {
    // A canary, not a rule. When S30 makes this fail, the guard above stops
    // being theoretical and this line should be deleted along with the sentence
    // in the docblock about converting it to a lint rule.
    const emitters = sources
      // `keys.ts` names the string in its forbidden-Redis-key vocabulary, which
      // is the opposite of emitting it.
      .filter((file) => file.path !== 'infrastructure/redis/keys.ts')
      .filter(({ text }) => /emit\(\s*'game:state'|,\s*'game:state'/.test(text))

    expect(emitters.map((file) => file.path)).toEqual([])
  })
})

describe('the seat room is reachable from the projection path only', () => {
  it('nothing outside the socket layer and the port names a seat room', () => {
    // Keeps the private channel from acquiring a second caller by accident. A
    // service that wants to reach a seat should be publishing through the port,
    // where the addressing decision is reviewable.
    const callers = sources
      .filter(({ text }) => /\bseatRoom\(/.test(text))
      .map((file) => file.path)
      .filter(
        (path) => !path.startsWith('interface/socket/') && path !== 'application/ports/realtime.ts',
      )

    expect(callers).toEqual([])
  })
})
