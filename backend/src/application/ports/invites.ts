/**
 * Invite code generation, as a port — S19.
 *
 * `application/` may not import `infrastructure/` (guard 1), and generating a
 * code needs `crypto.randomInt`. So the capability arrives as an interface and
 * `infrastructure/invites/inviteCode.ts` supplies it.
 *
 * The seam pays for itself immediately: a test hands in a generator that
 * returns the *same* code twice and proves `InviteService.mint` survives a
 * collision, which is not something you can arrange with real randomness.
 */
export interface IInviteCodeGenerator {
  /** A fresh, URL-safe code. Uniqueness is the database's job, not this one's. */
  next(): string
}
