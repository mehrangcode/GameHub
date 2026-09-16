import type { Logger } from 'pino'
import type { AssetCode, SeatOutcome } from '../../contracts/enums.js'
import type { GameRewardSettledPayload } from '../../contracts/events.js'
import type {
  GameEvent,
  GameInstance,
  MatchResult,
  SeatAssignment,
} from '../../domain/entities/game.js'
import { holderOf } from '../../domain/entities/game.js'
import { matchRewardKey } from '../../domain/economy/idempotency.js'
import type { GameResult, GameStanding } from '../../domain/games/GameEngine.js'
import type { TableMember } from '../../domain/entities/table.js'
import type { IUnitOfWork, Repositories } from '../../domain/repositories/Repositories.js'
import type { IdentityRef } from '../../domain/value-objects/identity.js'
import type { SeatId } from '../../domain/value-objects/seat.js'
import { seatRoom, type IRealtimePublisher } from '../ports/realtime.js'
import { seatOutcomeOf } from '../mappers/outcomes.js'
import type { MetricsRegistry } from './MetricsRegistry.js'
import { RewardService, type RewardBreakdown } from './RewardService.js'
import type { WalletService } from './WalletService.js'

/**
 * ★★ Settlement — S36. 03 §6.4, 10 §3 and §5. The M0 exit criterion lives here.
 *
 *     an ejected player on a winning team earns 0;
 *     their partner earns the full winning reward.
 *
 * ### The loop is the feature
 *
 * `result.standings` is iterated **per seat, never per team**. That one choice
 * is why forfeiture needs no special case anywhere in this file: each seat
 * resolves its own outcome, gets its own `integrityFactor`, its own reward, and
 * its own idempotency key. A team-shaped loop would have had to reach back in
 * and un-pay one member of a pair, which is exactly the kind of correction that
 * gets a condition wrong eighteen months later.
 *
 * ### Two layers of idempotency, doing different jobs
 *
 * | Layer | Mechanism | Stops |
 * |---|---|---|
 * | Match | `MatchResult.gameId` is unique | a second set of participants, stats and rating rows |
 * | Seat | `match:{matchResultId}:{seat}` on the ledger | a second **payment** |
 *
 * Both are needed. The seat key alone would let a replay write duplicate
 * participants while paying once; the match check alone is a read that two
 * concurrent finishes can both pass. Between them a settlement can be attempted
 * any number of times and land exactly once (E2).
 *
 * ### Why the preview happens outside the transaction
 *
 * The plan — what every seat is about to be paid, and why — is computed from
 * reads only, broadcast as `game:rewardPreview`, and *then* handed to the
 * transaction that pays it. That ordering is 10 §11's: a player sees the
 * arithmetic before the number moves, so a forfeit reads as a rule rather than
 * as a wallet that failed to change. Computing it twice would risk two answers;
 * computing it inside the transaction would mean announcing after the fact.
 *
 * ### What settlement does NOT do
 *
 * It does not touch `Rating` or `RatingChange`. ELO for a four-handed
 * partnership game is a real design question — per seat or per team, against
 * what expected score — and M0's only engine is `_fixture`. Guessing now would
 * mean designing the rating model against a test rig and redesigning it at M4
 * against Shelem. `PlayerStats` is unambiguous and is written here.
 */

/** Everything decided about one seat before any write happens. */
interface SeatPlan {
  readonly seat: SeatId
  readonly standing: GameStanding
  readonly assignment: SeatAssignment
  readonly outcome: SeatOutcome
  /** Null for a bot seat: nobody to pay, and no wallet to pay into. */
  readonly holder: IdentityRef | null
  readonly breakdown: RewardBreakdown
  readonly premiumMultiplier: number
  /** From `MatchResult.reason`, not from seats sharing a rank. */
  readonly isDraw: boolean
}

export interface SettlementOutcome {
  readonly matchResult: MatchResult
  /** False when this game was already settled — nothing was written or paid. */
  readonly applied: boolean
  readonly totalPaid: number
}

export interface SettlementServiceDeps {
  readonly uow: IUnitOfWork
  readonly repos: Repositories
  readonly rewards: RewardService
  readonly wallets: WalletService
  readonly realtime: IRealtimePublisher
  readonly metrics: MetricsRegistry
  readonly logger: Logger
  readonly now?: () => Date
  /**
   * Slug → a per-game settlement hook. Optional, and absent for every game
   * that has nothing game-specific to record.
   */
  readonly hooks?: Readonly<Record<string, SettlementHook>>
}

