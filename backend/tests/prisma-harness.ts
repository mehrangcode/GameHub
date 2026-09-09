import { buildRepositories } from '../src/infrastructure/prisma/UnitOfWork.js'
import type { Repositories } from '../src/domain/repositories/Repositories.js'
import type { RepoHarness } from './harness.js'
import { db, resetDb } from './helpers/db.js'

/**
 * The second harness (S09). Same contract suite, real SQLite.
 *
 * It exists to answer one question: do the in-memory fakes lie? Every
 * assertion the fakes pass, the database must pass too — the seat race, the
 * ledger's idempotency key, the invite that expired, the retried move. Where
 * they disagree, the suite names the exact behaviour and the fake is wrong,
 * because the database is the thing production runs against.
 */
export function prismaHarness(): RepoHarness {
  const repos: Repositories = buildRepositories(db)
  return {
    name: 'prisma',
    async reset() {
      await resetDb()
    },
    repos: () => repos,
    async dispose() {
      // The client is shared across test files in a single fork; disconnecting
      // here would leave the next file to reconnect for nothing.
    },
  }
}
