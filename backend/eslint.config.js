// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

/**
 * The three load-bearing architecture guards (11-build-plan.md S01).
 * A fourth — the `interface/admin/**` import ban — arrives in S48.
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
