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

describe('the seat room is reachable from a short, named list of places', () => {
  /**
   * ★ Every service outside the socket layer that may address one seat.
   *
   * This list is meant to be expensive to extend, and it is written out rather
   * than pattern-matched so that extending it is a decision somebody makes in a
   * diff. Each entry needs a reason that survives the question *"why can this
   * not go to the table?"*:
   *
   * | | |
   * |---|---|
   * | `GameSessionService` | **The** projection path. It *is* the mechanism the seat room exists for: `projectState` once per viewer, each payload to the one room entitled to it (04 §4.1) |
   * | `TurnTimerService` | `game:ejectionWarning` (04 §6.2). A private nudge — broadcasting it would shame somebody in front of the table *and* tell the other three exactly when to expect a free trick |
   * | `SeatEnforcementService` | `game:rewardPreview` (04 §6.6). What this ejection costs *you*. Somebody else's forfeit is nobody else's business |
   * | `SettlementService` | `game:rewardPreview` and `game:rewardSettled` (10 §10). Somebody's coins, and the reason they earned none. `game:finished` already told the table who won; how much each seat was paid is between the platform and that player |
   *
   * Anything else wanting to reach a seat should be publishing through the
   * port, where the addressing decision is reviewable.
   */
  const SEAT_ADDRESSABLE = [
    'application/services/GameSessionService.ts',
    'application/services/TurnTimerService.ts',
    'application/services/SeatEnforcementService.ts',
    'application/services/SettlementService.ts',
  ]

  it('nothing outside the socket layer and that list names a seat room', () => {
    const callers = sources
      .filter(({ text }) => /\bseatRoom\(/.test(text))
      .map((file) => file.path)
      .filter(
        (path) =>
          !path.startsWith('interface/socket/') &&
          path !== 'application/ports/realtime.ts' &&
          !SEAT_ADDRESSABLE.includes(path),
      )

    expect(callers).toEqual([])
  })

  it('★ and every addition since sends no game state down that channel', () => {
    // The reason the list above is safe to extend: a warning, a reward preview
    // and a receipt carry no projection. If any of them ever learns to emit
    // `game:state`, the single-emitter assertion in this file fails first.
    for (const path of SEAT_ADDRESSABLE.slice(1)) {
      const file = sources.find((entry) => entry.path === path)!
      expect(/'game:state'/.test(file.text), `${path} must not emit game state`).toBe(false)
    }
  })
})
