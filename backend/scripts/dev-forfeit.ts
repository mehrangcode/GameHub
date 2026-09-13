/**
 * `dev-forfeit.ts` — expire unclaimed guest balances by hand (10 §3.4).
 *
 * A guest session lives 12 hours. One that expires without being claimed still
 * has a `PROVISIONAL` balance, and that balance has to stop existing — **as a
 * ledger row**, never as an `UPDATE` that sets a column to zero. Watching that
 * happen is worth one command:
 *
 * ```bash
 * npx tsx scripts/dev-forfeit.ts
 * npm run db:studio
 * #   WalletTransaction: a GUEST_FORFEIT row for −N, keyed forfeit:{guestId},
 * #   reasoned GUEST_EXPIRED. The wallet is at 0 and the ledger still sums to 0.
 * ```
 *
 * In production this is a cron entry, for the same reason `dev-reconcile.ts`
 * is: two instances running an in-process timer would both sweep.
 *
 * `--limit` bounds one pass; the default works a backlog through in batches.
 */
import { buildContainer } from '../src/container.js'

async function main(): Promise<void> {
  const raw = process.argv.indexOf('--limit')
  const limit = raw === -1 ? undefined : Number(process.argv[raw + 1])

  const container = buildContainer()
  const report = await container.guestForfeits.run(
    limit !== undefined && Number.isInteger(limit) && limit > 0 ? limit : undefined,
  )

  console.log('')
  console.log(`  scanned    ${report.scanned} expired unclaimed guest session(s)`)
  console.log(`  forfeited  ${report.forfeited} wallet(s), ${report.coins} COIN`)
  console.log(
    report.forfeited === 0
      ? '\n  nothing to do.\n'
      : '\n  Each one is a GUEST_FORFEIT ledger row, not a wiped column —\n' +
          '  balance == Σ transactions still holds for every wallet (E1).\n',
  )

  await container.shutdown()
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
