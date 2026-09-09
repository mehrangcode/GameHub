# Active Task — Build the platform, session by session

**Goal:** ship M0–M8 plus MA of the board game platform in ~2–3 hour sessions, each ending with something
Mehrang has verified himself.

**Full session catalog:** [`Documents/11-build-plan.md`](../../../Documents/11-build-plan.md).
This file is the roadmap checklist only — the *why*, *what to build*, *tests*, and *how you verify*
for each session live in that document. Do not duplicate them here.

**Milestone authority:** [`Documents/08-roadmap.md`](../../../Documents/08-roadmap.md).
**Architecture authority:** [`Documents/02-technical-prd.md`](../../../Documents/02-technical-prd.md).

---

## Acceptance criteria for the current milestone (M0)

From `08-roadmap.md` M0 exit criteria. All of these must be true before M1 starts:

- [ ] Host signs up, creates a table, copies an invite link
- [ ] Friend opens the link in a private window, types a name, is seated — no account created
- [ ] Both see each other join live; chat works both ways
- [ ] Guest refreshes and keeps their seat
- [ ] Guest signs up mid-session and lands back at the same table in the same seat (J2)
- [ ] The guest's provisional coins vest into the new account in the same transaction
- [ ] An idle player is warned, struck twice, ejected, and replaced by a bot — the table plays on
- [ ] An ejected player on a winning team earns 0; their partner earns full (J5)
- [ ] Ledger reconciliation runs clean; a deliberately corrupted balance is detected and alerted
- [ ] Restarting the API loses neither table nor seat, and turn deadlines re-arm without gifting time
- [ ] Welcome page renders cards from `GET /api/v1/games`
- [ ] Every screen reviewed in `fa`/RTL — nothing clipped or wrongly mirrored
- [ ] `contracts:check` green in both CI pipelines
- [ ] Deployed over HTTPS, with the restore-from-backup procedure actually tested once
- [ ] `GET :3000/admin/api/v1/users` returns 404; the same path on `:3100` returns 401
- [ ] The seeded admin can do nothing until TOTP is enrolled, and every admin read is audited

---

## M0 — 50 sessions

Tick when **Mehrang** has run the session's "You verify" steps, not when the code compiles.

### Phase A — Foundations
*Built and green (90 backend + 18 frontend tests). Awaiting Mehrang's "You verify" pass — see
`context.md` for the exact commands and the two caveats.*
- [ ] S01 Backend scaffold, TS strict, the three load-bearing lint rules
- [ ] S02 Frontend scaffold, Vite proxy, route stubs
- [ ] S03 `contracts/` + `contracts:sync` / `contracts:check`
- [ ] S04 Prisma schema I — identity, tables, seats, invites
- [ ] S05 Prisma schema II — games, chat, results, cosmetics, economy
- [ ] S06 Idempotent seed script

### Phase B — Domain & persistence
*Built and green (392 backend tests, up from 90). Awaiting Mehrang's "You verify" pass — see
`context.md` for the exact commands.*
- [ ] S07 Value objects, entities, `AppError` taxonomy
- [ ] S08 Repository interfaces + in-memory fakes
- [ ] S09 Prisma repositories + `UnitOfWork`
- [ ] S10 `container.ts`, `app.ts`, Pino redaction, `/health` + `/ready`

### Phase C — Auth
*Built and green (561 backend tests, up from 392). Awaiting Mehrang's "You verify" pass — see
`context.md` for the exact commands and the one `npm install` caveat.*
- [ ] S11 argon2id + JWT + cookie helpers
- [ ] S12 Zod validation, error middleware, helmet, CORS, rate limit
- [ ] S13 `POST /auth/register`, `/auth/login`, `GET /auth/me`
- [ ] S14 Refresh rotation with family revocation + `/auth/logout`
- [ ] S15 `SecurityEvent` audit log + metrics registry (no HTTP route — moved to S49)
- [ ] S16 Table-bound guest tokens — `POST /auth/guest`

### Phase D — Tables & invites
- [ ] S17 Game registry + `GET /games`, `/games/:slug`
- [ ] S18 Table CRUD
- [ ] S19 Invites — mint, revoke, `GET /invites/:code` unauthenticated
- [ ] S20 Seat claim/release, race-safe by unique constraint

### Phase E — Wallet & the claim transaction
- [ ] S21 Wallet credit path — derived idempotency, caps, `CAP_REJECTED`
- [ ] S22 ⭐ Guest→user claim transaction, all 12 steps

### Phase F — Sockets
- [ ] S23 Socket.IO gateway, handshake identity, `dev-socket.ts`
- [ ] S24 Room model, `table:join`, `table:snapshot`, seat broadcast
- [ ] S25 Presence, heartbeat, disconnect grace
- [ ] S26 Chat + emotes
- [ ] S27 Redis adapter, presence sets, rate limits, fallback

### Phase G — Event log
- [ ] S28 `GameInstance` + seed commitment + `GameEvent` append with `seq`
- [ ] S29 Snapshot policy, `rebuildState`, delta/full resync
- [ ] S30 The `_fixture` engine + `GameSessionService` move pipeline

### Phase H — Turn enforcement
- [ ] S31 `TurnTimerService` — absolute deadlines, `game:turnTimer`
- [ ] S32 Warning, strike ladder, default action, `strikesResetOnAction`
- [ ] S33 Ejection + bot substitution
- [ ] S34 Seat reclamation + timer re-arming on restart

### Phase I — Rewards
- [ ] S35 `RewardService.compute` — the pure policy function
- [ ] S36 ⭐ Settlement transaction — per-seat, idempotent, forfeiture
- [ ] S37 `GET /wallet`, `/wallet/transactions`, `wallet:updated`
- [ ] S38 Debit path with row lock, `GUEST_FORFEIT`, nightly reconciliation

### Phase J — Frontend
- [ ] S39 Axios instance, single-flight refresh, `authStore`, login/register
- [ ] S40 `tokens.css`, `themeStore`, i18n en+fa, `dir` switching
- [ ] S41 Welcome page — registry-driven preview cards
- [ ] S42 `socketStore` + socket manager + `seq` gap detection
- [ ] S43 ⭐ Invite landing → guest join
- [ ] S44 `TableShell` — seats, presence, chat, countdown ring, nudge

### Phase K — Ship
- [ ] S45 Dockerfiles + dev compose + CI for both projects
- [ ] S46 Prod compose, Caddy, Postgres migration, VPS deploy
- [ ] S47 ⭐ M0 exit-criteria walkthrough + tested backup restore

### Phase L — Admin spine (`Documents/12-admin-console.md` §11.1)
- [ ] S48 Admin schema + `admin-main.ts` + the three isolation guards
- [ ] S49 Admin auth: TOTP, forced enrollment, step-up, sessions
- [ ] S50 ⭐ The `withAudit` spine + first read endpoints + M0's admin gate

---

## M1–M8 and MA

Outlined in `Documents/11-build-plan.md` §14. Each milestone's first session is a planning pass that
expands its outline into full session specs. Do not start a milestone without that pass.

- [ ] M1 Sudoku (~11)
- [ ] M2 Blackjack (~15) — includes the admin ledger browser + reconciliation
- [ ] M3 Matchmaking (~17) — includes game flags + the control-command outbox
- [ ] M4 Shelem ⭐ (~26)
- [ ] M5 Poker (~21)
- [ ] M6 Chess (~13)
- [ ] M7 Store & Premium ⭐ (~21)
- [ ] MA Admin Console (~16) — sits between M7 and M8
- [ ] M8 Social & stats (~21)
