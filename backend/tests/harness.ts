import type { Repositories } from '../src/domain/repositories/Repositories.js'
import { buildInMemoryRepositories, resetIds } from './fakes/index.js'

/**
 * ★ The seam that makes the fakes trustworthy.
 *
 * One contract suite (`tests/unit/repositories/contract/`) runs against every
 * harness listed here. S08 registered the in-memory one; S09 added Prisma
 * **without touching a single assertion** — which is the only way to know the
 * fake and the real repository agree. If they ever diverge, the same test name
 * fails under one harness and passes under the other, and the diff is the bug.
 *
 * A harness must give the suite a clean database for every test, so the
 * assertions can be written as if nothing else exists.
 */
export interface RepoHarness {
  readonly name: string
  /** Empty every store. Called in `beforeEach`. */
  reset(): Promise<void>
  repos(): Repositories
  /** Closed once, after the whole suite. */
  dispose(): Promise<void>
}

export function inMemoryHarness(): RepoHarness {
  let repos = buildInMemoryRepositories()
  return {
    name: 'in-memory',
    async reset() {
      resetIds()
      repos = buildInMemoryRepositories()
    },
    repos: () => repos,
    async dispose() {
      /* nothing to close */
    },
  }
}
