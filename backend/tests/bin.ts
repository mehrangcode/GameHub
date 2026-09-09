import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

/**
 * Resolves a dependency's CLI **entry script**, so it can be run as
 * `node <script>` instead of through `node_modules/.bin`.
 *
 * This is the same lesson S178 learned in the pre-commit hook, applied to the
 * test harness. `execFileSync('npx', …)` and `execFileSync('tsx', …)` both fail
 * on Windows with `ENOENT`, for two compounding reasons:
 *
 *   1. Node's `spawn`/`spawnSync` do **not** perform PATHEXT resolution. On
 *      Windows `npx` is `npx.cmd`, and without `shell: true` Node looks for a
 *      file literally named `npx` and gives up.
 *   2. `node_modules/.bin` shims are written per platform at install time. A
 *      tree installed from WSL has POSIX shell scripts and no `.cmd` files at
 *      all, so even `shell: true` would not find them.
 *
 * Running `process.execPath <resolved .js>` sidesteps both: no shim, no PATH,
 * no shell — identical behaviour on Linux, macOS and Windows.
 */
const require = createRequire(import.meta.url)

export function binOf(pkg: string, binName = pkg): string {
  const manifestPath = require.resolve(`${pkg}/package.json`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    bin?: string | Record<string, string>
  }
  const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName]
  if (!entry) throw new Error(`${pkg} declares no bin entry named "${binName}"`)
  return resolve(dirname(manifestPath), entry)
}

/** The Prisma CLI, for `db push` in the test global setup. */
export const prismaCli = (): string => binOf('prisma')

/** The tsx CLI, for running the TypeScript seed as a child process. */
export const tsxCli = (): string => binOf('tsx')
