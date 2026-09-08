import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `contracts/` is copied verbatim into two other projects and is meant to be
 * publishable as a standalone package later. Both properties depend on it
 * containing nothing but types, Zod schemas and `const` — no Node built-ins,
 * no runtime logic, no reach into the rest of the backend.
 */
const contractsDir = join(process.cwd(), 'src/contracts')

function listTs(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return listTs(full)
    return entry.endsWith('.ts') ? [full] : []
  })
}

const files = listTs(contractsDir)

describe('contracts purity', () => {
  it('contains at least the enum, error and event modules', () => {
    const names = files.map((f) => relative(contractsDir, f).replaceAll('\\', '/'))
    expect(names).toEqual(
      expect.arrayContaining(['enums.ts', 'errors.ts', 'events.ts', 'index.ts']),
    )
  })

  it.each(files)('%s imports nothing Node-only and nothing outside contracts/', (file) => {
    const source = readFileSync(file, 'utf8')
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '')

    for (const spec of specifiers) {
      expect(spec, `${spec} is a Node built-in`).not.toMatch(/^node:/)
      expect(['fs', 'path', 'crypto', 'os', 'url', 'child_process']).not.toContain(spec)
      // Only zod and same-directory relatives are allowed.
      const allowed = spec === 'zod' || spec.startsWith('./')
      expect(allowed, `${spec} is not allowed in contracts/`).toBe(true)
    }
  })

  it.each(files)('%s declares no runtime logic', (file) => {
    const source = readFileSync(file, 'utf8')
    expect(source, 'no function declarations').not.toMatch(/^\s*(export\s+)?function\s/m)
    expect(source, 'no classes').not.toMatch(/^\s*(export\s+)?(abstract\s+)?class\s/m)
    expect(source, 'no top-level side effects').not.toMatch(/^\s*console\./m)
  })
})
