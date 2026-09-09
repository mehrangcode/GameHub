/**
 * Domain entities — plain, immutable, typed shapes.
 *
 * These are **not** Prisma types, and that is the entire point. If services
 * spoke `Prisma.User`, the ESLint boundary between `domain/` and
 * `infrastructure/` would be decorative: the layer would still be coupled to
 * the ORM, just through the type system instead of an import. Mapping happens
 * once, in `infrastructure/prisma/mappers.ts`, and nowhere else.
 *
 * Two consequences of owning the shapes:
 *
 *   - **JSON columns are parsed here.** The schema stores `optionsJson: String`
 *     (03 §1 rule 3, because SQLite cannot query into JSON); the domain sees
 *     `options: Record<string, unknown>`. No `JSON.parse` in a service, ever.
 *   - **Enumerated columns are unions**, imported from `contracts/`, so the
 *     same vocabulary the client validates against is the one the domain uses.
 */
export type * from './user.js'
export type * from './table.js'
export type * from './game.js'
export type * from './economy.js'
