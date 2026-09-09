import type { Logger } from 'pino'
import type { SecurityEventKind, SecuritySeverity } from '../../contracts/enums.js'
import type { ISecurityEventRepository } from '../../domain/repositories/identity.js'
import type { MetricsRegistry } from './MetricsRegistry.js'

/**
 * The one entry point for the audit trail — 07 §6, S15.
 *
 * Built before the features that need auditing so nothing gets retrofitted.
 * Every rejected move, every bad token, every cross-table guest probe goes
 * through {@link SecurityEventService.record}.
 *
 * ### The rule that shapes the whole class
 *
 * **An audit failure must never fail the thing it is auditing.** If the
 * `SecurityEvent` insert throws — disk full, database restarting — the game
 * move that triggered it still has to complete. So `record` is fire-and-forget
 * and swallows its own errors into the log. The alternative ("fail closed") is
 * defensible for financial ledgers and is exactly what the wallet does; for a
 * *diagnostic* trail it would convert a monitoring outage into an outage.
 *
 * Note the contrast with `withAudit` in the admin console (12 §10): an admin
 * mutation with no audit row is refused. There the audit row *is* the
 * accountability, so it must be transactional. Here it is telemetry.
 */

export interface SecurityEventContext {
  readonly userId?: string | null
  readonly guestSessionId?: string | null
  readonly tableId?: string | null
  readonly gameId?: string | null
  readonly ip?: string | null
  readonly userAgent?: string | null
  readonly details?: Record<string, unknown> | null
}

/**
 * Default severity per kind. A caller may override — a single `ILLEGAL_MOVE`
 * is noise, the hundredth from one seat in a minute is an `ALERT` — but the
 * default must be sensible, because most call sites will not think about it.
 */
export const DEFAULT_SEVERITY: Record<SecurityEventKind, SecuritySeverity> = {
  ILLEGAL_MOVE: 'INFO',
  NOT_YOUR_TURN: 'INFO',
  RATE_LIMIT: 'INFO',
  INVITE_ABUSE: 'WARN',
  /** Token reuse means a cookie leaked. That is not informational. */
  BAD_TOKEN: 'WARN',
  /** Someone is using a credential outside its binding. Always loud. */
  SEAT_IMPERSONATION: 'ALERT',
}

export class SecurityEventService {
  constructor(
    private readonly repository: ISecurityEventRepository,
    private readonly logger: Logger,
    private readonly metrics?: MetricsRegistry,
  ) {}

  /**
   * Records an event without making the caller wait or handle failure.
   *
   * Use this from request and socket paths. Tests and any caller that must
   * observe the row want {@link recordAndWait}.
   */
  record(
    kind: SecurityEventKind,
    context: SecurityEventContext = {},
    severity: SecuritySeverity = DEFAULT_SEVERITY[kind],
  ): void {
    void this.recordAndWait(kind, context, severity)
  }

  /**
   * The same write, awaited. **Still never rejects** — the promise resolves
   * either way, so awaiting it cannot turn an audit problem into a request
   * failure. It resolves to `false` when the write was lost.
   */
  async recordAndWait(
    kind: SecurityEventKind,
    context: SecurityEventContext = {},
    severity: SecuritySeverity = DEFAULT_SEVERITY[kind],
  ): Promise<boolean> {
    const entry = {
      kind,
      severity,
      userId: context.userId ?? null,
      guestSessionId: context.guestSessionId ?? null,
      tableId: context.tableId ?? null,
      gameId: context.gameId ?? null,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      details: context.details ?? null,
    }

    // An ALERT also goes to the log at `error`, because the audit table is
    // something a human reads on purpose and the log is something that pages
    // them. A row nobody looks at is not a control.
    const line = { securityEvent: kind, severity, ...stripNulls(entry) }
    if (severity === 'ALERT') this.logger.error(line, `security event: ${kind}`)
    else if (severity === 'WARN') this.logger.warn(line, `security event: ${kind}`)
    else this.logger.info(line, `security event: ${kind}`)

    this.metrics?.increment('security_events')

    try {
      await this.repository.record(entry)
      return true
    } catch (error) {
      this.logger.error(
        { err: error, securityEvent: kind },
        'failed to persist security event — the audited request was not affected',
      )
      return false
    }
  }
}

/** Keeps log lines readable: a context of eight nulls tells nobody anything. */
function stripNulls(entry: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entry).filter(([, value]) => value !== null && value !== undefined),
  )
}
