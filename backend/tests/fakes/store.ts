import { NotFoundError } from '../../src/domain/errors/errors.js'

/**
 * Shared plumbing for the in-memory repositories.
 *
 * The fakes exist so services and engines can be tested with no database. They
 * earn that role only by behaving *identically* to the Prisma repositories,
 * which is why they and the real thing are held to one shared contract suite
 * (`tests/unit/repositories/contract/`) rather than to their own expectations.
 *
 * Two behaviours copied deliberately from Prisma:
 *   - `update`/`delete` on a missing id **throw** (Prisma raises P2025), rather
 *     than silently no-op'ing.
 *   - Every read returns a fresh object, so a caller mutating a result cannot
 *     corrupt the store behind its back.
 */
let counter = 0

export function nextId(prefix = 'id'): string {
  counter += 1
  return `${prefix}_${String(counter).padStart(6, '0')}`
}

export function resetIds(): void {
  counter = 0
}

/** A shallow clone. Entities are flat by construction, so this is a deep copy. */
export function clone<T>(row: T): T {
  return { ...row }
}

export function cloneAll<T>(rows: readonly T[]): T[] {
  return rows.map(clone)
}

export class Collection<T extends { id: string }> {
  private readonly rows = new Map<string, T>()

  constructor(private readonly label: string) {}

  insert(row: T): T {
    this.rows.set(row.id, row)
    return clone(row)
  }

  get(id: string): T | null {
    const row = this.rows.get(id)
    return row ? clone(row) : null
  }

  /** The raw stored object. Internal use only — never handed to a caller. */
  peek(id: string): T | undefined {
    return this.rows.get(id)
  }

  require(id: string): T {
    const row = this.rows.get(id)
    if (!row) throw new NotFoundError(this.label, { id })
    return row
  }

  patch(id: string, data: Partial<T>): T {
    const row = this.require(id)
    // `undefined` means "not supplied", matching Prisma's update semantics —
    // otherwise every optional field in a patch would blank its column.
    const next = { ...row }
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) (next as Record<string, unknown>)[key] = value
    }
    this.rows.set(id, next)
    return clone(next)
  }

  remove(id: string): void {
    if (!this.rows.delete(id)) throw new NotFoundError(this.label, { id })
  }

  all(): T[] {
    return [...this.rows.values()]
  }

  find(predicate: (row: T) => boolean): T | null {
    const row = this.all().find(predicate)
    return row ? clone(row) : null
  }

  filter(predicate: (row: T) => boolean): T[] {
    return cloneAll(this.all().filter(predicate))
  }

  clear(): void {
    this.rows.clear()
  }
}

/** Newest-first paging by `createdAt`, tie-broken by id so it is total. */
export function paginate<T extends { id: string; createdAt: Date }>(
  rows: readonly T[],
  page: { limit?: number; before?: string } = {},
): T[] {
  const sorted = [...rows].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
  )
  let start = 0
  if (page.before !== undefined) {
    const cursor = sorted.findIndex((r) => r.id === page.before)
    if (cursor === -1) return [] // an unknown cursor yields nothing, never page 1
    start = cursor + 1
  }
  return cloneAll(sorted.slice(start, start + (page.limit ?? 25)))
}
