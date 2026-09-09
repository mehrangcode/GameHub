import { inMemoryHarness, type RepoHarness } from './harness.js'
import { prismaHarness } from './prisma-harness.js'

/**
 * Every implementation of `Repositories` the contract suite must satisfy.
 *
 * S09 pointed the suite at the database by appending **one entry here** — zero
 * assertions edited, which was the whole design goal of S08. Adding an
 * implementation later (a caching decorator, say) means adding a line and
 * inheriting the entire suite for free.
 */
export const REPO_HARNESSES: readonly RepoHarness[] = [inMemoryHarness(), prismaHarness()]

export type { RepoHarness }
