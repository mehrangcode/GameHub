/**
 * 02-technical-prd.md §5.2 — the repository contract, owned by the domain.
 *
 * These are interfaces, not classes. `domain/` and `application/` depend on
 * them; `infrastructure/prisma/repositories/` implements them. The arrow points
 * inward, which is what lets a game engine and a service be unit-tested with no
 * database at all — and it is enforced by ESLint guard 1, not by discipline.
 *
 * Every interface below is exercised by one shared contract suite
 * (`tests/unit/repositories/contract/`) that runs against **both** the
 * in-memory fake and the Prisma implementation. Writing the assertions once and
 * running them twice is the only thing that makes the fakes trustworthy: a fake
 * that quietly behaves differently from the real repository is worse than no
 * fake at all.
 */
export interface IRepository<T, ID = string> {
  findById(id: ID): Promise<T | null>
  update(id: ID, data: Partial<T>): Promise<T>
  delete(id: ID): Promise<void>
}

/**
 * Creation input for an entity: the database owns `id` and the timestamps, and
 * every column with a schema default is optional here so a caller supplies only
 * what it actually decided.
 */
export type Draft<T, Optional extends keyof T = never> = Omit<
  T,
  'id' | 'createdAt' | 'updatedAt' | Optional
> &
  Partial<Pick<T, Optional>>

/** Cursor pagination — `before` is an id, matching the REST surface. */
export interface PageQuery {
  readonly limit?: number
  readonly before?: string
}
