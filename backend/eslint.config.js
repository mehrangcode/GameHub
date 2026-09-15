// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

/**
 * The four load-bearing architecture guards (11-build-plan.md S01, S48).
 *
 * These are not style rules. Deleting one of them silently re-opens an
 * architectural hole, which is why tests/unit/lint-guards.test.ts proves
 * each of them actually rejects a deliberate violation.
 */

/** Guard 1 — 02-technical-prd.md §5.1 */
const INFRA_IMPORT_BAN = {
  group: ['**/infrastructure/**', '@prisma/client', '.prisma/*'],
  message:
    'domain/ and application/ must not import infrastructure or Prisma (02-technical-prd.md §5.1). ' +
    'Depend on a repository interface in domain/repositories/ instead.',
}

/** Guard 3 — 05-game-engine-spec.md §2.1, the E5 chips≠coins boundary */
const ECONOMY_IMPORT_BAN = {
  group: [
    '**/application/**',
    '**/*wallet*',
    '**/*Wallet*',
    '**/*reward*',
    '**/*Reward*',
    '**/*matchmaking*',
    '**/*Matchmaking*',
  ],
  message:
    'domain/games/** may not import application/ or anything wallet/reward/matchmaking related. ' +
    'Table chips are not wallet coins (10-economy-and-rewards.md E5) and engines never see money.',
}

/**
 * ★ Guard 4 — 12-admin-console.md §2.4, layer 1 of three (S48).
 *
 * The public app may not reach the admin routers. Not "should not": an import
 * is the only way `app.ts` could mount one, so banning the import removes the
 * mechanism rather than relying on review to notice it.
 *
 * The ban is **one-directional**. `interface/admin/**` importing
 * `interface/http/middleware/error.js` is correct and intended — the two apps
 * must agree on what an error, a request id and a validated body look like, and
 * forking that would give the console its own error taxonomy within a month.
 */
const ADMIN_IMPORT_BAN = {
  // Matched against the **import string as written**, not the resolved path, so
  // the patterns have to cover every way a relative path can reach the folder:
  // `./admin/…`, `../../admin/…`, `../../interface/admin/…`. A single
  // `**/interface/admin/**` would miss `../../admin/middleware/x.js` entirely,
  // which is how a ban ends up passing its own test and catching nothing —
  // `tests/unit/lint-guards.test.ts` lints that exact string for this reason.
  group: ['**/admin/**', 'admin/**', '**/admin-app*', '**/admin-main*'],
  message:
    'The public app must not import interface/admin/** (12-admin-console.md §2.4). ' +
    'Admin routers are mounted by admin-main.ts on :3100 alone. If you are adding a role ' +
    'check to a route on :3000, the route belongs in interface/admin/ instead.',
}

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'prisma/generated/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['error', 'warn'] }],
    },
  },

  // ── Guard 1: the dependency direction ────────────────────────────────────
  {
    files: ['src/domain/**/*.ts', 'src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [INFRA_IMPORT_BAN] }],
    },
  },

  // ── Guard 2: no ambient randomness in the domain (05 §3) ─────────────────
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='Math'][property.name='random']",
          message:
            'Math.random() is banned in domain/ (05-game-engine-spec.md §3). ' +
            'Engines take an injected Rng; shuffle is Fisher-Yates over rng.int(i + 1).',
        },
        /**
         * ★ The other half of invariant I1, added at S31.
         *
         * Randomness was banned from the domain at S01 and time was not, which
         * left half an invariant enforced. Phase H is exactly when that gap
         * would be filled by accident: turn limits are a *declaration* on
         * `GameMeta` and are enforced by `TurnTimerService`, and the tempting
         * shortcut — an engine checking how long a player has been thinking —
         * would make a replay of `(seed, moves[])` stop reproducing the match.
         * Time comes in through `application/ports/clock.ts`, in the service
         * layer, or not at all.
         */
        {
          selector: "MemberExpression[object.name='Date'][property.name='now']",
          message:
            'Date.now() is banned in domain/ (05-game-engine-spec.md §2, invariant I1). ' +
            'Engines are pure and deterministic: time is injected, and turn limits are ' +
            'declared in GameMeta and enforced by TurnTimerService.',
        },
        {
          selector: "NewExpression[callee.name='Date']",
          message:
            'new Date() is banned in domain/ (05-game-engine-spec.md §2, invariant I1). ' +
            'A state holding a Date also breaks I5 (JSON-serializable) — use an ISO string ' +
            'or a number supplied by the caller.',
        },
      ],
    },
  },

  // ── Guard 3: engines never see money (E5) ────────────────────────────────
  // Repeats guard 1's pattern because a later flat-config block replaces the
  // whole rule option rather than merging with it.
  {
    files: ['src/domain/games/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [INFRA_IMPORT_BAN, ECONOMY_IMPORT_BAN] }],
    },
  },

  // ── Guard 4: the admin console stays off the public port ─────────────────
  {
    files: [
      'src/app.ts',
      'src/main.ts',
      'src/interface/http/**/*.ts',
      'src/interface/socket/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', { patterns: [ADMIN_IMPORT_BAN] }],
    },
  },

  // Scripts, tests and the seed are tooling: they may talk to Prisma directly
  // and they are allowed to print.
  {
    files: ['scripts/**', 'tests/**', 'prisma/**', '*.js', '*.mjs', '*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
)
