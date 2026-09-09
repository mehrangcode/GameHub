/**
 * `dev-credit.ts` — put coins in a wallet so a journey can be walked by hand.
 *
 * S22's verification is *"provisional 120 before, vested 120 after"*, and until
 * S36 settles a real match there is no way to earn a coin. Rather than teach
 * anyone to `INSERT` into `WalletTransaction` — which is how a cached balance
 * and its ledger drift apart, the exact failure E1 exists to prevent — this
 * goes through `WalletService.credit`. Everything the real reward path does
 * happens here: the derived key, the caps, the `balanceAfter`, the audit row.
 *
 * ```bash
 * # a guest, identified by the cookie jar you already have
 * npx tsx scripts/dev-credit.ts --guest-cookie /tmp/g.txt --amount 120
 *
 * # or by id, whichever you have to hand
 * npx tsx scripts/dev-credit.ts --guest <guestSessionId> --amount 120
 * npx tsx scripts/dev-credit.ts --user <userId> --amount 500
 * npx tsx scripts/dev-credit.ts --email sara@test.dev --amount 500
 *
 * # read a balance without moving it
 * npx tsx scripts/dev-credit.ts --email sara@test.dev --show
 * ```
 *
 * **Dev only.** It refuses to run with `NODE_ENV=production`: a script that
 * mints currency from a shell has no business existing on a machine with real
 * players on it, and `ADMIN_ADJUST` from the audited console (12 §7.2) is the
 * production answer.
 */
import { readFileSync } from 'node:fs'
import { buildContainer } from '../src/container.js'
import { ASSET_CODES, type AssetCode } from '../src/contracts/enums.js'
import { adminAdjustKey } from '../src/domain/economy/idempotency.js'
import { guestRef, userRef, type IdentityRef } from '../src/domain/value-objects/identity.js'

interface Args {
  readonly user?: string
  readonly email?: string
  readonly guest?: string
  readonly guestCookie?: string
  readonly amount: number
  readonly asset: AssetCode
  readonly reason: string
  readonly show: boolean
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
  if (!ASSET_CODES.includes(asset)) {
    fail(`--asset must be one of ${ASSET_CODES.join(' | ')}`)
  }

  return {
    ...(flags.has('user') ? { user: flags.get('user') } : {}),
    ...(flags.has('email') ? { email: flags.get('email') } : {}),
    ...(flags.has('guest') ? { guest: flags.get('guest') } : {}),
    ...(flags.has('guest-cookie') ? { guestCookie: flags.get('guest-cookie') } : {}),
    amount: Number(flags.get('amount') ?? '0'),
    asset,
    reason: flags.get('reason') ?? 'dev-credit',
    show: flags.get('show') === 'true',
  }
}

function fail(message: string): never {
  console.error(`\n${message}\n`)
  process.exit(1)
}

/**
 * Pulls the `guest` cookie out of a curl jar.
 *
 * Netscape cookie-file format: tab-separated, the value in the last field.
 * Accepting the jar directly is the point — the build plan's verify steps
 * already have `/tmp/g.txt` in hand, and asking for a guest session id instead
 * would mean a detour through Studio in the middle of a two-minute check.
 */
function guestTokenFromJar(path: string): string {
  const line = readFileSync(path, 'utf8')
    .split('\n')
    .find((row) => /\bguest\b/.test(row) && !row.startsWith('#'))
  if (!line) fail(`no "guest" cookie in ${path} — did POST /auth/guest succeed?`)

  const token = line.trim().split(/\s+/).pop()
  if (!token) fail(`could not read the guest cookie value out of ${path}`)
  return token
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const container = buildContainer()

  if (container.env.NODE_ENV === 'production') {
    fail('dev-credit refuses to run in production. Use the admin console (12 §7.2).')
  }

  const holder = await resolveHolder(container, args)
  const label = holder.kind === 'user' ? `user:${holder.userId}` : `guest:${holder.guestSessionId}`

  if (!args.show) {
    if (!Number.isInteger(args.amount) || args.amount <= 0) {
      fail('--amount must be a positive whole number (or pass --show to read a balance)')
    }

    const result = await container.wallets.credit({
      holder,
      asset: args.asset,
      amount: args.amount,
      // `ADMIN_ADJUST` is cap-exempt, deliberately: this script exists to set
      // up a scenario, and a cap silently eating the setup would look like the
      // script is broken. A `MATCH_REWARD` here would be capped like any other.
      kind: 'ADMIN_ADJUST',
      idempotencyKey: adminAdjustKey(`dev-${Date.now()}`),
      reason: args.reason,
    })

    console.log(
      `\n${result.applied ? 'credited' : 'already credited'} ${result.credited} ${args.asset} to ${label}` +
        `${result.capCode ? ` (capped: ${result.capCode})` : ''}`,
    )
  }

  const assets = holder.kind === 'user' ? ASSET_CODES : (['COIN'] as const)
  console.log('')
  for (const balance of await container.wallets.balances(holder, assets)) {
    const status = balance.status === 'PROVISIONAL' ? 'PROVISIONAL (unspendable)' : 'VESTED'
    console.log(`  ${balance.asset.padEnd(7)} ${String(balance.balance).padStart(7)}  ${status}`)
  }

  console.log('\n  recent ledger rows (newest first):')
  for (const row of await container.wallets.statement(holder, args.asset, { limit: 8 })) {
    const sign = row.amount > 0 ? '+' : ''
    console.log(
      `  ${row.createdAt.toISOString()}  ${(sign + String(row.amount)).padStart(7)}  ` +
        `${row.kind.padEnd(13)} → ${String(row.balanceAfter).padStart(7)}  ${row.reason ?? ''}`,
    )
  }
  console.log('')

  await container.shutdown()
}

async function resolveHolder(
  container: ReturnType<typeof buildContainer>,
  args: Args,
): Promise<IdentityRef> {
  if (args.guestCookie !== undefined) {
    const session = await container.guests.resolve(guestTokenFromJar(args.guestCookie))
    if (!session) {
      fail('that guest cookie does not resolve — expired, already claimed, or a different database')
    }
    return guestRef(session.id)
  }
  if (args.guest !== undefined) {
    const session = await container.repos.guests.findById(args.guest)
    if (!session) fail(`no GuestSession ${args.guest}`)
    return guestRef(session.id)
  }
  if (args.email !== undefined) {
    const user = await container.repos.users.findByEmail(args.email.toLowerCase())
    if (!user) fail(`no User with email ${args.email}`)
    return userRef(user.id)
  }
  if (args.user !== undefined) {
    const user = await container.repos.users.findById(args.user)
    if (!user) fail(`no User ${args.user}`)
    return userRef(user.id)
  }

  fail('name a holder: --user <id> | --email <address> | --guest <id> | --guest-cookie <jar>')
}

await main()
