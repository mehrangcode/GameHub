import pino from 'pino'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SEVERITY,
  SecurityEventService,
} from '../../src/application/services/SecurityEventService.js'
import { MetricsRegistry } from '../../src/application/services/MetricsRegistry.js'
import { SECURITY_EVENT_KINDS } from '../../src/contracts/enums.js'
import type { ISecurityEventRepository } from '../../src/domain/repositories/identity.js'
import { getEnv } from '../../src/config/env.js'
import { SlidingWindowRateLimiter } from '../../src/infrastructure/rateLimit/slidingWindow.js'
import { InMemorySecurityEventRepository } from '../fakes/identity.js'
import { buildTestApp } from '../helpers/app.js'
import { db, resetDb } from '../helpers/db.js'

/** S15 — the audit trail and the counters, built before the features need them. */
const silent = pino({ level: 'silent' })

beforeEach(async () => {
  await resetDb()
})

describe('SecurityEventService', () => {
  it('★ records every kind with the documented severity', async () => {
    const repository = new InMemorySecurityEventRepository()
    const service = new SecurityEventService(repository, silent)

    for (const kind of SECURITY_EVENT_KINDS) {
      expect(await service.recordAndWait(kind, { details: { probe: true } })).toBe(true)
    }

    const rows = repository.rows.all()
    expect(rows).toHaveLength(SECURITY_EVENT_KINDS.length)
    for (const kind of SECURITY_EVENT_KINDS) {
      const row = rows.find((event) => event.kind === kind)
      expect(row?.severity, kind).toBe(DEFAULT_SEVERITY[kind])
    }
  })

  it('treats a cross-table guest probe as the loudest thing it sees', () => {
    // Someone using a credential outside its binding is not informational.
    expect(DEFAULT_SEVERITY.SEAT_IMPERSONATION).toBe('ALERT')
    expect(DEFAULT_SEVERITY.BAD_TOKEN).toBe('WARN')
  })

  it('logs an ALERT at error level so it can page a human', async () => {
    const lines: Array<{ level: string; msg: string }> = []
    const capture = pino(
      { level: 'trace' },
      {
        write: (line: string) => {
          const parsed = JSON.parse(line) as { level: number; msg: string }
          lines.push({ level: String(parsed.level), msg: parsed.msg })
        },
      },
    )

    const service = new SecurityEventService(new InMemorySecurityEventRepository(), capture)
    await service.recordAndWait('SEAT_IMPERSONATION', {})
    await service.recordAndWait('ILLEGAL_MOVE', {})

    // A row nobody looks at is not a control, so ALERT also reaches the log.
    expect(lines.find((line) => line.msg.includes('SEAT_IMPERSONATION'))?.level).toBe('50')
    expect(lines.find((line) => line.msg.includes('ILLEGAL_MOVE'))?.level).toBe('30')
  })

  it('★ a broken audit write never fails the caller', async () => {
    const broken: ISecurityEventRepository = {
      record: vi.fn().mockRejectedValue(new Error('disk full')),
      list: vi.fn().mockResolvedValue([]),
      countSince: vi.fn().mockResolvedValue(0),
    }
    const service = new SecurityEventService(broken, silent)

    // The whole point: a monitoring outage must not become a game outage. The
    // contrast is `withAudit` in the admin console (12 §10), where the audit
    // row *is* the accountability and a failure must abort the mutation.
    expect(await service.recordAndWait('ILLEGAL_MOVE', {})).toBe(false)
    expect(() => service.record('ILLEGAL_MOVE', {})).not.toThrow()
  })

  it('counts what it records', async () => {
    const metrics = new MetricsRegistry()
    const service = new SecurityEventService(new InMemorySecurityEventRepository(), silent, metrics)

    await service.recordAndWait('RATE_LIMIT', {})
    await service.recordAndWait('RATE_LIMIT', {})

    expect(metrics.snapshot().counters.security_events).toBe(2)
  })
})

describe('the rate limiter feeds the audit trail', () => {
  it('★ a tripped limit lands in SecurityEvent and in the counters', async () => {
    const limiter = new SlidingWindowRateLimiter(0)
    const { app, container } = buildTestApp({
      rateLimiter: limiter,
      env: { ...getEnv(), RATE_LIMIT_MAX: 2, RATE_LIMIT_WINDOW_SEC: 60 },
    })

    for (let i = 0; i < 4; i += 1) await request(app).get('/api/v1/no-such-route')
    limiter.dispose()

    // The counter is synchronous with the denial, so it is the exact figure.
    expect(container.metrics.snapshot().counters.rate_limit_trips).toBe(2)

    // The row is not: recording is fire-and-forget by design, so it has to be
    // waited for rather than assumed. That asynchrony is the feature — a slow
    // audit insert must never slow the request that triggered it.
    const events = await eventually(
      () => db.securityEvent.findMany({ where: { kind: 'RATE_LIMIT' } }),
      (rows) => rows.length >= 2,
    )
    expect(events).toHaveLength(2)
    expect(events[0]?.detailsJson).toContain('no-such-route')
  })
})

async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let latest = await read()

  while (!done(latest) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    latest = await read()
  }
  return latest
}

describe('nothing is exposed over HTTP here (12 §11.1)', () => {
  const { app } = buildTestApp()

  it('★ /metrics is 404 on the public port', async () => {
    for (const path of ['/metrics', '/api/v1/metrics']) {
      const res = await request(app).get(path)
      expect(res.status, path).toBe(404)
    }
  })

  it('★ /admin/* is 404 on the public port', async () => {
    for (const path of ['/admin', '/admin/api/v1/security-events', '/api/v1/admin/metrics']) {
      const res = await request(app).get(path)
      expect(res.status, path).toBe(404)
    }
  })

  it('★ no route matching /admin or /metrics is mounted at all', () => {
    // The first half of the S48 isolation guard: walk the router stack rather
    // than trusting a 404, which could also mean "mounted but unreachable".
    const stack = app as unknown as {
      _router?: { stack: unknown[] }
      router?: { stack: unknown[] }
    }
    const layers = stack.router?.stack ?? stack._router?.stack ?? []

    const paths = collectPaths(layers)
    expect(paths.filter((path) => path.includes('admin'))).toEqual([])
    expect(paths.filter((path) => path.includes('metrics'))).toEqual([])
  })
})

/** Flattens an Express router stack into the route paths it can serve. */
function collectPaths(layers: unknown[]): string[] {
  const found: string[] = []

  for (const layer of layers as Array<{
    route?: { path?: string | string[] }
    handle?: { stack?: unknown[] }
    regexp?: RegExp
  }>) {
    const path = layer.route?.path
    if (typeof path === 'string') found.push(path)
    else if (Array.isArray(path)) found.push(...path)

    if (layer.handle?.stack) found.push(...collectPaths(layer.handle.stack))
    if (layer.regexp) found.push(layer.regexp.source)
  }

  return found
}
