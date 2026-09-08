# Live Context — read this first, every session

**Last updated:** 2026-09-08

## Where we are

| | |
|---|---|
| **Milestone** | M0 — Platform Skeleton |
| **Last session completed** | *none — planning only so far* |
| **Next session** | **S01 — Backend scaffold, TS strict, the three load-bearing lint rules** (3 h, 🖥️ CLI) |
| **Blocked on** | Nothing |
| **Repo state** | Documents only. No `backend/`, no `frontend/`, no `admin-frontend/`. One commit: `initial commit` |

Session spec for S01: `Documents/11-build-plan.md` §3.

## Session start protocol

1. Read this file.
2. Read the next session's spec in `Documents/11-build-plan.md`.
3. State the session id, its goal, and its **You verify** steps to Mehrang **before writing code**.
4. Build + test. Report real test output.
5. Mehrang runs the "You verify" steps himself. That is the gate.
6. Tick the boxes in `plan.md`, update this file, hand over a conventional commit message.
7. **Mehrang commits.** Never commit on his behalf.

## Decisions made in planning (2026-09-08)

| Decision | Value | Why |
|---|---|---|
| Session length | 2–3 focused hours | Mehrang's realistic evening budget |
| **Admin console specified** (2026-09-08) | New doc `Documents/12-admin-console.md`; M0 grows **Phase L (S48–S50)**, M2 +1, M3 +1, and a new milestone **MA** between M7 and M8 | The PRD set had a `role` column and two endpoints, nothing else. Four decisions locked: same codebase / separate entrypoint on an unpublished `:3100`; separate admin session with mandatory TOTP; append-only audit row written in the same transaction as the mutation; admin sees only the spectator projection of a live table |
| **MA is a letter, not M9** | Inserted between M7 and M8 | Avoids renumbering M8 and invalidating every existing cross-reference |
| Plan depth | M0 in full detail; M1–M8 as outlines | Detailing M4 now would be fiction — M1–M3 will change what we know about the engine pipeline |
| Plan location | Catalog in `Documents/11-build-plan.md` (committed, GitHub-readable); cursor here | Stable spec vs. live state |
| **`_fixture` engine added to M0** | `domain/games/_fixture/`, dev/test registry only | M0's exit criterion "an idle player is ejected and replaced by a bot" is untestable without a game, and Sudoku is M1. See `11-build-plan.md` §1 |
| Session ends green or unfinished | No 80%-done carry-forward | Same rule `08-roadmap.md` applies to games |

## Open questions inherited from the specs

These are unresolved in the PRD set and will need answers before the sessions that depend on them.
Source: `Documents/README.md` Status table.

| Question | Needed by | Documented default |
|---|---|---|
| `db push` vs dual migration folders for dev (`03` §8) | **S04** | `db push` for dev, real migrations for Postgres only |
| `ejectAfterStrikes`: 2 (spec default) or 1 (Mehrang's literal rule) (`04` §6.3) | **S32** | 2, as a table option — set to 1 for the strict rule |
| Should coins be purchasable for real money? (`10` §6.5) | M7, not M0 | No — coins earn-only, money buys the subscription |
| Shelem: match target, all-pass rule, point-card discards (`games/shelem.md` §0.4) | M4-S01 | Unsourced; a real match will settle them |
| Reward rates, prices, caps, multipliers (`10` §3–4) | S06 seeds them | A starting guess; all live in `RewardRule` rows so rebalancing is a row update |
| `SUPPORT` role — ever used by a solo operator? (`12` §12) | MA, not M0 | Ship the role + RBAC matrix, seed only `ADMIN` |
| Admin chat visibility: report-scoped or reporter-excerpt only? (`12` §12) | MA | Report-scoped and audited |
| Account deletion / anonymization (`12` §12) | Not v1 | Anonymize, never `DELETE` — a hard delete stops the ledger reconciling |
| Audit-log retention (`12` §12) | Later | Indefinite; the hash chain makes pruning need a checkpoint |
| Alerting channel for `SecurityEvent` and ledger drift (`12` §12) | MA | None in v1 — console only |

## Notes for next session

- S01's most important outcome is not the server booting — it's **proving the three ESLint guards
  actually fire**. The spec includes the deliberate-violation commands; run them.
- Set up `backend/requests/*.http` from S10 onward and keep adding to it. Every later session's
  verification leans on it.
- `scripts/dev-socket.ts` (built in S23) is the verification tool for sessions S23–S38. Budget time
  to make it genuinely pleasant to use.
- **S15 changed:** it now builds the `SecurityEvent` recorder and the metrics registry but exposes
  **no HTTP route**. `/metrics` and `/security-events` move to the admin process in S49. If S15 ends
  with an `/admin` path mounted on `:3000`, it was done wrong.
- **A fourth ESLint guard lands in S48**, not S01: the ban on `interface/admin/**` imports from the
  public app. It gets the same deliberate-violation proof S01 uses for the other three.
- M0 is not closed at S47 any more — **S50 is the gate**, because two of M0's exit criteria are now
  admin criteria.
