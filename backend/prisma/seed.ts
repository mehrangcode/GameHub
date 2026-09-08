/**
 * Idempotent seed — 03-data-model.md §7.
 *
 * Everything below is an `upsert` on a stable id, never a `create`, so running
 * it twice changes nothing. That property is tested, not assumed
 * (tests/integration/seed.test.ts).
 *
 * Catalog data (cosmetics, store, reward rules, achievements, the admin
 * account) is seeded in every environment. The demo tables and finished
 * matches are **dev only** — `NODE_ENV=production` seeds catalog and nothing
 * else.
 *
 * `RewardRule` is the economy's tuning surface. The numbers here come from
 * 10-economy-and-rewards.md §3.2–3.7 and are a starting guess by that
 * document's own admission — rebalancing is a row update, not a deploy.
 */
import { PrismaClient } from '@prisma/client'
import { getEnv } from '../src/config/env.js'
import { hashPassword } from '../src/infrastructure/auth/password.js'

const db = new PrismaClient()
const env = getEnv()
const isProduction = env.NODE_ENV === 'production'

// ═════════════════════════════════════════════════════════════════════════
// Cosmetics — 03 §3.6
// ═════════════════════════════════════════════════════════════════════════

interface CosmeticSeed {
  id: string
  category: string
  nameKey: string
  assetRef: string
  unlockKind?: string
  gameSlug?: string
  sortOrder?: number
}

const COSMETICS: CosmeticSeed[] = [
  // Card backs
  {
    id: 'back-classic',
    category: 'CARD_BACK',
    nameKey: 'cosmetics.back.classic',
    assetRef: 'backs/classic.svg',
  },
  {
    id: 'back-minimal',
    category: 'CARD_BACK',
    nameKey: 'cosmetics.back.minimal',
    assetRef: 'backs/minimal.svg',
    unlockKind: 'PURCHASE',
    sortOrder: 10,
  },
  {
    id: 'back-persian-tile',
    category: 'CARD_BACK',
    nameKey: 'cosmetics.back.persianTile',
    assetRef: 'backs/persian-tile.svg',
    unlockKind: 'PURCHASE',
    sortOrder: 20,
  },
  {
    id: 'back-gold-leaf',
    category: 'CARD_BACK',
    nameKey: 'cosmetics.back.goldLeaf',
    assetRef: 'backs/gold-leaf.svg',
    unlockKind: 'PURCHASE',
    sortOrder: 30,
  },

  // Card faces — art assets, never mirrored in RTL (02 §8.2)
  {
    id: 'face-classic',
    category: 'CARD_FACE',
    nameKey: 'cosmetics.face.classic',
    assetRef: 'faces/classic',
  },
  {
    id: 'face-high-contrast',
    category: 'CARD_FACE',
    nameKey: 'cosmetics.face.highContrast',
    assetRef: 'faces/high-contrast',
    unlockKind: 'PURCHASE',
    sortOrder: 10,
  },
  {
    id: 'face-persian',
    category: 'CARD_FACE',
    nameKey: 'cosmetics.face.persian',
    assetRef: 'faces/persian',
    unlockKind: 'PURCHASE',
    gameSlug: 'shelem',
    sortOrder: 20,
  },

  // Felts
  { id: 'felt-green', category: 'FELT', nameKey: 'cosmetics.felt.green', assetRef: 'felts/green' },
  {
    id: 'felt-blue',
    category: 'FELT',
    nameKey: 'cosmetics.felt.blue',
    assetRef: 'felts/blue',
    unlockKind: 'PURCHASE',
    sortOrder: 10,
  },
  {
    id: 'felt-burgundy',
    category: 'FELT',
    nameKey: 'cosmetics.felt.burgundy',
    assetRef: 'felts/burgundy',
    unlockKind: 'PURCHASE',
    sortOrder: 20,
  },
  {
    id: 'felt-charcoal',
    category: 'FELT',
    nameKey: 'cosmetics.felt.charcoal',
    assetRef: 'felts/charcoal',
    unlockKind: 'PURCHASE',
    sortOrder: 30,
  },

  // Avatars
  {
    id: 'avatar-preset-1',
    category: 'AVATAR',
    nameKey: 'cosmetics.avatar.preset1',
    assetRef: 'avatars/1.svg',
  },
  {
    id: 'avatar-preset-2',
    category: 'AVATAR',
    nameKey: 'cosmetics.avatar.preset2',
    assetRef: 'avatars/2.svg',
    sortOrder: 1,
  },
  {
    id: 'avatar-preset-3',
    category: 'AVATAR',
    nameKey: 'cosmetics.avatar.preset3',
    assetRef: 'avatars/3.svg',
    sortOrder: 2,
  },
  {
    id: 'avatar-preset-4',
    category: 'AVATAR',
    nameKey: 'cosmetics.avatar.preset4',
    assetRef: 'avatars/4.svg',
    sortOrder: 3,
  },
  {
    id: 'frame-gold',
    category: 'AVATAR_FRAME',
    nameKey: 'cosmetics.frame.gold',
    assetRef: 'frames/gold',
    unlockKind: 'PURCHASE',
    sortOrder: 10,
  },

  // Emotes & themes
  {
    id: 'emotes-classic',
    category: 'EMOTE_PACK',
    nameKey: 'cosmetics.emotes.classic',
    assetRef: 'emotes/classic',
  },
  {
    id: 'emotes-tea-house',
    category: 'EMOTE_PACK',
    nameKey: 'cosmetics.emotes.teaHouse',
    assetRef: 'emotes/tea-house',
    unlockKind: 'PURCHASE',
    sortOrder: 10,
  },
  {
    id: 'theme-persian-night',
    category: 'THEME',
    nameKey: 'cosmetics.theme.persianNight',
    assetRef: 'themes/persian-night',
    unlockKind: 'PURCHASE',
    sortOrder: 10,
  },
]

