/**
 * Installs the repository's git hooks (02-technical-prd.md §4.1 step 5).
 *
 * The pre-commit hook runs `contracts:check` in every project that has been
 * installed, so a drifted mirror is caught before it reaches CI. Run once per
 * clone: `npm run hooks:install` from backend/.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The hook calls `node` on the check scripts directly rather than going through
 * `npm run`.
 *
 * Two reasons, both learned the hard way. `npm run` resolves binaries through
 * `node_modules/.bin`, which is platform-specific — a `node_modules` installed
 * under WSL has no `.cmd` shims, so committing from a Windows client fails with
 * "'tsx' is not recognized". And it spawns two extra processes on every commit
 * for no benefit. Both check scripts resolve their own paths from
 * `import.meta.url`, so the working directory is irrelevant.
 */
const HOOK = `#!/bin/sh
# Managed by backend/scripts/install-hooks.mjs — regenerate with \`npm run hooks:install\`.
set -e

root="$(git rev-parse --show-toplevel)"

if ! command -v node >/dev/null 2>&1; then
  echo "pre-commit: 'node' is not on PATH, so the contracts check could not run."
  echo "Refusing rather than skipping — the check exists to stop a drifted mirror"
  echo "reaching CI. Commit from a shell where node is available."
  exit 1
fi

status=0

run_check() {
  label="$1"
  script="$2"
  shift 2
  [ -f "$root/$script" ] || return 0
  if ! node "$root/$script" "$@" >/dev/null; then
    echo "pre-commit: contracts:check failed in $label (see above)."
    status=1
  fi
}

run_check backend        backend/scripts/sync-contracts.mjs   --check
run_check frontend       frontend/scripts/check-contracts.mjs
run_check admin-frontend admin-frontend/scripts/check-contracts.mjs

if [ "$status" -ne 0 ]; then
  echo ""
  echo "If the mirrors drifted: run 'npm run contracts:sync' in backend/ and stage the result."
  exit 1
fi
`

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const hooksDir = join(repoRoot, '.githooks')

mkdirSync(hooksDir, { recursive: true })
const hookPath = join(hooksDir, 'pre-commit')
writeFileSync(hookPath, HOOK, 'utf8')
chmodSync(hookPath, 0o755)

execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: repoRoot })

console.log(`Installed ${hookPath}`)
console.log('git core.hooksPath → .githooks')
