/**
 * The contract drift guard — 02-technical-prd.md §4.1.
 *
 *   npm run contracts:sync    copy + stamp + hash
 *   npm run contracts:check   exit non-zero if a mirror has drifted
 *
 * Two separate projects means the socket and DTO types are duplicated. This is
 * the one real cost of that layout, and it is managed here rather than by
 * discipline: a hand-edited mirror fails the build (CI and pre-commit) instead
 * of shipping as a runtime payload mismatch that both sides happily compile.
 *
 * One script, two destinations — `contracts/` mirrors to the player frontend,
 * `contracts/admin/` to the admin frontend when that project exists (MA).
 *
 * **Plain `.mjs`, deliberately.** 11-build-plan.md S03 specifies a `.ts` script,
 * but this one runs from the pre-commit hook, and a hook has to work from
 * whatever shell the developer commits in. `tsx` resolves through
 * `node_modules/.bin`, which is platform-specific — committing from Windows
 * against a WSL-installed `node_modules` finds no `tsx.cmd` and the hook fails
 * with a misleading "drift" message. Needing nothing but `node` removes a whole
 * class of "works on my shell" breakage, and this file has no types worth
 * having anyway.
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(backendRoot, '..')

const HEADER = [
  '// AUTO-GENERATED FROM backend/src/contracts — DO NOT EDIT',
  '// Run `npm run contracts:sync` in backend/ to regenerate.',
  '',
  '',
].join('\n')

const HASH_FILE = 'contracts.hash'

/**
 * @typedef {object} Destination
 * @property {string}   name
 * @property {string}   source      Canonical source directory.
 * @property {string}   target      Generated mirror.
 * @property {string[]} excludeDirs Directory names under `source` that do not belong in this mirror.
 * @property {boolean}  optional    Skip silently when the target project does not exist yet.
 */

/** @type {Destination[]} */
const destinations = [
  {
    name: 'frontend',
    source: join(backendRoot, 'src/contracts'),
    target: join(repoRoot, 'frontend/src/contracts'),
    excludeDirs: ['admin'],
    optional: false,
  },
  {
    name: 'admin-frontend',
    source: join(backendRoot, 'src/contracts/admin'),
    target: join(repoRoot, 'admin-frontend/src/contracts'),
    excludeDirs: [],
    optional: true,
  },
]

/**
 * @param {string} dir
 * @param {string[]} excludeDirs
 * @param {string} [base]
 * @returns {Map<string, string>}
 */
function collect(dir, excludeDirs, base = dir) {
  /** @type {Map<string, string>} */
  const files = new Map()
  if (!existsSync(dir)) return files

  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (excludeDirs.includes(entry)) continue
      for (const [rel, content] of collect(full, excludeDirs, base)) files.set(rel, content)
      continue
    }
    if (!entry.endsWith('.ts')) continue
    const rel = relative(base, full).split(sep).join('/')
    files.set(rel, HEADER + readFileSync(full, 'utf8'))
  }
  return files
}

/**
 * @param {Map<string, string>} files
 * @returns {string}
 */
function hashOf(files) {
  const hash = createHash('sha256')
  for (const rel of [...files.keys()].sort()) {
    hash.update(rel)
    hash.update('\0')
    hash.update(files.get(rel) ?? '')
    hash.update('\0')
  }
  return hash.digest('hex')
}

/**
 * @param {string} target
 * @returns {Map<string, string>}
 */
function readMirror(target) {
  /** @type {Map<string, string>} */
  const files = new Map()
  if (!existsSync(target)) return files

  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.endsWith('.ts')) continue
      files.set(relative(target, full).split(sep).join('/'), readFileSync(full, 'utf8'))
    }
  }
  walk(target)
  return files
}

/** @param {Destination} dest */
function sync(dest) {
  const expected = collect(dest.source, dest.excludeDirs)
  if (expected.size === 0 && dest.optional) return
  if (!existsSync(dirname(dest.target)) && dest.optional) return

  if (existsSync(dest.target)) rmSync(dest.target, { recursive: true })
  mkdirSync(dest.target, { recursive: true })

  for (const [rel, content] of expected) {
    const out = join(dest.target, rel)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, content, 'utf8')
  }
  writeFileSync(join(dest.target, HASH_FILE), hashOf(expected) + '\n', 'utf8')

  console.log(`  ✓ ${dest.name}: ${expected.size} file(s) → ${relative(repoRoot, dest.target)}`)
}

/**
 * @param {Destination} dest
 * @returns {string[]} human-readable problems, empty when in sync
 */
function check(dest) {
  const expected = collect(dest.source, dest.excludeDirs)
  if (expected.size === 0 && dest.optional) return []
  if (!existsSync(dirname(dest.target)) && dest.optional) return []

  /** @type {string[]} */
  const problems = []
  const mirrorPath = relative(repoRoot, dest.target)

  if (!existsSync(dest.target)) {
    return [`${mirrorPath} does not exist — run \`npm run contracts:sync\``]
  }

  const actual = readMirror(dest.target)

  for (const [rel, content] of expected) {
    const found = actual.get(rel)
    if (found === undefined) problems.push(`${mirrorPath}/${rel} is missing`)
    else if (found !== content)
      problems.push(`${mirrorPath}/${rel} has drifted from the canonical source`)
  }
  for (const rel of actual.keys()) {
    if (!expected.has(rel)) problems.push(`${mirrorPath}/${rel} is not in backend/src/contracts`)
  }

  const hashPath = join(dest.target, HASH_FILE)
  const storedHash = existsSync(hashPath) ? readFileSync(hashPath, 'utf8').trim() : ''
  if (storedHash !== hashOf(expected)) {
    problems.push(`${mirrorPath}/${HASH_FILE} does not match the canonical contents`)
  }

  return problems
}

const isCheck = process.argv.includes('--check')

if (isCheck) {
  const problems = destinations.flatMap(check)
  if (problems.length > 0) {
    console.error('\nContract drift detected:\n')
    for (const p of problems) console.error(`  ✗ ${p}`)
    console.error('\nRun `npm run contracts:sync` in backend/ to regenerate the mirrors.\n')
    process.exit(1)
  }
  console.log('contracts:check — mirrors are in sync')
} else {
  console.log('Syncing contracts…')
  for (const dest of destinations) sync(dest)
}
