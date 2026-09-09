import { randomInt } from 'node:crypto'
import type { IInviteCodeGenerator } from '../../application/ports/invites.js'

/**
 * Invite codes — 11-build-plan.md S19: "short URL-safe code (~8 chars,
 * unambiguous alphabet)".
 *
 * The alphabet is Crockford-flavoured: upper case only, with **`I L O U 0 1`
 * removed**. Every one of those is a code read aloud over a voice call or
 * copied off a phone screen and typed wrong — `SEEDDEM0` versus `SEEDDEMO` is
 * a support conversation, and an invite link that fails once is a friend who
 * does not join.
 *
 * 30 symbols over 8 positions is ≈ 6.6 × 10¹¹ codes. Combined with a short
 * expiry and the rate limit on resolution, guessing a live one is not a
 * practical attack — and the code is only ever a *join* capability, never an
 * identity: `POST /auth/guest` still mints a table-bound token of its own
 * (07 §5.2).
 *
 * `U` was present here until a Postman run minted `WRQ6UUR6` and the assertion
 * that no code contains `[ILOU01]` failed. Removing it costs 0.3 bits per
 * character and is backward-compatible: lookup is by exact string, so codes
 * already minted with a `U` keep working.
 */
export const INVITE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
export const INVITE_CODE_LENGTH = 8

export class RandomInviteCodeGenerator implements IInviteCodeGenerator {
  constructor(
    private readonly length = INVITE_CODE_LENGTH,
    private readonly alphabet = INVITE_ALPHABET,
  ) {}

  next(): string {
    let code = ''
    for (let i = 0; i < this.length; i += 1) {
      // `crypto.randomInt` rejection-samples, so no symbol is more likely than
      // another — the same reason the shuffle uses it (05 §3).
      code += this.alphabet[randomInt(this.alphabet.length)]
    }
    return code
  }
}
