import { createHash, randomInt } from 'node:crypto'

/**
 * 05-game-engine-spec.md §3 — the only source of randomness an engine may see.
 *
 * Engines are pure functions (I1). They take an `Rng`; they never reach for
 * ambient randomness. That is enforced, not trusted: ESLint guard 2 rejects
 * `Math.random()` anywhere under `src/domain/`.
 *
 * The payoff is that every bug in a card game reduces to `(seed, moves[])`.
 * "This hand scored wrong" stops being a story and becomes a fixture.
 */
export interface Rng {
  /** Uniform and unbiased over `[0, maxExclusive)`. */
  int(maxExclusive: number): number
  pick<T>(items: readonly T[]): T
  /** Returns a **new** array. Never mutates its input. */
  shuffle<T>(items: readonly T[]): T[]
}

function assertPositiveInt(maxExclusive: number): void {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new RangeError(`maxExclusive must be a positive integer, got ${String(maxExclusive)}`)
  }
}

/**
 * Fisher–Yates over an unbiased integer source.
 *
 * `rng.int(i + 1)` — not `Math.floor(rng.float() * (i + 1))`. The float form
 * reintroduces modulo bias through the mantissa, which is exactly the defect
 * `crypto.randomInt`'s rejection sampling exists to avoid.
 */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1)
    const ai = a[i] as T
    a[i] = a[j] as T
    a[j] = ai
  }
  return a
}

function fromIntSource(int: (maxExclusive: number) => number): Rng {
  const rng: Rng = {
    int(maxExclusive) {
      assertPositiveInt(maxExclusive)
      return int(maxExclusive)
    },
    pick(items) {
      if (items.length === 0) throw new RangeError('cannot pick from an empty array')
      return items[rng.int(items.length)] as (typeof items)[number]
    },
    shuffle(items) {
      return shuffle(items, rng)
    },
  }
  return rng
}

/**
 * Production randomness. `crypto.randomInt` does rejection sampling, so it is
 * uniform, and it is a CSPRNG, so observing a hundred deals tells an attacker
 * nothing about the next one — which matters because the deal is the one piece
 * of hidden information worth predicting (07 §4).
 */
export function createSecureRng(): Rng {
  return fromIntSource((maxExclusive) => randomInt(maxExclusive))
}

/**
 * Deterministic randomness for tests, replay and seed-committed deals.
 *
 * xoshiro128** seeded by SHA-256 of the seed string: the hash decorrelates
 * similar seeds ('game-1' and 'game-2' must not produce related streams) and
 * gives the four non-zero 32-bit words the generator requires.
 */
export function createSeededRng(seed: string): Rng {
  let [s0, s1, s2, s3] = seedWords(seed)

  const next = (): number => {
    // xoshiro128** — 2^128 period, passes BigCrush, ~10 lines.
    const result = (Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0) >>> 0
    const t = (s1 << 9) >>> 0

    s2 = (s2 ^ s0) >>> 0
    s3 = (s3 ^ s1) >>> 0
    s1 = (s1 ^ s2) >>> 0
    s0 = (s0 ^ s3) >>> 0
    s2 = (s2 ^ t) >>> 0
    s3 = rotl(s3, 11)

    return result
  }

  return fromIntSource((maxExclusive) => {
    // Rejection sampling, same discipline as crypto.randomInt: draw from the
    // largest multiple of `maxExclusive` that fits in 32 bits and discard the
    // rest, so no residue class is favoured.
    const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive
    let draw = next()
    while (draw >= limit) draw = next()
    return draw % maxExclusive
  })
}

function rotl(x: number, k: number): number {
  return (((x << k) | (x >>> (32 - k))) >>> 0) >>> 0
}

function seedWords(seed: string): [number, number, number, number] {
  const digest = createHash('sha256').update(seed).digest()
  const words: [number, number, number, number] = [
    digest.readUInt32LE(0),
    digest.readUInt32LE(4),
    digest.readUInt32LE(8),
    digest.readUInt32LE(12),
  ]
  // xoshiro is degenerate from an all-zero state. Astronomically unlikely from
  // a SHA-256 digest, but a one-line guard beats a silent constant stream.
  if (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0) {
    words[0] = 0x9e37_79b9
  }
  return words
}

/**
 * The public half of the provable-shuffle commitment (05 §3, 07 §4): published
 * before the deal, verifiable against the seed published after it.
 */
export function commitSeed(seed: string, gameId: string): string {
  return createHash('sha256')
    .update(seed + gameId)
    .digest('hex')
}

/**
 * A hex seed drawn from an {@link Rng} — 32 bytes by default, matching 04 §7's
 * `crypto.randomBytes(32).hex()`.
 *
 * Drawn through the `Rng` port rather than calling `randomBytes` directly so the
 * whole of `createInstance` is exercisable with `createSeededRng`, and so the
 * one production source of entropy stays `createSecureRng`. A test that wants a
 * predictable seed hands in a seeded generator; production hands in the CSPRNG
 * and gets 256 bits either way.
 */
export function generateSeed(rng: Rng, bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new RangeError(`bytes must be a positive integer, got ${String(bytes)}`)
  }
  let hex = ''
  for (let index = 0; index < bytes; index += 1) {
    hex += rng.int(256).toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * ★ The per-transition generator — the thing that makes snapshots and replay
 * agree.
 *
 * A single `Rng` shared across a whole game would be correct only as long as
 * every rebuild replayed from event 0: the stream's position is a function of
 * how many draws happened before, and a snapshot at `seq 25` records the
 * *state* but not that position. Rebuilding from it and replaying events 26
 * onward would then deal different cards than the live game did — a bug that
 * stays invisible until the first game long enough to snapshot.
 *
 * So randomness is keyed by the log instead: every state transition gets a
 * fresh generator seeded `{rngSeed}:{seq}`, where `seq` is the sequence number
 * of the **input event** that caused it. That number is assigned by the
 * database, is recorded in the log, and is identical on every replay — which
 * makes a transition reproducible from `(rngSeed, seq)` alone, with or without
 * a snapshot in front of it.
 *
 * ★ It is deliberately **not** keyed by `clientMoveId`. That value is chosen by
 * the client, and keying randomness on it would let a player who does not like
 * the card they are about to draw retry the same move under a different id
 * until the deck obliges (07 §4). `seq` is ours.
 */
export function gameRng(rngSeed: string, key: number | string): Rng {
  return createSeededRng(`${rngSeed}:${key}`)
}

/** The generator that deals. Keyed so it can never collide with a transition. */
export const DEAL_RNG_KEY = 'deal'
