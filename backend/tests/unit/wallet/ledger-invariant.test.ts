import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { userRef } from '../../../src/domain/value-objects/identity.js'
import { buildInMemoryRepositories, type InMemoryRepositories } from '../../fakes/index.js'

/**
 * ★ E1, enforced rather than trusted — S21's structural test.
 *
 * The invariant: **`Wallet.balance` is written only inside the transaction that
 * appends the corresponding ledger row.** 10 §2.4's pseudocode expresses this
 * as `append` followed by `bumpCachedBalance`, and the build plan asks for "a
 * test asserting no code path calls `bumpCachedBalance` without appending a
 * row".
 *
 * This codebase answers that a step earlier: **there is no
 * `bumpCachedBalance`.** `IWalletRepository.append` writes the row and the
 * cached column together or not at all, and the interface exposes no other
 * mutation — so the invariant is not a rule someone has to remember, it is a
 * shape they cannot express. That is a stronger guarantee than a test on the
 * call site, and it needs a different test: one that fails if somebody adds the
 * missing setter back.
 *
 * Three checks, in increasing order of paranoia:
 *
 *   1. the *interface* declares no balance setter;
 *   2. every method other than `append` provably leaves the balance alone;
 *   3. no source file writes a wallet's `balance` outside `append`.
 *
 * A source scan is a blunt instrument and it is the right one here: the failure
 * mode being guarded against is a *new* code path, so no behavioural test on
 * today's paths can see it coming.
 */

const SRC = fileURLToPath(new URL('../../../src/', import.meta.url))

const read = (relative: string) => readFile(`${SRC}${relative}`, 'utf8')

/** Names of the setter this design deliberately does not have. */
const FORBIDDEN_SETTERS = [
  'bumpCachedBalance',
  'setBalance',
  'updateBalance',
  'incrementBalance',
  'adjustBalance',
  'addToBalance',
  'creditBalance',
]

describe('E1 — the cached balance has exactly one writer', () => {
  it('★ IWalletRepository declares no way to set a balance', async () => {
    const source = await read('domain/repositories/economy.ts')

    for (const setter of FORBIDDEN_SETTERS) {
      // If this fails, read the docblock above before "fixing" it: adding the
      // setter turns E1 back into a convention, and conventions get forgotten
      // in the one code path that matters.
      expect(source).not.toContain(setter)
    }
  })

  it('★ the repository writes Wallet.balance in append() and nowhere else', async () => {
    // Only the repository layer can persist a balance at all, so this is the
    // whole surface. A service could not write one if it wanted to — which is
    // the point of the previous test.
    const file = 'infrastructure/prisma/repositories/economy.ts'
    const source = await read(file)
    const writers: Array<{ line: number; method: string | null }> = []

    for (const [index, line] of source.split('\n').entries()) {
      if (/^\s*balance:/.test(line)) {
        writers.push({ line: index + 1, method: enclosingMethod(source, index) })
      }
    }

    expect(
      writers.length,
      `${file} has no balance write at all — did append() change?`,
    ).toBeGreaterThan(0)
    for (const writer of writers) {
      expect(writer.method, `${file}:${writer.line} writes balance outside append()`).toBe('append')
    }
  })

  it('no service reaches for a balance setter that does not exist', async () => {
    for (const file of [
      'application/services/WalletService.ts',
      'application/services/GuestClaimService.ts',
    ]) {
      const source = await read(file)
      for (const setter of FORBIDDEN_SETTERS) {
        expect(source, `${file} calls ${setter}`).not.toContain(setter)
      }
    }
  })

  it('the Prisma repository touches the wallet row in only two methods', async () => {
    const source = await read('infrastructure/prisma/repositories/economy.ts')
    const writers = new Set<string>()

    for (const [index, line] of source.split('\n').entries()) {
      if (/\bwallet\.(update|updateMany|upsert)\b/.test(line)) {
        writers.add(enclosingMethod(source, index) ?? '(unknown)')
      }
    }

    // `append` writes the balance; `markVested` flips a guest wallet's status
    // on claim and must never touch the number.
    expect([...writers].sort()).toEqual(['append', 'markVested'])
  })
})

describe('E1 — behaviourally, on the in-memory repository', () => {
  let repos: InMemoryRepositories

  beforeEach(() => {
    repos = buildInMemoryRepositories()
  })

  it('★ every method except append leaves the balance untouched', async () => {
    const user = await repos.users.create({
      email: 'ledger@test.dev',
      passwordHash: 'argon2id$x',
      displayName: 'Player',
    })
    const holder = userRef(user.id)
    const wallet = await repos.wallets.ensure(holder, 'COIN')
    await repos.wallets.append({
      walletId: wallet.id,
      amount: 120,
      kind: 'MATCH_REWARD',
      idempotencyKey: 'k',
    })

    // Everything the interface offers that is not `append`.
    await repos.wallets.findById(wallet.id)
    await repos.wallets.findByHolder(holder, 'COIN')
    await repos.wallets.ensure(holder, 'COIN')
    await repos.wallets.findTransactionByKey(wallet.id, 'k')
    await repos.wallets.listTransactions(wallet.id)
    await repos.wallets.sumTransactions(wallet.id)
    await repos.wallets.sumCreditsSince(wallet.id, new Date(0), ['MATCH_REWARD'])
    await repos.wallets.countCreditsSince(wallet.id, new Date(0), ['MATCH_REWARD'])
    await repos.wallets.markVested(wallet.id)

    const after = await repos.wallets.findById(wallet.id)
    expect(after?.balance).toBe(120)
    expect(await repos.wallets.sumTransactions(wallet.id)).toBe(120)
    // markVested did its own job, and only its own job.
    expect(after?.status).toBe('VESTED')
  })

  it('★ a balance move always leaves a row behind — the two are one write', async () => {
    const user = await repos.users.create({
      email: 'pair@test.dev',
      passwordHash: 'argon2id$x',
      displayName: 'Player',
    })
    const wallet = await repos.wallets.ensure(userRef(user.id), 'COIN')

    for (const [i, amount] of [10, -4, 0, 25].entries()) {
      await repos.wallets.append({
        walletId: wallet.id,
        amount,
        kind: amount < 0 ? 'PURCHASE' : 'MATCH_REWARD',
        idempotencyKey: `k${i}`,
      })
      // Checked after *every* append, not just at the end: a path that wrote
      // the balance twice for one row would net out at the end and be invisible.
      const current = await repos.wallets.findById(wallet.id)
      expect(current?.balance).toBe(await repos.wallets.sumTransactions(wallet.id))
    }
  })
})

/**
 * The name of the `async foo(` / `private async foo(` declaration above `line`.
 *
 * Crude, and adequate: the repositories are flat classes of single-level
 * methods, and a nested function that wrote a balance would still report the
 * enclosing method — which is the thing being allowlisted.
 */
function enclosingMethod(source: string, line: number): string | null {
  const lines = source.split('\n')
  for (let i = line; i >= 0; i -= 1) {
    const match =
      /^\s{2}(?:private\s+|protected\s+|public\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(
        lines[i] ?? '',
      )
    if (match) return match[1] ?? null
  }
  return null
}
