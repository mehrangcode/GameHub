/**
 * The frontend half of the contract drift guard (02-technical-prd.md §4.1).
 *
 * The backend's `contracts:check` compares the mirror against the canonical
 * source. This one needs no access to the backend at all: it recomputes the
 * SHA-256 of the mirror's own contents and compares it to the `contracts.hash`
 * stamped at sync time. That is enough to catch a hand-edited mirror, and it
 * keeps this project independently buildable in CI.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mirror = join(root, 'src/contracts')
const HASH_FILE = 'contracts.hash'

if (!existsSync(mirror)) {
  console.error(`\ncontracts:check — src/contracts is missing.`)
  console.error('Run `npm run contracts:sync` in backend/.\n')
  process.exit(1)
}

/** @type {Map<string, string>} */
const files = new Map()
const walk = (dir) => {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full)
      continue
    }
    if (!entry.endsWith('.ts')) continue
    files.set(relative(mirror, full).split(sep).join('/'), readFileSync(full, 'utf8'))
  }
}
walk(mirror)

const hash = createHash('sha256')
for (const rel of [...files.keys()].sort()) {
  hash.update(rel)
  hash.update('\0')
  hash.update(files.get(rel))
  hash.update('\0')
}
const actual = hash.digest('hex')

const hashPath = join(mirror, HASH_FILE)
const stored = existsSync(hashPath) ? readFileSync(hashPath, 'utf8').trim() : ''

if (stored !== actual) {
  console.error('\nContract drift detected in frontend/src/contracts:\n')
  console.error(`  expected ${stored || '(no contracts.hash)'}`)
  console.error(`  actual   ${actual}`)
  const unstamped = [...files.entries()].filter(
    ([, content]) => !content.startsWith('// AUTO-GENERATED FROM backend/src/contracts'),
  )
  for (const [rel] of unstamped) {
    console.error(`  ✗ src/contracts/${rel} is missing the DO-NOT-EDIT header`)
  }
  console.error('\nThis directory is generated. Edit backend/src/contracts and run')
  console.error('`npm run contracts:sync` in backend/.\n')
  process.exit(1)
}

console.log(`contracts:check — ${files.size} mirrored file(s) in sync`)
