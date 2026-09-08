/**
 * Keeps `datasource db { provider }` in step with `DATABASE_PROVIDER`.
 *
 * 02-technical-prd.md §6.1 specifies `provider = env("DATABASE_PROVIDER")`, but
 * **Prisma rejects that** — "A datasource must not use the env() function in
 * the provider argument" (P1012). The provider must be a literal.
 *
 * Rather than fork the schema into a SQLite copy and a Postgres copy — two
 * files that would drift the first time a column is added under time pressure —
 * one line of the single canonical schema is machine-managed. Every `db:*`
 * script runs this first, so the schema always matches the environment it is
 * about to be applied to, and the rest of the file stays hand-written and
 * reviewable.
 */
import 'dotenv/config'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SUPPORTED = ['sqlite', 'postgresql']

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '../prisma/schema.prisma')
const provider = process.env.DATABASE_PROVIDER ?? 'sqlite'

if (!SUPPORTED.includes(provider)) {
  console.error(
    `DATABASE_PROVIDER must be one of ${SUPPORTED.join(' | ')} — got "${provider}".\n` +
      'The schema targets the SQLite ∩ PostgreSQL intersection and nothing else.',
  )
  process.exit(1)
}

const source = readFileSync(schemaPath, 'utf8')
const pattern = /(datasource\s+db\s*\{[^}]*?provider\s*=\s*)"[^"]*"/

if (!pattern.test(source)) {
  console.error('Could not find `provider = "…"` inside the datasource block.')
  process.exit(1)
}

const next = source.replace(pattern, `$1"${provider}"`)
if (next !== source) {
  writeFileSync(schemaPath, next, 'utf8')
  console.log(`prisma: datasource provider → ${provider}`)
}