/** Granted to every new account — the free tier of the store (10 §4.1). */
export const DEFAULT_COSMETIC_IDS = COSMETICS.filter(
  (c) => (c.unlockKind ?? 'DEFAULT') === 'DEFAULT',
).map((c) => c.id)

// ═════════════════════════════════════════════════════════════════════════
// Store — price bands from 10 §4.1
// ═════════════════════════════════════════════════════════════════════════

const STORE_ITEMS: { cosmeticId: string; priceAmount: number; category: string }[] = [
  { cosmeticId: 'back-minimal', priceAmount: 200, category: 'CARD_BACK' },
  { cosmeticId: 'back-persian-tile', priceAmount: 600, category: 'CARD_BACK' },
  { cosmeticId: 'back-gold-leaf', priceAmount: 1_200, category: 'CARD_BACK' },
  { cosmeticId: 'face-high-contrast', priceAmount: 400, category: 'CARD_FACE' },
  { cosmeticId: 'face-persian', priceAmount: 800, category: 'CARD_FACE' },
  { cosmeticId: 'felt-blue', priceAmount: 150, category: 'FELT' },
  { cosmeticId: 'felt-burgundy', priceAmount: 300, category: 'FELT' },
  { cosmeticId: 'felt-charcoal', priceAmount: 300, category: 'FELT' },
  { cosmeticId: 'frame-gold', priceAmount: 600, category: 'AVATAR_FRAME' },
  { cosmeticId: 'emotes-tea-house', priceAmount: 350, category: 'EMOTE_PACK' },
  { cosmeticId: 'theme-persian-night', priceAmount: 1_500, category: 'THEME' },
]

// ═════════════════════════════════════════════════════════════════════════
// Reward rules — 10 §3.2 base rates, §3.3 placement, §3.5 decay, §3.7 caps
// ═════════════════════════════════════════════════════════════════════════

type Placement = Record<string, Record<string, number>>

/** 10 §3.3. Losing still pays — a game where losing pays nothing teaches
 *  players to quit when behind, which is what ejection penalties exist to
 *  discourage. */
const HEAD_TO_HEAD: Placement = { '2': { '1': 1.5, '2': 0.6 } }
const FOUR_SEAT: Placement = { '4': { '1': 1.5, '2': 1.0, '3': 0.7, '4': 0.5 } }
const SIX_SEAT: Placement = { '6': { '1': 1.5, '2': 1.1, '3': 0.9, '4': 0.7, '5': 0.5, '6': 0.5 } }
const SOLO: Placement = { '1': { '1': 1.0 } }

function placement(...tables: Placement[]): string {
  return JSON.stringify({ draw: 1, bySeatCount: Object.assign({}, ...tables) })
}

/** 10 §3.5 — index = how many times this matchup has repeated in 30 min. */
const REPEAT_DECAY = JSON.stringify([1, 1, 0.6, 0.3, 0.1])

