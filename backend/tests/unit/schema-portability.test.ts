import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The schema must apply unchanged to SQLite (dev) and PostgreSQL (prod), so it
 * targets the intersection of the two — 02 §6.2, 03 §1. Parsing the file as
 * text is deliberate: it catches an engine-specific construct the moment it is
 * written, not on the day of the first Postgres deploy.
 */
const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8')

/** Lines with the comment portion removed, so prose about `enum` doesn't trip it. */
const codeLines = schema
  .split('\n')
  .map((line) => line.replace(/\/{2,3}.*$/, '').trimEnd())
  .filter((line) => line.trim().length > 0)

describe('schema portability', () => {
  it('declares no Prisma enum — SQLite has none', () => {
    const offenders = codeLines.filter((l) => /^\s*enum\s+\w+/.test(l))
    expect(offenders).toEqual([])
  })

  it('declares no scalar list — SQLite has no arrays', () => {
    const scalars = ['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json', 'Bytes', 'BigInt']
    const pattern = new RegExp(`^\\s*\\w+\\s+(${scalars.join('|')})\\[\\]`)
    const offenders = codeLines.filter((l) => pattern.test(l))
    expect(offenders).toEqual([])
  })

  it('uses no Decimal — currency in floating point is how ledgers stop balancing', () => {
    const offenders = codeLines.filter((l) => /^\s*\w+\s+Decimal\b/.test(l))
    expect(offenders).toEqual([])
  })

  it('uses no native type attributes', () => {
    const offenders = codeLines.filter((l) => l.includes('@db.'))
    expect(offenders).toEqual([])
  })

  it('uses no Postgres-only JSON columns', () => {
    const offenders = codeLines.filter((l) => /^\s*\w+\s+Json\b/.test(l))
    expect(offenders).toEqual([])
  })

  it('keeps the datasource provider a literal from the supported pair', () => {
    // Prisma rejects env() in `provider` (P1012); scripts/prisma-provider.mjs
    // keeps this literal in step with DATABASE_PROVIDER instead.
    const match = schema.match(/datasource\s+db\s*\{[\s\S]*?provider\s*=\s*"([^"]+)"/)
    expect(match?.[1]).toBeDefined()
    expect(['sqlite', 'postgresql']).toContain(match?.[1])
  })

  it('ids are cuid strings', () => {
    const idLines = codeLines.filter((l) => /@id\b/.test(l) && !/@@/.test(l))
    expect(idLines.length).toBeGreaterThan(20)
    for (const line of idLines) {
      const isCuid = line.includes('@default(cuid())')
      /**
       * Catalog and flag models use a hand-written stable key as their id, by
       * design: `GameFlag.slug` must equal a `domain/games/registry.ts` slug
       * and `PlatformFlag.key` a known flag name, so a generated cuid would be
       * an id nobody could write down, plus a second unique column to look the
       * row up by. The rule this still enforces is the portable one — a
       * `String` id, never a database-generated integer or a native type.
       */
      const isStableSlug = /^\s*(id|userId|slug|key)\s+String\s+@id\s*$/.test(line)
      expect(isCuid || isStableSlug, `unexpected id declaration: ${line.trim()}`).toBe(true)
    }
  })
})