/**
 * A game's chance to write its own counters — and grant its own currency —
 * inside the settlement transaction.
 *
 * Returns the new `PlayerStats.extra` blob for this seat, or `null` to leave it
 * alone. The blob is **replaced**, not merged, so a hook returns the previous
 * value with its own keys changed; `previousExtra` is supplied for exactly
 * that.
 *
 * Running inside settlement's transaction is the point rather than a
 * convenience: Sudoku's hook increments a solve counter *and* grants the hint
 * point that counter earns, and a counter that committed without its grant
 * would hand the player a milestone they never receive.
 */
export interface SettlementHook {
  onSeatSettled(input: {
    readonly repos: Repositories
    readonly instance: GameInstance
    readonly result: GameResult
    readonly matchResultId: string
    readonly seat: SeatId
    readonly holder: IdentityRef
    readonly outcome: SeatOutcome
    readonly previousExtra: Record<string, unknown> | null
  }): Promise<Record<string, unknown> | null>
}

export class SettlementService {
  private readonly now: () => Date

  constructor(private readonly deps: SettlementServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * Settle a finished game. Safe to call twice; safe to call after a restart.
   *
   * Never throws for an already-settled game — a duplicated finish is a
   * *normal* event in a system with retries and reconnections, not an error
   * anybody should be woken up for.
   */
  async settle(
    instance: GameInstance,
    result: GameResult,
    finishedAt: Date = this.now(),
  ): Promise<SettlementOutcome> {
    const already = await this.deps.repos.matchResults.findByGame(instance.id)
    if (already !== null) {
      this.deps.metrics.increment('settlements_replayed')
      return { matchResult: already, applied: false, totalPaid: 0 }
    }

    const plans = await this.plan(instance, result, finishedAt)
    this.announcePreview(instance, plans)

    const settled = await this.deps.uow.run(async (repos) =>
      this.settleWithin(repos, instance, result, finishedAt, plans),
    )

    if (settled.applied) {
      this.announceSettled(instance, settled.payloads)
      await this.announceWallets(plans, settled.payloads)
    }
    return { matchResult: settled.matchResult, applied: settled.applied, totalPaid: settled.total }
  }

  // ── The plan: every number, decided from reads alone ──────────────────────

  private async plan(
    instance: GameInstance,
    result: GameResult,
    finishedAt: Date,
  ): Promise<SeatPlan[]> {
    const repos = this.deps.repos
    const table = await repos.tables.findById(instance.tableId)
    const members = await repos.tables.listMembers(instance.tableId)
    const events = await repos.events.listByGame(instance.id)

    const rule = await this.deps.rewards.ruleFor(repos, instance.gameSlug, variantOf(instance))
    const durationMs = Math.max(0, finishedAt.getTime() - instance.startedAt.getTime())

    /**
     * ★ §3.5's signature is the set of **human** holders at this table, and
     * nothing else — not the game, not the seating. Built from `seating`
     * rather than from the live member rows because seating is the historical
     * record: an ejected player was part of this matchup even though a bot
     * finished their seat.
     */
    const holders = instance.seating.flatMap((assignment) => {
      const holder = holderOf(assignment)
      return holder === null ? [] : [holder]
    })
    const repeatIndex = await this.deps.rewards.repeatIndexFor(repos, holders)
    if (repeatIndex > 2) this.deps.metrics.increment('reward_decay_applied')

    const plans: SeatPlan[] = []
    for (const standing of result.standings) {
      const assignment = instance.seating.find((entry) => entry.seat === standing.seat)
      if (assignment === undefined) continue

      const member = members.find((row) => row.seat === standing.seat)
      const outcome = resolveOutcome(standing, member, events)
      const holder = holderOf(assignment)

      const premiumMultiplier =
        holder === null ? 1 : await this.deps.rewards.premiumMultiplierFor(repos, holder)
      if (premiumMultiplier > 1) this.deps.metrics.increment('premium_multiplier_applied')

      plans.push({
        seat: standing.seat,
        standing,
        assignment,
        outcome,
        holder,
        premiumMultiplier,
        isDraw: result.reason === 'DRAW',
        breakdown: RewardService.compute({
          rule,
          seatCount: instance.seating.length,
          rank: standing.rank,
          isDraw: result.reason === 'DRAW',
          outcome,
          premiumMultiplier,
          repeatIndex,
          durationMs,
          durationExempt: isDurationExempt(result),
          rewardEligible: table?.rewardEligible ?? true,
        }),
      })
    }

    return plans
  }

  // ── The write: one transaction, or nothing at all ─────────────────────────

  private async settleWithin(
    repos: Repositories,
    instance: GameInstance,
    result: GameResult,
    finishedAt: Date,
    plans: readonly SeatPlan[],
  ): Promise<{
    matchResult: MatchResult
    applied: boolean
    total: number
    payloads: GameRewardSettledPayload[]
  }> {
    const existing = await repos.matchResults.findByGame(instance.id)
    if (existing !== null) {
      // Lost the race with a concurrent finish. The winner's settlement stands,
      // and this one must not write a second set of participants.
      this.deps.metrics.increment('settlements_replayed')
      return { matchResult: existing, applied: false, total: 0, payloads: [] }
    }

    const matchResult = await repos.matchResults.create({
      gameId: instance.id,
      gameSlug: instance.gameSlug,
      reason: result.reason,
      winningTeam: result.winningTeam ?? null,
      summary: result.summary,
      durationMs: Math.max(0, finishedAt.getTime() - instance.startedAt.getTime()),
      finishedAt,
    })

    const payloads: GameRewardSettledPayload[] = []
    let total = 0

    for (const plan of plans) {
      const settledSeat = await this.settleSeat(repos, instance, matchResult, plan, result)
      total += settledSeat?.coinsAwarded ?? 0
      if (settledSeat !== null) payloads.push(settledSeat)
    }

    this.deps.metrics.increment('matches_settled')
    return { matchResult, applied: true, total, payloads }
  }

  /** One seat: credit (or explain), record, count. `null` for a bot. */
  private async settleSeat(
    repos: Repositories,
    instance: GameInstance,
    matchResult: MatchResult,
    plan: SeatPlan,
    result: GameResult,
  ): Promise<GameRewardSettledPayload | null> {
    /**
     * ★ A bot gets a `MatchParticipant` row and **no wallet transaction of any
     * kind** — not a zero-amount one (10 §12 case 9). A bot has no wallet to
     * credit and nobody to explain a zero to; writing one would put a row in
     * the ledger that belongs to nobody, which is exactly the kind of orphan
     * the nightly reconciliation then has to reason about.
     */
    if (plan.holder === null) {
      await repos.participants.create({
        matchResultId: matchResult.id,
        userId: null,
        guestSessionId: null,
        isBot: true,
        seat: plan.seat,
        team: plan.assignment.team,
        rank: plan.standing.rank,
        score: plan.standing.score,
        outcome: 'BOT',
        forfeited: false,
        coinsAwarded: 0,
        rewardForfeited: false,
        rewardTxId: null,
        playedFraction: plan.standing.playedFraction,
      })
      return null
    }

    const asset: AssetCode = 'COIN'

    /**
     * ★ A zero reward is credited too, and that is deliberate — 10 §5.2 rule 6.
     *
     * `WalletService.creditWithin` turns an amount of 0 into a `CAP_REJECTED`
     * row carrying the reason, so *"why did I earn nothing?"* is answerable
     * from the ledger alone rather than from an absence. A player who cannot
     * see why they were paid nothing assumes a bug — and they are right to,
     * because a bug looks identical.
     */
    const credit = await this.deps.wallets.creditWithin(repos, {
      holder: plan.holder,
      asset,
      amount: plan.breakdown.amount,
      kind: 'MATCH_REWARD',
      idempotencyKey: matchRewardKey(matchResult.id, plan.seat),
      reason: ledgerReason(plan),
      refKind: 'match',
      refId: matchResult.id,
      // E3/§3.7: premium raises the ceiling by the same factor it raises
      // earning, so a subscriber's 1.5× reward is not immediately capped back.
      capMultiplier: plan.premiumMultiplier,
    })

    const coinsAwarded = Math.max(0, credit.credited)

    await repos.participants.create({
      matchResultId: matchResult.id,
      userId: plan.holder.kind === 'user' ? plan.holder.userId : null,
      guestSessionId: plan.holder.kind === 'guest' ? plan.holder.guestSessionId : null,
      isBot: false,
      seat: plan.seat,
      team: plan.assignment.team,
      rank: plan.standing.rank,
      score: plan.standing.score,
      outcome: plan.outcome,
      forfeited: leftEarly(plan.outcome),
      coinsAwarded,
      rewardForfeited: plan.breakdown.forfeited,
      rewardTxId: credit.transaction.id,
      playedFraction: plan.standing.playedFraction,
    })

    await this.recordStats(repos, instance, plan, result, matchResult.id)

    this.deps.metrics.increment(coinsAwarded > 0 ? 'rewards_paid' : 'rewards_forfeited')

    return {
      gameId: instance.id,
      tableId: instance.tableId,
      seat: plan.seat,
      coinsAwarded,
      earned: plan.breakdown.amount,
      forfeited: plan.breakdown.forfeited,
      reasonKey: plan.breakdown.reasonKey,
      capped: credit.capCode !== null,
      capCode: credit.capCode,
      factors: plan.breakdown.factors,
    }
  }

  /**
   * `PlayerStats`, in the same transaction — users only.
   *
   * A guest has no `PlayerStats` row to write to: the model is keyed by
   * `userId`, and inventing a guest-shaped stats table would be building the
   * *other* half of an account for somebody who has not made one. A guest's
   * history arrives with them at signup instead, through the claim's
   * re-attribution of `MatchParticipant` (03 §6.1 step 7) — which is the same
   * data, counted when it becomes permanent.
   */
  private async recordStats(
    repos: Repositories,
    instance: GameInstance,
    plan: SeatPlan,
    result: GameResult,
    matchResultId: string,
  ): Promise<void> {
    if (plan.holder?.kind !== 'user') return

    const drawn = plan.isDraw
    const won = !drawn && plan.standing.rank === 1
    const previous = await repos.stats.findByUserAndGame(plan.holder.userId, instance.gameSlug)
    // A draw neither extends a winning streak nor breaks it — it is not a loss.
    const streak = won ? (previous?.currentStreak ?? 0) + 1 : drawn ? (previous?.currentStreak ?? 0) : 0

    /**
     * ★ The per-game seam — `PlayerStats.extraJson` is documented as
     * "game-specific counters", and this is how a game gets to write one
     * without this service learning its rules. Sudoku uses it to count solved
     * puzzles and, every third, to grant a hint point (`games/sudoku.md` §13.1)
     * — inside this same transaction, so the count and the point cannot
     * disagree.
     */
    const hook = this.deps.hooks?.[instance.gameSlug]
    const extra =
      hook === undefined
        ? undefined
        : await hook.onSeatSettled({
            repos,
            instance,
            result,
            matchResultId,
            seat: plan.seat,
            holder: plan.holder,
            outcome: plan.outcome,
            previousExtra: previous?.extra ?? null,
          })

    await repos.stats.upsert(plan.holder.userId, instance.gameSlug, {
      played: (previous?.played ?? 0) + 1,
      won: (previous?.won ?? 0) + (won ? 1 : 0),
      lost: (previous?.lost ?? 0) + (won || drawn ? 0 : 1),
      drawn: (previous?.drawn ?? 0) + (drawn ? 1 : 0),
      forfeited: (previous?.forfeited ?? 0) + (plan.breakdown.forfeited ? 1 : 0),
      currentStreak: streak,
      bestStreak: Math.max(previous?.bestStreak ?? 0, streak),
      totalMs: (previous?.totalMs ?? 0) + 0,
      ...(extra === null || extra === undefined ? {} : { extra }),
    })
  }

  // ── Announcements ────────────────────────────────────────────────────────

  /**
   * ★ Seat-private, both of them — 04 §6.6, 10 §10.
   *
   * What somebody earned, and what it cost them to be ejected, is between the
   * platform and that player. `game:finished` already told the table who won.
   */
  private announcePreview(instance: GameInstance, plans: readonly SeatPlan[]): void {
    for (const plan of plans) {
      if (plan.holder === null) continue
      this.deps.realtime.publish(
        seatRoom(instance.tableId, plan.seat),
        'game:rewardPreview',
        {
          gameId: instance.id,
          tableId: instance.tableId,
          seat: plan.seat,
          estimatedCoins: plan.breakdown.amount,
          integrityFactor: plan.breakdown.factors.integrity,
          reasonKey: plan.breakdown.reasonKey ?? 'games.reward.earned',
        },
      )
    }
  }

  /**
   * `wallet:updated` per paid holder, **after** the transaction — 10 §10.
   *
   * Sent even when the credit was zero: a guest who earned nothing still needs
   * their provisional balance on screen to be right, and a client that only
   * heard about increases would drift out of step with the ledger the first
   * time a cap bound.
   */
  private async announceWallets(
    plans: readonly SeatPlan[],
    payloads: readonly GameRewardSettledPayload[],
  ): Promise<void> {
    for (const payload of payloads) {
      const holder = plans.find((plan) => plan.seat === payload.seat)?.holder
      if (holder === undefined || holder === null) continue

      await this.deps.wallets.announce(holder, 'COIN', {
        delta: payload.coinsAwarded,
        reason: payload.capCode ?? (payload.forfeited ? 'FORFEITED' : 'MATCH_REWARD'),
      })
    }
  }

  private announceSettled(
    instance: GameInstance,
    payloads: readonly GameRewardSettledPayload[],
  ): void {
    for (const payload of payloads) {
      this.deps.realtime.publish(
        seatRoom(instance.tableId, payload.seat),
        'game:rewardSettled',
        payload,
      )
    }
  }
}

// ── Pure helpers ───────────────────────────────────────────────────────────

/**
 * ★ The engine reports facts; the member row and the log report ejections.
 *
 * `GameEngine.result()` says `COMPLETED` for every seat on purpose — whether
 * somebody was struck out is not the game's business and cannot be, because an
 * engine that could see a clock would stop satisfying invariant I1. So the
 * derived outcome wins whenever it has something to say, and the engine's own
 * value (`RESIGNED`, which *is* a move it saw) stands otherwise.
 */
function resolveOutcome(
  standing: GameStanding,
  member: TableMember | undefined,
  events: readonly GameEvent[],
): SeatOutcome {
  if (member === undefined) return standing.outcome
  const derived = seatOutcomeOf(member, events)
  return derived === 'COMPLETED' ? standing.outcome : derived
}

/** Left before the end under their own steam — an ejection or a resignation. */
function leftEarly(outcome: SeatOutcome): boolean {
  return outcome === 'EJECTED_TIMEOUT' || outcome === 'EJECTED_ABANDON' || outcome === 'RESIGNED'
}

/**
 * ★ §3.6's exemption. A chess resignation in a lost position and an all-fold
 * poker hand are legitimately fast, and scaling their reward by how briefly
 * they lasted would punish the courteous version of losing — which is the
 * behaviour §5.2 rule 2 is trying to encourage.
 *
 * Derived from `MatchResult.reason`, which the engine already reports, rather
 * than from a per-game flag nobody would remember to set.
 */
function isDurationExempt(result: GameResult): boolean {
  return result.reason === 'RESIGNATION'
}

/**
 * The ledger's `reason` is a **machine code**, never the i18n key.
 *
 * 10 §5.2 rule 6 spells the forfeiture row out as `reason: 'EJECTED_TIMEOUT'`,
 * and that is the right shape: the ledger is read by operators, by the admin
 * console and by the reconciliation job, none of which should have to reverse a
 * translation key to find out what happened. The i18n key travels on
 * `game:rewardSettled` instead, where a human is reading it.
 */
function ledgerReason(plan: SeatPlan): string | undefined {
  if (plan.breakdown.amount > 0) return undefined
  if (plan.breakdown.forfeited) return plan.outcome
  return plan.breakdown.reasonKey === null ? 'ZERO_REWARD' : `NO_REWARD:${plan.outcome}`
}

/**
 * `sudoku:race`, `chess:rapid` — a rate card per variant (10 §3.2).
 *
 * Read off the stored, *parsed* options rather than off a column: the variant
 * is a game rule, the engine's own schema validated it at table creation, and
 * `RewardRule.id` is free-form enough to hold `slug:variant` without a
 * migration.
 */
function variantOf(instance: GameInstance): string | undefined {
  const variant = instance.options['variant']
  return typeof variant === 'string' && variant.length > 0 ? variant : undefined
}
