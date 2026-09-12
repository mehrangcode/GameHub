import { createHash } from 'node:crypto'
import { prisma } from '../src/infrastructure/prisma/client.js'

/**
 * `dev-verify-commit.ts` — S28's verification step, by hand.
 *
 * ```bash
 * npx tsx scripts/dev-verify-commit.ts --game <gameId>
 * npx tsx scripts/dev-verify-commit.ts --table <tableId>   # the active game there
 * npx tsx scripts/dev-verify-commit.ts --latest
 * ```
 *
 * It recomputes `sha256(rngSeed + gameId)` and compares it with the
 * `seedCommit` the server published *before* dealing. That is exactly the check
 * a player's browser performs on the match summary, and this is the operator's
 * copy of it — so a mismatch here is the single loudest possible signal that
 * something between the deal and the reveal is not what it claims to be.
 *
 * ### Why it prints the seed of a live game at all
 *
 * Because it reads the database, and anyone who can read the database can read
 * the seed. The rule the platform actually enforces is narrower and is the one
 * that matters: **the seed reaches no client before `finishedAt`**
 * (`tests/integration/event-log.test.ts` asserts it by serializing every
 * broadcast and searching for it). This script does mark a live game clearly,
 * because a screenshot of it in a chat window during a hand *would* be a leak.
 *
 * Refuses to run under `NODE_ENV=production`, like `dev-credit.ts`.
 */

if (process.env['NODE_ENV'] === 'production') {
  console.error('dev-verify-commit is a development tool and will not run in production')
  process.exit(1)
}

interface Options {
  gameId: string | null
  tableId: string | null
  latest: boolean
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { gameId: null, tableId: null, latest: false }

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]

    switch (flag) {
      case '--game':
        options.gameId = value ?? null
        index += 1
        break
      case '--table':
        options.tableId = value ?? null
        index += 1
        break
      case '--latest':
        options.latest = true
        break
      case '--help':
      case '-h':
        console.log(USAGE)
        process.exit(0)
        break
      default:
        if (flag?.startsWith('--')) {
          console.error(`unknown flag ${flag}`)
          console.log(USAGE)
          process.exit(1)
        }
    }
  }

  return options
}

const USAGE = `
dev-verify-commit — recompute a game's seed commitment yourself

  npx tsx scripts/dev-verify-commit.ts --game <gameId>
  npx tsx scripts/dev-verify-commit.ts --table <tableId>
  npx tsx scripts/dev-verify-commit.ts --latest
`

const useColour = process.stdout.isTTY === true
const ESC = String.fromCharCode(27)
const paint = (code: string, text: string) => (useColour ? `${ESC}[${code}m${text}${ESC}[0m` : text)
const bold = (text: string) => paint('1', text)
const dim = (text: string) => paint('2', text)
const red = (text: string) => paint('31', text)
const green = (text: string) => paint('32', text)
const yellow = (text: string) => paint('33', text)

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2))

  const game =
    options.gameId !== null
      ? await prisma.gameInstance.findUnique({ where: { id: options.gameId } })
      : options.tableId !== null
        ? await prisma.gameInstance.findFirst({
            where: { tableId: options.tableId },
            orderBy: { startedAt: 'desc' },
          })
        : options.latest
          ? await prisma.gameInstance.findFirst({ orderBy: { startedAt: 'desc' } })
          : null

  if (game === null) {
    console.error(red('no game found — pass --game, --table, or --latest'))
    console.log(USAGE)
    return 1
  }

  const recomputed = createHash('sha256')
    .update(game.rngSeed + game.id)
    .digest('hex')

  const live = game.finishedAt === null
  const events = await prisma.gameEvent.count({ where: { gameId: game.id } })

  console.log(`
${bold('game')}        ${game.id}
${bold('table')}       ${game.tableId}
${bold('slug')}        ${game.gameSlug}
${bold('status')}      ${game.status}${live ? yellow('  (LIVE — the seed below has NOT been published to anyone)') : ''}
${bold('events')}      ${String(events)}  ${dim(`instance.seq = ${String(game.seq)}`)}

${bold('published')}   ${game.seedCommit}   ${dim('← sent in game:started, before the deal')}
${bold('recomputed')}  ${recomputed}   ${dim('← sha256(rngSeed + gameId), computed just now')}

${bold('seed')}        ${game.rngSeed}
${bold('revealed')}    ${game.seedRevealedAt === null ? dim('not yet') : game.seedRevealedAt.toISOString()}
`)

  if (game.seedCommit === recomputed) {
    console.log(
      green('✓ the commitment matches — the deal could not have been chosen after the fact'),
    )
    return 0
  }

  console.log(red('✗ MISMATCH — the stored seed does not produce the published commitment'))
  console.log(red('  Do not shrug this off: it means the seed changed after it was committed.'))
  return 2
}

main()
  .then(async (code) => {
    await prisma.$disconnect()
    process.exit(code)
  })
  .catch(async (error: unknown) => {
    console.error(red(error instanceof Error ? error.message : String(error)))
    await prisma.$disconnect()
    process.exit(1)
  })
