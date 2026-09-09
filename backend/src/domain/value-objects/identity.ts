import type { BotDifficulty } from '../../contracts/enums.js'

/**
 * Who someone *is*, in the two forms the platform accepts.
 *
 * Persona P2 — play with no account — means a guest is a first-class actor, not
 * a degraded user. Every place that can be "a person" therefore carries this
 * union rather than a nullable `userId`, which is what stops the guest path
 * from being an afterthought that someone forgets to handle.
 */
export type IdentityRef =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'guest'; readonly guestSessionId: string }

/** A seat may also be held by a bot, which is nobody. */
export type OccupantRef = IdentityRef | { readonly kind: 'bot'; readonly difficulty: BotDifficulty }

export function userRef(userId: string): IdentityRef {
  return { kind: 'user', userId }
}

export function guestRef(guestSessionId: string): IdentityRef {
  return { kind: 'guest', guestSessionId }
}

export function botRef(difficulty: BotDifficulty = 'medium'): OccupantRef {
  return { kind: 'bot', difficulty }
}

export function isBot(ref: OccupantRef): ref is { kind: 'bot'; difficulty: BotDifficulty } {
  return ref.kind === 'bot'
}

export function isHuman(ref: OccupantRef): ref is IdentityRef {
  return ref.kind !== 'bot'
}

/**
 * The canonical string form of an identity: `user:<id>` / `guest:<id>`.
 *
 * Wallet ownership, rate-limit buckets, presence sets and — most importantly —
 * the **derived** idempotency keys of the ledger (10 §2, E2) are all keyed by
 * this. Deriving one string from the identity, in one function, is what makes
 * `MATCH_REWARD:<matchId>:<holderKey>` reproducible on a retry instead of
 * random, which is the whole basis of double-credit protection.
 */
export type HolderKey = `user:${string}` | `guest:${string}`

export function holderKey(ref: IdentityRef): HolderKey {
  return ref.kind === 'user' ? `user:${ref.userId}` : `guest:${ref.guestSessionId}`
}

export function parseHolderKey(key: string): IdentityRef {
  const separator = key.indexOf(':')
  const kind = key.slice(0, separator)
  const id = key.slice(separator + 1)

  if (id.length === 0) throw new TypeError(`malformed holder key: ${key}`)
  if (kind === 'user') return userRef(id)
  if (kind === 'guest') return guestRef(id)
  throw new TypeError(`malformed holder key: ${key}`)
}

/** Two identities are the same person only if kind *and* id match. */
export function sameIdentity(a: IdentityRef, b: IdentityRef): boolean {
  return holderKey(a) === holderKey(b)
}
