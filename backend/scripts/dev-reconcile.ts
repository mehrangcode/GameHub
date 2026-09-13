/**
 * `dev-reconcile.ts` — run the ledger reconciliation by hand and read the result.
 *
 * This is the visible half of the M0 exit criterion *"a corrupted balance is
 * **detectable**"*. The job itself (`ReconciliationService`) is an ordinary
 * service with unit and integration coverage; this is how you watch it catch
 * something, which is a different and more convincing thing than reading a
 * green test name.
 *
 * ```bash
 * # corrupt one balance behind the ledger's back, then catch it
 * npx tsx scripts/dev-corrupt-balance.ts --email me@test.dev --set 999999
 * npx tsx scripts/dev-reconcile.ts
 * #   → ALERT: wallet <id> cached 999999, computed <real>
 * #   and a LEDGER_DRIFT row in SecurityEvent — check it in `npm run db:studio`
 *
 * # put it back
 * npx tsx scripts/dev-corrupt-balance.ts --email me@test.dev --repair
 * ```
 *
 * **In production this is a cron entry, not a shell habit.** There is no
 * scheduler in this process on purpose: two API instances running an in-process
 * timer would both reconcile every wallet and both alert on the same drift.
 *
 * Exits **1** when drift is found, so a scheduler can page on it directly
 * without parsing the output.
 */
import { buildContainer } from '../src/container.js'

async function main(): Promise<void> {
  const container = buildContainer()
  const report = await container.reconciliation.run()

  console.log('')
  console.log(`  scanned ${report.scanned} wallet(s) in ${duration(report)}`)

  if (report.drifted.length === 0) {
    console.log('  ✓ every cached balance agrees with its ledger (E1)\n')
    await container.shutdown()
    return
  }

  console.log(`  ✗ ${report.drifted.length} wallet(s) disagree with their ledger:\n`)
  for (const drift of report.drifted) {
    const holder = drift.userId ?? drift.guestSessionId ?? '(orphan)'
    console.log(
      `    ALERT: wallet ${drift.walletId} [${drift.asset}] holder ${holder}\n` +
        `           cached ${drift.cached}, computed ${drift.computed}, drift ${signed(drift.drift)}`,
    )
  }

  console.log(
    '\n  The ledger is the truth (E1). Nothing was repaired — the question worth\n' +
      '  answering is which write path produced the cached number, and a silent\n' +
      '  self-heal would have erased the evidence.\n' +
      '  A LEDGER_DRIFT SecurityEvent was written for each row above.\n',
  )

  await container.shutdown()
  process.exit(1)
}

function duration(report: { startedAt: Date; finishedAt: Date }): string {
  return `${String(report.finishedAt.getTime() - report.startedAt.getTime())} ms`
}

function signed(value: number): string {
  return value > 0 ? `+${String(value)}` : String(value)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
