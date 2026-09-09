import type { Express } from 'express'
import pino from 'pino'
import request from 'supertest'
import { buildApp } from '../../src/app.js'
import { parseEnv, type Env } from '../../src/config/env.js'
import { buildContainer, type Container, type ContainerOverrides } from '../../src/container.js'
import { AUTH_COOKIES, CSRF_HEADER } from '../../src/contracts/dto/auth.js'
import { SlidingWindowRateLimiter } from '../../src/infrastructure/rateLimit/slidingWindow.js'
import { db } from './db.js'

/**
 * A real app over the real test database, with a silent logger.
 *
 * Integration tests here exercise the *chain* — helmet, CORS, the limiter,
 * CSRF, `authenticate`, the route, the error middleware — because that chain is
 * where the security properties live. Testing a controller in isolation would
 * pass with `authenticate` unmounted.
 */
export interface TestApp {
  readonly app: Express
  readonly container: Container
  /**
   * Forgets every rate-limit bucket. Call it in `beforeEach`: the app is built
   * once per file, so without this the second half of a file runs against a
   * budget the first half already spent, and the failures look like auth bugs.
   */
  readonly resetLimits: () => void
}

const silent = pino({ level: 'silent' })

export function buildTestApp(overrides: ContainerOverrides = {}): TestApp {
  const rateLimiter = overrides.rateLimiter ?? new SlidingWindowRateLimiter(0)
  const container = buildContainer({ prisma: db, logger: silent, rateLimiter, ...overrides })

  return {
    app: buildApp(container),
    container,
    resetLimits: () => {
      if (rateLimiter instanceof SlidingWindowRateLimiter) rateLimiter.clear()
    },
  }
}

/** Same app, with `NODE_ENV=production` semantics (Secure cookies, no probes). */
export function productionEnv(patch: Record<string, string> = {}): Env {
  return parseEnv({ ...process.env, NODE_ENV: 'production', ...patch })
}

/**
 * A cookie-carrying client, which is the only realistic way to test cookie
 * auth: the browser's jar is part of the mechanism under test.
 */
export function client(app: Express) {
  return request.agent(app)
}

export type Client = ReturnType<typeof client>

/** Reads a cookie out of an agent's jar by name. */
export function cookieValue(agent: Client, name: string): string | undefined {
  const jar = (agent as unknown as { jar: { getCookies: (access: unknown) => unknown[] } }).jar
  const cookies = jar.getCookies({ domain: '127.0.0.1', path: '/', secure: false, script: false })

  for (const cookie of cookies as Array<{ name: string; value: string }>) {
    if (cookie.name === name) return cookie.value
  }
  return undefined
}

/**
 * Registers a user through the real endpoint and returns the logged-in client.
 *
 * Going through HTTP rather than seeding rows directly is deliberate: it means
 * every test that needs "a logged-in user" also re-proves that registration
 * issues working cookies.
 */
export async function registerUser(
  app: Express,
  overrides: Partial<{ email: string; password: string; displayName: string }> = {},
) {
  const agent = client(app)
  const body = {
    email: overrides.email ?? `u${uniqueSuffix()}@test.dev`,
    password: overrides.password ?? 'correct-horse-battery',
    displayName: overrides.displayName ?? 'Tester',
  }

  const response = await agent.post('/api/v1/auth/register').send(body)
  return { agent, body, response }
}

let counter = 0
export function uniqueSuffix(): string {
  counter += 1
  return `${Date.now().toString(36)}${counter}`
}

export { AUTH_COOKIES, CSRF_HEADER }
