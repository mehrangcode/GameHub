// AUTO-GENERATED FROM backend/src/contracts — DO NOT EDIT
// Run `npm run contracts:sync` in backend/ to regenerate.

/**
 * ★ CANONICAL contracts — 02-technical-prd.md §4.1.
 *
 * `frontend/src/contracts/` is a generated mirror of this directory; run
 * `npm run contracts:sync` after any change here. `contracts:check` fails the
 * build (and the pre-commit hook) when the two drift.
 *
 * Rules for everything in this directory:
 *   - types, Zod schemas and `const` only — no runtime logic
 *   - no Node-only imports (`node:fs`, `node:crypto`, …), so the directory
 *     stays publishable as a standalone package later
 */
export * from './enums.js'
export * from './errors.js'
export * from './events.js'
export * from './dto/index.js'
