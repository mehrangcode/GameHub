import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { prismaCli } from './bin.js'

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const schema = resolve(backendRoot, 'prisma/schema.prisma')
const testDb = resolve(backendRoot, 'prisma/test.db')

/**
 * Integration tests run against a real SQLite file so the unique constraints
 * they assert are the *database's* constraints, not a fake's. The file is
 * rebuilt from scratch each run.
 */
export async function setup(): Promise<void> {
  if (!existsSync(schema)) return // schema arrives in S04; unit tests still run

  for (const suffix of ['', '-journal']) {
    const path = `${testDb}${suffix}`
    if (existsSync(path)) rmSync(path)
  }

  // No --force-reset: the file above is already gone, so `db push` recreates it
  // from scratch. (The flag also trips Prisma's destructive-action guard.)
  //
  // Invoked as `node <prisma cli>` rather than `npx prisma`: Node's spawnSync
  // does no PATHEXT resolution, so `npx` is ENOENT on Windows, and `.bin` shims
  // are platform-specific anyway. See tests/bin.ts.
  execFileSync(process.execPath, [prismaCli(), 'db', 'push', '--skip-generate'], {
    cwd: backendRoot,
    stdio: 'pipe',
    env: {
      ...process.env,
      DATABASE_PROVIDER: 'sqlite',
      DATABASE_URL: 'file:./test.db',
    },
  })
}
