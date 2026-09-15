import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { prismaCli } from './bin.js'

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const schema = resolve(backendRoot, 'prisma/schema.prisma')
const testDb = resolve(backendRoot, 'prisma/test.db')
const providerScript = resolve(backendRoot, 'scripts/prisma-provider.mjs')

/**
 * The engine under test. SQLite by default, so a bare `npm test` is unchanged;
 * `DATABASE_PROVIDER=postgresql` runs the identical suite against Postgres,
 * which is 11 §12 S45's third test bullet and the only way the schema's
 * SQLite ∩ PostgreSQL discipline (03 §1) is measured rather than asserted.
 */
const provider = process.env.DATABASE_PROVIDER ?? 'sqlite'
const url = process.env.DATABASE_URL ?? 'file:./test.db'

/**
 * Integration tests run against a real database so the unique constraints they
 * assert are the *database's* constraints, not a fake's. It is rebuilt from
 * scratch each run.
 */
export async function setup(): Promise<void> {
  if (!existsSync(schema)) return // schema arrives in S04; unit tests still run

  const env = { ...process.env, DATABASE_PROVIDER: provider, DATABASE_URL: url }

  // `datasource db { provider }` must be a string literal — Prisma rejects
  // env() there (P1012), which is why scripts/prisma-provider.mjs exists and
  // every `db:*` script runs it first. This harness has to as well, or a
  // Postgres run would push the schema at a datasource still saying "sqlite".
  execFileSync(process.execPath, [providerScript], { cwd: backendRoot, stdio: 'pipe', env })

  if (provider === 'sqlite') {
    for (const suffix of ['', '-journal']) {
      const path = `${testDb}${suffix}`
      if (existsSync(path)) rmSync(path)
    }
  }

  // SQLite needs no --force-reset: the file above is already gone, so `db push`
  // recreates it from scratch, and the flag trips Prisma's destructive-action
  // guard besides. Postgres has no file to delete, so the reset is how its
  // schema gets rebuilt between runs.
  //
  // Invoked as `node <prisma cli>` rather than `npx prisma`: Node's spawnSync
  // does no PATHEXT resolution, so `npx` is ENOENT on Windows, and `.bin` shims
  // are platform-specific anyway. See tests/bin.ts.
  const reset = provider === 'sqlite' ? [] : ['--force-reset', '--accept-data-loss']

  execFileSync(process.execPath, [prismaCli(), 'db', 'push', '--skip-generate', ...reset], {
    cwd: backendRoot,
    stdio: 'pipe',
    env,
  })
}
