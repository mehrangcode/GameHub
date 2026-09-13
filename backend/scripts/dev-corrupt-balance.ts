/**
 * `dev-corrupt-balance.ts` — break invariant E1 on purpose, so you can watch it
 * be caught.
 *
 * This is the **only** file in the repository that writes `Wallet.balance`
 * without appending a ledger row, and it does it with a raw Prisma call rather
 * than through any repository — because no repository has a method for it. That
 * is not an oversight: `IWalletRepository` exposes `append` and nothing else
 * precisely so that E1 is a shape nobody can express rather than a rule
 * somebody must remember (the Phase B decision, S08).
 *
 * So this script has to reach past the whole architecture to do its job, which
 * is exactly the right amount of difficulty. If it ever becomes possible to
 * write this through a service, something has gone wrong upstairs.
 *
 * ```bash
 * npx tsx scripts/dev-corrupt-balance.ts --email me@test.dev --set 999999
 * npx tsx scripts/dev-reconcile.ts        # → ALERT + a LEDGER_DRIFT row
 * npx tsx scripts/dev-corrupt-balance.ts --email me@test.dev --repair
 * ```
 *
 * **Dev only**, and it refuses to run under `NODE_ENV=production`.
 */
import { buildContainer } from '../src/container.js'
import { ASSET_CODES, type AssetCode } from '../src/contracts/enums.js'

interface Args {
  readonly email?: string
  readonly user?: string
  readonly guest?: string
  readonly walletId?: string
  readonly asset: AssetCode
  readonly set?: number
  readonly repair: boolean
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === undefined || !flag.startsWith('--')) continue
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      flags.set(flag.slice(2), 'true')
    } else {
      flags.set(flag.slice(2), next)
      i += 1
    }
  }

  const asset = (flags.get('asset') ?? 'COIN') as AssetCode
  if (!ASSET_CODES.includes(asset)) fail(`--asset must be one of ${ASSET_CODES.join(' | ')}`)

  return {
    ...(flags.has('email') ? { email: flags.get('email') } : {}),
    ...(flags.has('user') ? { user: flags.get('user') } : {}),
    ...(flags.has('guest') ? { guest: flags.get('guest') } : {}),
    ...(flags.has('wallet') ? { walletId: flags.get('wallet') } : {}),
    ...(flags.has('set') ? { set: Number(flags.get('set')) } : {}),
    asset,
    repair: flags.get('repair') === 'true',
  }
}

function fail(message: string): never {
  console.error(`\n${message}\n`)
  process.exit(1)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const container = buildContainer()

  if (container.env.NODE_ENV === 'production') {
    fail('dev-corrupt-balance refuses to run in production. Obviously.')
  }

  const walletId = await resolveWalletId(container, args)
  const before = await container.repos.wallets.findById(walletId)
  if (before === null) fail(`no wallet ${walletId}`)

  const computed = await container.repos.wallets.sumTransactions(walletId)

  if (args.repair) {
    await container.prisma.wallet.update({ where: { id: walletId }, data: { balance: computed } })
    console.log(`\n  repaired wallet ${walletId}: balance ${before.balance} → ${computed}\n`)
    await container.shutdown()
    return
  }

  if (args.set === undefined || !Number.isInteger(args.set)) {
    fail('pass --set <integer> to corrupt a balance, or --repair to put it back')
  }

  // ★ The one raw write. Note what is deliberately NOT happening: no ledger row,
  // no `append`, no transaction pairing the two. That is the bug being
  // simulated, and the reconciliation job exists to notice it.
  await container.prisma.wallet.update({ where: { id: walletId }, data: { balance: args.set } })

  console.log(
    `\n  wallet ${walletId} [${args.asset}]\n` +
      `    cached balance   ${before.balance} → ${args.set}   (written WITHOUT a ledger row)\n` +
      `    ledger sum       ${computed}   (unchanged — this is the truth)\n\n` +
      '  now run:  npx tsx scripts/dev-reconcile.ts\n',
  )
  await container.shutdown()
}

async function resolveWalletId(
  container: Awaited<ReturnType<typeof buildContainer>>,
  args: Args,
): Promise<string> {
  if (args.walletId !== undefined) return args.walletId

  if (args.email !== undefined) {
    const user = await container.repos.users.findByEmail(args.email)
    if (user === null) fail(`no user with email ${args.email}`)
    const wallet = await container.repos.wallets.findByHolder(
      { kind: 'user', userId: user.id },
      args.asset,
    )
    if (wallet === null) fail(`user ${args.email} has no ${args.asset} wallet`)
    return wallet.id
  }

  const holder =
    args.user !== undefined
      ? ({ kind: 'user', userId: args.user } as const)
      : args.guest !== undefined
        ? ({ kind: 'guest', guestSessionId: args.guest } as const)
        : fail('pass one of --email, --user, --guest or --wallet')

  const wallet = await container.repos.wallets.findByHolder(holder, args.asset)
  if (wallet === null) fail(`no ${args.asset} wallet for that holder`)
  return wallet.id
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
