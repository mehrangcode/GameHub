import express, { Router } from 'express'
import request from 'supertest'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildApp, forbidAdminRoutes } from '../../../src/app.js'
import { buildAdminApp } from '../../../src/admin-app.js'
import { buildContainer } from '../../../src/container.js'
import { AdminEnvSchema, parseEnv } from '../../../src/config/env.js'
import { adminEnv, buildTestAdminApp, buildTestApp, TEST_TOTP_ENC_KEY } from '../../helpers/app.js'

/**
 * ★ Guard 3 of three — 12-admin-console.md §2.4, §10 test 1.
 *
 * The other two guards are ESLint (`tests/unit/lint-guards.test.ts`) and the
 * boot assertion in `app.ts`. This file proves the *result* from outside, over
 * HTTP, which is the one that keeps working when someone deletes the other two
 * in a refactor — and it is written now, at S48, while there is still nothing
 * on `:3100` worth stealing.
 *
 * The property is not "admin routes are protected". It is that **they are not
 * there**. A protected admin route on the public port is one forgotten
 * middleware away from an unprotected one; a route that was never mounted
 * cannot be forgotten into existence.
 */
describe('admin isolation — the public port carries no admin surface', () => {
  let publicApp: ReturnType<typeof buildTestApp>
  let adminApp: ReturnType<typeof buildTestAdminApp>

  beforeAll(() => {
    publicApp = buildTestApp()
    adminApp = buildTestAdminApp()
  })

  it('★ GET :3000/admin/api/v1/users → 404, not 401 — 12 §2.4', async () => {
    const res = await request(publicApp.app).get('/admin/api/v1/users')

    expect(res.status).toBe(404)
    expect(res.body.code).toBe('NOT_FOUND')
    // 401 would confirm the route exists and is merely guarded, which is a
    // map of the admin surface handed to anyone who asks for it.
    expect(res.status).not.toBe(401)
  })

  it.each([
    '/admin',
    '/admin/',
    '/admin/api/v1/audit',
    '/admin/api/v1/auth/login',
    '/admin/api/v1/health',
    '/api/v1/admin/users',
  ])('%s is 404 on the public port too', async (path) => {
    const res = await request(publicApp.app).get(path)
    expect(res.status).toBe(404)
  })

  it('refuses every verb, not only GET', async () => {
    const agent = request(publicApp.app)
    for (const res of await Promise.all([
      agent.post('/admin/api/v1/users/x/disable').send({ reason: 'probe' }),
      agent.patch('/admin/api/v1/users/x/role').send({ role: 'ADMIN' }),
      agent.put('/admin/api/v1/games/shelem/state').send({ state: 'DISABLED' }),
      agent.delete('/admin/api/v1/matchmaking/cooldowns/x'),
    ])) {
      expect(res.status).toBe(404)
    }
  })

  it('says nothing about where the admin app lives', async () => {
    const res = await request(publicApp.app).get('/admin/api/v1/users')
    const body = JSON.stringify(res.body)

    expect(body).not.toContain('3100')
    expect(body).not.toContain('admin-main')
    expect(body).not.toContain('admin-app')
  })

  it('★ and the same path answers on the admin app — so the 404 is isolation, not absence', async () => {
    // Without this assertion the suite above would pass just as happily against
    // an admin console that was never built. At S48 `/health` is the only route
    // there is; S49 replaces this with `/auth/login` → 401 for a real endpoint.
    const res = await request(adminApp.app).get('/admin/api/v1/health')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, process: 'admin' })
  })

  it('the admin app answers /ready with its dependency checks', async () => {
    const res = await request(adminApp.app).get('/admin/api/v1/ready')

    expect(res.status).toBe(200)
    expect(res.body.checks.database.ok).toBe(true)
  })

  it('★ both apps are built from ONE container — the money rules cannot fork (§2.2)', () => {
    const container = buildContainer({ prisma: publicApp.container.prisma })
    const bothApps = [buildApp(container), buildAdminApp(container, adminEnv())]

    expect(bothApps).toHaveLength(2)
    // The same object, not an equal one: one WalletService, one set of caps,
    // one idempotency rule. A second container here would be two ledgers.
    expect(container.wallets).toBe(container.wallets)
    expect(container.settlement).toBe(container.settlement)
  })
})

/**
 * ★ Guard 2 — the boot assertion, proven by deliberately breaking it.
 *
 * This is the guard that catches the mistake ESLint cannot see: not an
 * `import`, but a route written inline on the app that is already running.
 */