const MINUTE = 60_000

interface RewardRuleSeed {
  id: string
  gameSlug: string
  baseAmount: number
  placementJson: string
  expectedMinMs: number
}

const REWARD_RULES: RewardRuleSeed[] = [
  {
    id: 'sudoku',
    gameSlug: 'sudoku',
    baseAmount: 10,
    placementJson: placement(SOLO),
    expectedMinMs: 2 * MINUTE,
  },
  {
    id: 'sudoku:race',
    gameSlug: 'sudoku',
    baseAmount: 20,
    placementJson: placement(HEAD_TO_HEAD, FOUR_SEAT, SIX_SEAT),
    expectedMinMs: 2 * MINUTE,
  },
  {
    id: 'blackjack',
    gameSlug: 'blackjack',
    baseAmount: 25,
    placementJson: placement(HEAD_TO_HEAD, FOUR_SEAT, SIX_SEAT),
    expectedMinMs: 1 * MINUTE,
  },
  {
    id: 'chess',
    gameSlug: 'chess',
    baseAmount: 30,
    placementJson: placement(HEAD_TO_HEAD),
    expectedMinMs: 1 * MINUTE,
  },
  {
    id: 'chess:rapid',
    gameSlug: 'chess',
    baseAmount: 50,
    placementJson: placement(HEAD_TO_HEAD),
    expectedMinMs: 1 * MINUTE,
  },
  {
    id: 'poker',
    gameSlug: 'poker',
    baseAmount: 60,
    placementJson: placement(HEAD_TO_HEAD, FOUR_SEAT, SIX_SEAT),
    expectedMinMs: 3 * MINUTE,
  },
  // Shelem pays most on purpose: it is the flagship, and it asks for 45
  // minutes and three other people.
  {
    id: 'shelem',
    gameSlug: 'shelem',
    baseAmount: 80,
    placementJson: placement(FOUR_SEAT),
    expectedMinMs: 8 * MINUTE,
  },
  // The M0 test engine. Earns a token amount so the settlement path is
  // exercised end to end before a real game exists.
  {
    id: 'fixture',
    gameSlug: 'fixture',
    baseAmount: 5,
    placementJson: placement(HEAD_TO_HEAD, FOUR_SEAT),
    expectedMinMs: 0,
  },
]

/** 10 §3.7. Per holder, evaluated inside the credit transaction. */
const GLOBAL_CAPS = {
  capPerHour: 400,
  capPerDay: 2_000,
  capPerDayGuest: 500,
  capMatchesPerDay: 30,
  guestVestCap: 500,
}

// ═════════════════════════════════════════════════════════════════════════
// Achievements — 10 §3.8 (25–500 COIN)
// ═════════════════════════════════════════════════════════════════════════

const ACHIEVEMENTS = [
  {
    id: 'tutorial',
    nameKey: 'achievements.tutorial.name',
    descKey: 'achievements.tutorial.desc',
    gameSlug: null,
    criteriaJson: JSON.stringify({ metric: 'tutorialCompleted', target: 1 }),
    rewardAmount: 100,
    sortOrder: 0,
  },
  {
    id: 'first-win',
    nameKey: 'achievements.firstWin.name',
    descKey: 'achievements.firstWin.desc',
    gameSlug: null,
    criteriaJson: JSON.stringify({ metric: 'wins', target: 1 }),
    rewardAmount: 50,
    sortOrder: 1,
  },
  {
    id: 'ten-matches',
    nameKey: 'achievements.tenMatches.name',
    descKey: 'achievements.tenMatches.desc',
    gameSlug: null,
    criteriaJson: JSON.stringify({ metric: 'played', target: 10 }),
    rewardAmount: 100,
    sortOrder: 2,
  },
  {
    id: 'hundred-matches',
    nameKey: 'achievements.hundredMatches.name',
    descKey: 'achievements.hundredMatches.desc',
    gameSlug: null,
    criteriaJson: JSON.stringify({ metric: 'played', target: 100 }),
    rewardAmount: 500,
    sortOrder: 3,
  },
  {
    id: 'first-shelem-win',
    nameKey: 'achievements.firstShelemWin.name',
    descKey: 'achievements.firstShelemWin.desc',
    gameSlug: 'shelem',
    criteriaJson: JSON.stringify({ metric: 'wins', target: 1 }),
    rewardAmount: 150,
    sortOrder: 10,
  },
  {
    id: 'shelem-contract-made',
    nameKey: 'achievements.shelemContract.name',
    descKey: 'achievements.shelemContract.desc',
    gameSlug: 'shelem',
    criteriaJson: JSON.stringify({ metric: 'contractsMade', target: 10 }),
    rewardAmount: 250,
    sortOrder: 11,
  },
  {
    id: 'week-streak',
    nameKey: 'achievements.weekStreak.name',
    descKey: 'achievements.weekStreak.desc',
    gameSlug: null,
    criteriaJson: JSON.stringify({ metric: 'dailyStreak', target: 7 }),
    rewardAmount: 250,
    sortOrder: 4,
  },
] as const

