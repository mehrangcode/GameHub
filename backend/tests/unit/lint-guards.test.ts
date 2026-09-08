import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * S01's single most important outcome: the three architecture guards actually
 * reject a deliberate violation. Asserting the config merely *contains* the
 * rules would pass even if the `files` globs stopped matching — so each case
 * below lints real source text at a real path and expects a real error.
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
})