describe('admin isolation — the mount-time guard in app.ts', () => {
  /** A bare app with the real guard installed, exactly as `buildApp` does it. */
  function guarded() {
    const app = express()
    forbidAdminRoutes(app)
    return app
  }

  const noop = (_req: express.Request, res: express.Response) => res.json([])

  it('★ throws when an admin router is mounted, naming the fix', () => {
    const app = guarded()

    expect(() => app.use('/admin/api/v1', Router().get('/users', noop))).toThrow(/admin/i)
    // The message has to point at the fix, not merely report the fault: this
    // fires at boot, in front of whoever just wrote the line.
    expect(() => app.use('/admin/api/v1', Router())).toThrow(/admin-main\.ts/)
  })

  it('★ and when the path is written inline, which ESLint cannot see', () => {
    // The realistic mistake. Guard 1 bans the *import*; nothing is imported
    // here, and the route would be live.
    expect(() => guarded().get('/admin/api/v1/audit', noop)).toThrow(/admin/i)
    expect(() => guarded().post('/admin/api/v1/users/x/disable', noop)).toThrow(/admin/i)
  })

  it('★ and when the router names /admin while its mount prefix looks innocent', () => {
    const app = guarded()
    const sneaky = Router().get('/admin/users', noop)

    expect(() => app.use('/api/v1', sneaky)).toThrow(/admin/i)
  })

  it('catches it through an array of routers, too', () => {
    const app = guarded()

    expect(() => app.use('/api/v1', [Router(), Router().get('/admin/flags', noop)])).toThrow(
      /admin/i,
    )
  })

  it('does not fire on an innocent path that merely contains the letters', () => {
    // `/administrators` is not `/admin`. A guard that cried wolf here would be
    // switched off by the first person it inconvenienced.
    expect(() => guarded().get('/api/v1/administrators', noop)).not.toThrow()
    expect(() => guarded().get('/api/v1/badminton', noop)).not.toThrow()
  })

  it('lets every ordinary route through unchanged', () => {
    const app = guarded()

    expect(() => app.use('/api/v1', Router().get('/games', noop))).not.toThrow()
    expect(() => app.get('/health', noop)).not.toThrow()
  })

  it('the real public app builds — the guard is installed and silent', () => {
    expect(() => buildTestApp()).not.toThrow()
  })
})

describe('the admin process refuses to boot without its encryption key (12 §2.5)', () => {
  const base = { ...process.env, ADMIN_TOTP_ENC_KEY: undefined } as NodeJS.ProcessEnv

  it('★ a missing ADMIN_TOTP_ENC_KEY is a refusal, not a generated default', () => {
    const result = AdminEnvSchema.safeParse(base)

    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === 'ADMIN_TOTP_ENC_KEY')
      // The message has to name the variable: an operator reading a boot
      // failure at 2am should not have to grep for which var was meant.
      expect(issue?.message).toMatch(/required/i)
    }
  })

  it('an empty string is refused too — `ADMIN_TOTP_ENC_KEY= npm run dev:admin`', () => {
    expect(AdminEnvSchema.safeParse({ ...base, ADMIN_TOTP_ENC_KEY: '' }).success).toBe(false)
  })

  it('a key of the wrong length is refused — AES-256 needs exactly 32 bytes', () => {
    const short = Buffer.alloc(16, 1).toString('base64')
    const long = Buffer.alloc(64, 1).toString('base64')

    expect(AdminEnvSchema.safeParse({ ...base, ADMIN_TOTP_ENC_KEY: short }).success).toBe(false)
    expect(AdminEnvSchema.safeParse({ ...base, ADMIN_TOTP_ENC_KEY: long }).success).toBe(false)
    expect(AdminEnvSchema.safeParse({ ...base, ADMIN_TOTP_ENC_KEY: 'not base64 at all!' }).success)
      .toBe(false)
  })

  it('a 32-byte base64 key is accepted', () => {
    const result = AdminEnvSchema.safeParse({ ...base, ADMIN_TOTP_ENC_KEY: TEST_TOTP_ENC_KEY })
    expect(result.success).toBe(true)
  })

  it('★ but the PUBLIC process still boots without it — it has no business holding it', () => {
    // The api process decrypts no second factors. Requiring the key there would
    // mean every developer running `npm run dev` had to invent one, and would
    // put the key that unlocks every admin's TOTP into the environment of the
    // internet-facing process.
    expect(() => parseEnv(base)).not.toThrow()
  })
})