// ═════════════════════════════════════════════════════════════════════════
// Seeding
// ═════════════════════════════════════════════════════════════════════════

async function seedCosmetics(): Promise<void> {
  for (const c of COSMETICS) {
    const data = {
      category: c.category,
      nameKey: c.nameKey,
      assetRef: c.assetRef,
      unlockKind: c.unlockKind ?? 'DEFAULT',
      gameSlug: c.gameSlug ?? null,
      sortOrder: c.sortOrder ?? 0,
      active: true,
    }
    await db.cosmeticItem.upsert({
      where: { id: c.id },
      create: { id: c.id, ...data },
      update: data,
    })
  }
}

async function seedStore(): Promise<void> {
  for (const item of STORE_ITEMS) {
    const id = `store-${item.cosmeticId}`
    const data = {
      cosmeticId: item.cosmeticId,
      assetCode: 'COIN',
      priceAmount: item.priceAmount,
      category: item.category,
      active: true,
    }
    await db.storeItem.upsert({ where: { id }, create: { id, ...data }, update: data })
  }
}

async function seedRewardRules(): Promise<void> {
  for (const rule of REWARD_RULES) {
    const data = {
      gameSlug: rule.gameSlug,
      assetCode: 'COIN',
      baseAmount: rule.baseAmount,
      placementJson: rule.placementJson,
      expectedMinMs: rule.expectedMinMs,
      repeatDecayJson: REPEAT_DECAY,
      ...GLOBAL_CAPS,
      active: true,
    }
    await db.rewardRule.upsert({
      where: { id: rule.id },
      create: { id: rule.id, ...data },
      update: data,
    })
  }

  const globalData = {
    gameSlug: null,
    assetCode: 'COIN',
    baseAmount: 0,
    placementJson: JSON.stringify({ draw: 1, bySeatCount: {} }),
    expectedMinMs: 0,
    repeatDecayJson: REPEAT_DECAY,
    ...GLOBAL_CAPS,
    active: true,
  }
  await db.rewardRule.upsert({
    where: { id: '_global' },
    create: { id: '_global', ...globalData },
    update: globalData,
  })
}

async function seedAchievements(): Promise<void> {
  for (const a of ACHIEVEMENTS) {
    const data = {
      nameKey: a.nameKey,
      descKey: a.descKey,
      gameSlug: a.gameSlug,
      criteriaJson: a.criteriaJson,
      rewardAsset: 'COIN',
      rewardAmount: a.rewardAmount,
      sortOrder: a.sortOrder,
      active: true,
    }
    await db.achievement.upsert({
      where: { id: a.id },
      create: { id: a.id, ...data },
      update: data,
    })
  }
}

const ADMIN_ID = 'seed-admin'
const ADMIN_GRANT = 5_000

/**
 * The admin account. Its `AdminCredential` row — and specifically the fact
 * that the seed **never writes a TOTP secret**, so the first console login is
 * forced through enrollment — arrives with the admin models in S48
 * (12-admin-console.md §3.3).
 */
