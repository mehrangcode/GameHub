import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const backendRoot = process.cwd()
const mirror = resolve(backendRoot, '../frontend/src/contracts')

function run(args: string[]): { code: number; output: string } {
  try {
    const output = execFileSync('node', ['scripts/sync-contracts.mjs', ...args], {
      cwd: backendRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    })
    return { code: 0, output }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

function listTs(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return listTs(full)
    return entry.endsWith('.ts') ? [full] : []
  })
}

describe('contracts sync + drift guard', () => {
  beforeAll(() => {
    expect(run([]).code).toBe(0)
  })

  afterAll(() => {
    run([])
  })

  it('syncs, then checks clean', () => {
    expect(run([]).code).toBe(0)
    expect(run(['--check']).code).toBe(0)
  })

  it('stamps every mirrored file with the DO-NOT-EDIT header', () => {
    const files = listTs(mirror)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      expect(readFileSync(file, 'utf8')).toMatch(
        /^\/\/ AUTO-GENERATED FROM backend\/src\/contracts — DO NOT EDIT/,
      )
    }
  })

  it('writes a contracts.hash alongside the mirror', () => {
    const hash = readFileSync(join(mirror, 'contracts.hash'), 'utf8').trim()
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('fails with a non-zero exit and names the file when the mirror is tampered with', () => {
    appendFileSync(join(mirror, 'index.ts'), '\n// tampered\n')

    const result = run(['--check'])
    expect(result.code).toBe(1)
    expect(result.output).toContain('index.ts')
    expect(result.output).toMatch(/drift/i)
  })

  it('fails the same way in the frontend project', () => {
    // The mirror is still tampered from the previous test.
    let code = 0
    try {
      execFileSync('node', ['scripts/check-contracts.mjs'], {
        cwd: resolve(backendRoot, '../frontend'),
        stdio: 'pipe',
      })
    } catch (e) {
      code = (e as { status?: number }).status ?? 1
    }
    expect(code).toBe(1)
  })

  it('restores green after a re-sync', () => {
    expect(run([]).code).toBe(0)
    expect(run(['--check']).code).toBe(0)
  })
})
