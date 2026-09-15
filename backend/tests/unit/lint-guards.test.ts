import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * S01's single most important outcome, extended by S48: the four architecture
 * guards actually reject a deliberate violation. Asserting the config merely
 * *contains* the rules would pass even if the `files` globs stopped matching —
 * so each case below lints real source text at a real path and expects a real
 * error.
 */
describe('architecture lint guards', () => {
  let eslint: ESLint

  beforeAll(() => {
    eslint = new ESLint({ cwd: process.cwd() })
  })

  async function lint(filePath: string, code: string) {
    const [result] = await eslint.lintText(code, { filePath, warnIgnored: false })
    return result?.messages ?? []
  }

  function ruleIds(messages: { ruleId?: string | null }[]) {
    return messages.map((m) => m.ruleId)
  }

  describe('guard 1 — the dependency direction (02 §5.1)', () => {
    it('rejects a Prisma import from domain/', async () => {
      const messages = await lint(
        'src/domain/_probe.ts',
        "import { PrismaClient } from '@prisma/client'\nexport const x: PrismaClient | null = null\n",
      )
      expect(ruleIds(messages)).toContain('no-restricted-imports')
    })

    it('rejects an infrastructure import from application/', async () => {
      const messages = await lint(
        'src/application/services/_probe.ts',
        "import { prisma } from '../../infrastructure/prisma/client.js'\nexport const x = prisma\n",
      )
      expect(ruleIds(messages)).toContain('no-restricted-imports')
    })

    it('allows the same import from infrastructure/ itself', async () => {
      const messages = await lint(
        'src/infrastructure/prisma/_probe.ts',
        "import { PrismaClient } from '@prisma/client'\nexport const x = new PrismaClient()\n",
      )
      expect(ruleIds(messages)).not.toContain('no-restricted-imports')
    })
  })

  describe('guard 2 — no ambient randomness in domain/ (05 §3)', () => {
    it('rejects Math.random() in an engine', async () => {
      const messages = await lint(
        'src/domain/games/_probe.ts',
        'export const x = Math.floor(Math.random() * 52)\n',
      )
      expect(ruleIds(messages)).toContain('no-restricted-syntax')
    })

    it('rejects Math.random() anywhere else in domain/', async () => {
      const messages = await lint('src/domain/_probe.ts', 'export const x = Math.random()\n')
      expect(ruleIds(messages)).toContain('no-restricted-syntax')
    })

    it('allows Math.random() outside domain/', async () => {
      const messages = await lint(
        'src/interface/http/_probe.ts',
        'export const x = Math.random()\n',
      )
      expect(ruleIds(messages)).not.toContain('no-restricted-syntax')
    })
  })

  describe('guard 3 — engines never see money (E5)', () => {
    it('rejects a wallet import from domain/games/', async () => {
      const messages = await lint(
        'src/domain/games/poker/_probe.ts',
        "import { WalletService } from '../../../application/services/walletService.js'\nexport const x = WalletService\n",
      )
      expect(ruleIds(messages)).toContain('no-restricted-imports')
    })

    it('rejects a matchmaking import from domain/games/', async () => {
      const messages = await lint(
        'src/domain/games/shelem/_probe.ts',
        "import { queue } from '../../../application/services/matchmakingService.js'\nexport const x = queue\n",
      )
      expect(ruleIds(messages)).toContain('no-restricted-imports')
    })

    it('still enforces guard 1 inside domain/games/', async () => {
      // The flat-config block for domain/games/** replaces the rule options
      // wholesale, so it has to restate the infrastructure ban. This is the
      // test that catches someone forgetting that.
      const messages = await lint(
        'src/domain/games/sudoku/_probe.ts',
        "import { PrismaClient } from '@prisma/client'\nexport const x: PrismaClient | null = null\n",
      )
      expect(ruleIds(messages)).toContain('no-restricted-imports')
    })

    it('allows importing the shared engine helpers', async () => {
      const messages = await lint(
        'src/domain/games/shelem/_probe.ts',
        "import type { Rng } from '../shared/rng.js'\nexport type X = Rng\n",
      )
      expect(ruleIds(messages)).not.toContain('no-restricted-imports')
    })
  })

  describe('guard 2b — no engine ever touches a clock (I1, S31)', () => {
    it('★ rejects an engine importing the turn timer service', async () => {
      // S31's "no engine file imports the timer service". The ban already
      // exists — `**/application/**` is in guard 3's pattern list — but it is
      // generic, and the *reason* this particular import must fail is specific
      // enough to be worth a named test: an engine that could reach a timer
      // could read a clock, and invariant I1 (pure and deterministic) would
      // stop being checkable. Turn limits are declared in `GameMeta` and
      // enforced in the session layer, in that order and no other.
      const messages = await lint(
        'src/domain/games/shelem/_probe.ts',
        "import { TurnTimerService } from '../../../application/services/TurnTimerService.js'\n" +
          'export type X = TurnTimerService\n',
      )
      expect(ruleIds(messages)).toContain('no-restricted-imports')
    })

    it('★ and no engine reads the wall clock directly either', async () => {
      const messages = await lint(
        'src/domain/games/shelem/_probe.ts',
        'export const now = Date.now()\n',
      )
      expect(ruleIds(messages)).toContain('no-restricted-syntax')
    })
  })

  describe('guard 4 — the admin console stays off the public port (12 §2.4, S48)', () => {
    it('★ rejects app.ts importing an admin router', async () => {
      // The realistic version of this mistake is not malice: it is someone
      // adding "just the audit read endpoint" to the app they already have
      // running, six months from now, with the console still unbuilt.
      const messages = await lint(
        'src/app.ts',
        "import { buildAdminHealthRouter } from './interface/admin/routes/health.routes.js'\n" +
          'export const x = buildAdminHealthRouter\n',
      )
      expect(ruleIds(messages)).toContain('no-restricted-imports')
    })

    it('★ rejects a public HTTP route importing admin middleware', async () => {
      const messages = await lint(
        'src/interface/http/routes/_probe.ts',
        "import { requireStepUp } from '../../admin/middleware/requireStepUp.js'\n" +
          'export const x = requireStepUp\n',
      )
      expect(ruleIds(messages)).toContain('no-restricted-imports')
    })

    it('★ rejects a socket handler importing the admin app', async () => {
      const messages = await lint(
        'src/interface/socket/handlers/_probe.ts',
        "import { buildAdminApp } from '../../../admin-app.js'\nexport const x = buildAdminApp\n",
      )
      expect(ruleIds(messages)).toContain('no-restricted-imports')
    })

    it('★ but the ban is one-directional — admin may import the shared middleware', async () => {
      // This is the assertion that stops guard 4 from being "fixed" into a
      // symmetric ban. The two apps MUST agree on what an error, a request id
      // and a validated body look like; duplicating that for the console gives
      // it its own error taxonomy within a month.
      const messages = await lint(
        'src/interface/admin/routes/_probe.ts',
        "import { asyncHandler } from '../../http/middleware/error.js'\nexport const x = asyncHandler\n",
      )
      expect(ruleIds(messages)).not.toContain('no-restricted-imports')
    })

    it('allows admin-main.ts to import the admin app — that is its whole job', async () => {
      const messages = await lint(
        'src/admin-main.ts',
        "import { buildAdminApp } from './admin-app.js'\nexport const x = buildAdminApp\n",
      )
      expect(ruleIds(messages)).not.toContain('no-restricted-imports')
    })
  })
})