async function seedAdmin(): Promise<void> {
  const passwordHash = await hashPassword(env.SEED_ADMIN_PASSWORD)

  await db.user.upsert({
    where: { id: ADMIN_ID },
    create: {
      id: ADMIN_ID,
      email: env.SEED_ADMIN_EMAIL,
      passwordHash,
      displayName: 'Admin',
      role: 'ADMIN',
    },
    // The password hash is deliberately not rewritten on re-seed: re-running
    // the seed must not silently reset an operator's credentials.
    update: { email: env.SEED_ADMIN_EMAIL, role: 'ADMIN' },
  })

  await db.userPreferences.upsert({
    where: { userId: ADMIN_ID },
    create: { userId: ADMIN_ID },
    update: {},
  })

  for (const cosmeticId of DEFAULT_COSMETIC_IDS) {
    await db.userCosmetic.upsert({
      where: { userId_cosmeticId: { userId: ADMIN_ID, cosmeticId } },
      create: { userId: ADMIN_ID, cosmeticId },
      update: {},
    })
  }

  // A funded wallet for testing the store — credited through the ledger, so
  // `balance == Σ transactions` holds even for seeded money (E1).
  await creditOnce({
    walletKey: { userId: ADMIN_ID, assetCode: 'COIN' },
    amount: ADMIN_GRANT,
    kind: 'ADMIN_ADJUST',
    idempotencyKey: 'seed:admin:grant',
    reason: 'seed: development balance',
  })
}

/**
 * A miniature of `WalletService.credit` (S21): look the row up by its derived
 * idempotency key, and if it isn't there, append it and bump the cached
 * balance in the same transaction. Never bump a balance without a ledger row.
 */
async function creditOnce(input: {
  walletKey: { userId?: string; guestSessionId?: string; assetCode: string }
  amount: number
  kind: string
  idempotencyKey: string
  reason?: string
  refKind?: string
  refId?: string
}): Promise<string> {
  const { userId, guestSessionId, assetCode } = input.walletKey

  const wallet = userId
    ? await db.wallet.upsert({
        where: { userId_assetCode: { userId, assetCode } },
        create: { userId, assetCode, status: 'VESTED' },
        update: {},
      })
    : await db.wallet.upsert({
        where: { guestSessionId_assetCode: { guestSessionId: guestSessionId!, assetCode } },
        create: { guestSessionId: guestSessionId!, assetCode, status: 'PROVISIONAL' },
        update: {},
      })

  const existing = await db.walletTransaction.findUnique({
    where: {
      walletId_idempotencyKey: { walletId: wallet.id, idempotencyKey: input.idempotencyKey },
    },
  })
  if (existing) return existing.id

  const balanceAfter = wallet.balance + input.amount

  const [tx] = await db.$transaction([
    db.walletTransaction.create({
      data: {
        walletId: wallet.id,
        assetCode,
        amount: input.amount,
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
        reason: input.reason ?? null,
        refKind: input.refKind ?? null,
        refId: input.refId ?? null,
        balanceAfter,
      },
    }),
    db.wallet.update({
      where: { id: wallet.id },
      data: {
        balance: balanceAfter,
        lifetimeEarned: { increment: Math.max(input.amount, 0) },
        lifetimeSpent: { increment: Math.max(-input.amount, 0) },
      },
    }),
  ])

  return tx.id
}

// ─── Dev-only demo data ───────────────────────────────────────────────────

const DEMO_SLUGS = ['fixture', 'sudoku', 'blackjack', 'shelem', 'poker', 'chess'] as const
const DEMO_SEAT_COUNTS: Record<(typeof DEMO_SLUGS)[number], number> = {
  fixture: 4,
  sudoku: 1,
  blackjack: 4,
  shelem: 4,
  poker: 6,
  chess: 2,
}

async function seedDevData(): Promise<void> {
  // Four players for the demo match.
  const players = await Promise.all(
    [0, 1, 2, 3].map(async (i) => {
      const id = `seed-player-${i}`
      const data = {
        email: `player${i}@local.dev`,
        passwordHash: await hashPassword('correct-horse-battery'),
        displayName: ['Ali', 'Sara', 'Reza', 'Mina'][i] ?? `Player ${i}`,
      }
      return db.user.upsert({
        where: { id },
        create: { id, ...data },
        update: { displayName: data.displayName },
      })
    }),
  )

  for (const slug of DEMO_SLUGS) {
    const id = `seed-table-${slug}`
    const data = {
      hostUserId: ADMIN_ID,
      gameSlug: slug,
      status: 'WAITING',
      origin: 'PRIVATE',
      optionsJson: '{}',
      seatCount: DEMO_SEAT_COUNTS[slug],
    }
    await db.table.upsert({ where: { id }, create: { id, ...data }, update: data })
  }

  // The invite the S16 verification steps use by name.
  const inviteData = {
    tableId: 'seed-table-fixture',
    code: 'SEEDDEMO',
    createdByUserId: ADMIN_ID,
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    revokedAt: null,
  }
  await db.invite.upsert({
    where: { id: 'seed-invite-demo' },
    create: { id: 'seed-invite-demo', ...inviteData },
    update: inviteData,
  })

  await seedDemoMatch(players.map((p) => p.id))
}

/**
 * ★ The ejected-winner fixture.
 *
 * A Shelem partnership wins; one of the two winners was ejected for timing
 * out. That seat earns **zero** while their partner is paid in full — the rule
 * from 10 §5, visible in Studio from day one instead of waiting for somebody
 * to actually go AFK. Every later reward session leans on this row.
 */
async function seedDemoMatch(playerIds: string[]): Promise<void> {
  const tableId = 'seed-table-shelem'
  const gameId = 'seed-game-shelem'
  const matchId = 'seed-match-shelem'

  const gameData = {
    tableId,
    gameSlug: 'shelem',
    status: 'FINISHED',
    rngSeed: 'seed-demo-shelem',
    seedCommit: 'demo-commit',
    seedRevealedAt: new Date(),
    seq: 0,
    seatingJson: JSON.stringify(playerIds.map((userId, seat) => ({ seat, userId }))),
    optionsJson: '{}',
    finishedAt: new Date(),
  }
  await db.gameInstance.upsert({
    where: { id: gameId },
    create: { id: gameId, ...gameData },
    update: gameData,
  })

  const matchData = {
    gameId,
    gameSlug: 'shelem',
    reason: 'NORMAL',
    winningTeam: 0,
    summaryJson: JSON.stringify({ contract: 105, made: true, scores: { 0: 115, 1: 60 } }),
    durationMs: 41 * MINUTE,
  }
  await db.matchResult.upsert({
    where: { id: matchId },
    create: { id: matchId, ...matchData },
    update: matchData,
  })

  // seat 0 & 2 = team 0 (winners); seat 2 was ejected and earns nothing.
  const seats = [
    { seat: 0, team: 0, rank: 1, score: 115, outcome: 'COMPLETED', coins: 120, forfeited: false },
    { seat: 1, team: 1, rank: 2, score: 60, outcome: 'COMPLETED', coins: 80, forfeited: false },
    {
      seat: 2,
      team: 0,
      rank: 1,
      score: 115,
      outcome: 'EJECTED_TIMEOUT',
      coins: 0,
      forfeited: true,
    },
    { seat: 3, team: 1, rank: 2, score: 60, outcome: 'COMPLETED', coins: 80, forfeited: false },
  ]

  for (const s of seats) {
    const userId = playerIds[s.seat]
    if (!userId) continue

    const rewardTxId =
      s.coins > 0
        ? await creditOnce({
            walletKey: { userId, assetCode: 'COIN' },
            amount: s.coins,
            kind: 'MATCH_REWARD',
            idempotencyKey: `match:${matchId}:${s.seat}`,
            refKind: 'MatchResult',
            refId: matchId,
          })
        : await creditOnce({
            // Capped/forfeited rewards get a zero-amount row with a reason —
            // never silence (10 §2.4 step 3).
            walletKey: { userId, assetCode: 'COIN' },
            amount: 0,
            kind: 'CAP_REJECTED',
            idempotencyKey: `match:${matchId}:${s.seat}`,
            reason: s.outcome,
            refKind: 'MatchResult',
            refId: matchId,
          })

    const id = `seed-participant-${s.seat}`
    const data = {
      matchResultId: matchId,
      userId,
      seat: s.seat,
      team: s.team,
      rank: s.rank,
      score: s.score,
      outcome: s.outcome,
      forfeited: s.forfeited,
      coinsAwarded: s.coins,
      rewardForfeited: s.forfeited,
      rewardTxId,
      playedFraction: s.forfeited ? 0.6 : 1,
    }
    await db.matchParticipant.upsert({ where: { id }, create: { id, ...data }, update: data })
  }
}

async function main(): Promise<void> {
  console.log(`Seeding (${env.NODE_ENV})…`)

  await seedCosmetics()
  await seedStore()
  await seedRewardRules()
  await seedAchievements()
  await seedAdmin()

  if (isProduction) {
    console.log('  catalog only — NODE_ENV=production seeds no demo data')
  } else {
    await seedDevData()
    console.log('  + dev demo tables, the SEEDDEMO invite, and the ejected-winner match')
  }

  console.log('Seed complete.')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
