Phase C (S11–S16) of M0 is built and green.

**561 backend tests · typecheck · lint · contracts:check — all green.** Up from 392. The whole auth
surface exists: register, login, `/auth/me`, refresh rotation with family revocation, logout, and
table-bound guest sessions.

## What shipped

**S11 — the primitives.** `infrastructure/auth/`: argon2id with the cost in config and a
`needsRehash` upgrade path, HS256 access tokens via `jose`, opaque refresh tokens stored as a
*peppered* hash, HMAC-signed table-bound guest tokens, and the cookie helpers.

**S12 — the boundary.** `zodValidate` (strict schemas, no coercion, i18n-keyed `fieldErrors`), helmet,
credentialed CORS locked to one origin, a sliding-window rate limiter behind an application port, CSRF
as Origin-check + double-submit, and a dev-only `/_probe` whose whole purpose is to make all of it
visible to `curl`.

**S13 — `POST /auth/register`, `POST /auth/login`, `GET /auth/me`.** `AuthService` plus the
`authenticate` / `authorize` middleware, the P/G/U/A access levels, and `contracts/dto/auth.ts` — the
same schemas the S39 forms will import.

**S14 — refresh rotation.** Rotate inside a family, mark `replacedById`, and on reuse revoke the
**whole family** with an ALERT `BAD_TOKEN` row. Plus logout and the expiry sweep.

**S15 — `SecurityEventService` + `MetricsRegistry`.** No HTTP route: both move to the admin process in
S49 (`12` §11.1). Wired into the rate limiter and the reuse detector now.

**S16 — `POST /auth/guest`.** A guest identity bound to one table, with a `PROVISIONAL` wallet, and
`enforceGuestBinding` refusing any other table with 403 + an audit row.

## Five things worth your attention

**1. Refresh tokens are opaque, not JWTs.** S11's brief says "sign/verify access tokens and refresh
tokens", but `07` §5.3 specifies an opaque random value for refresh — and `07` is right. Rotation,
family revocation and reuse detection all need server state anyway, so a self-describing refresh token
buys nothing and costs revocability. Access tokens are JWTs (one HMAC verify, no DB round-trip);
long-lived authority lives in a database row that can be killed.

**2. The refresh cookie is scoped one segment wider than the spec says.** `07` §5.3 asks for
`Path=/api/v1/auth/refresh`. It is set to `/api/v1/auth`, because `POST /auth/logout` has to *read*
the refresh cookie to revoke its family — with the narrower path, logout could not end the session it
is being asked to end. The intent ("not sent with every request") is preserved.

**3. CSRF: Origin-check first, double-submit second — and no dev-only switch.** `07` §5.4 specifies
the double-submit token. Implemented as written, plus the Origin check that OWASP treats as the
primary defence. The part worth your sign-off: **the token is only demanded from requests that carry
an `Origin` or `Referer`.** A request with neither did not come from a browser, has no ambient cookie
jar for an attacker to ride, and therefore has no CSRF to prevent. That is what keeps every `curl`
verification step in the build plan working while a hostile page still gets a 403 — with identical
behaviour in dev and prod, rather than an environment flag that makes development lie to you.

**4. `authenticate` spends a primary-key read on every request, on purpose.** Everything `/auth/me`
returns could be baked into the JWT. It is not, because a **banned player would keep full access until
their 10-minute token expired**, and a renamed player would keep the old name. There is a test for
each. One indexed read is the cheaper side of that trade.

**5. The live smoke test caught the one thing the unit tests missed.** Zod's default messages
("Expected number, received string") were going out in `fieldErrors` — rendered English prose, which is
exactly what the `code` + `i18nKey` contract exists to prevent, and unreadable to a Persian-speaking
user. Field errors are now mapped to `errors.field.*` keys, a schema's own key (`errors.passwordTooShort`)
wins when it has one, and Zod's wording is kept in the logged `message`, which never crosses the wire.

## Structural decisions

- **`EMAIL_TAKEN` (409) added to the error taxonomy.** A taken email is not a malformed request, and
  the sign-up form needs to render it under the email field in the reader's language. `02` §5.6 now
  documents it alongside Phase B's four extra codes.
- **The unique constraint decides uniqueness, not the service.** `IUserRepository.create` throws
  `EmailTakenError` from the constraint; `AuthService.register` has no `findByEmail` pre-check, which
  under concurrency would be simply wrong. Same discipline as `claimSeat`. Both the fake and the
  Prisma repository are held to it by the contract suite.
- **`IRefreshTokenRepository.revokeIfActive`** — a conditional `updateMany` that atomically claims a
  token for rotation. `findByTokenHash` then `revoke` cannot express this: under PostgreSQL's default
  isolation both racers read the same active row. This is what makes two parallel refreshes produce
  one winner and one 401 instead of a forked family.
- **Auth primitives reach `AuthService` as three ports** (`IPasswordHasher`, `ITokenIssuer`,
  `IGuestTokenIssuer`) because `application/` may not import `infrastructure/`. Not ceremony: it lets
  the auth *flow* be tested without 50 ms of argon2 per case.
- **The rate limiter is ours, behind `IRateLimiter`,** rather than `express-rate-limit`. Sliding, not
  fixed-window — a fixed window allows 2× the intended burst at the boundary. S27 swaps in the Redis
  twin with one line in `container.ts`.
- **The login throttle keys on email *and* IP** (`07` §5.3). Either alone has a hole: per-IP lets one
  attacker spray one password across thousands of accounts; per-email lets a botnet grind one account
  from thousands of addresses. A success clears both, or mistyping four times costs you 15 minutes.
- **A `SecurityEvent` write never fails its caller.** Fire-and-forget, errors swallowed into the log.
  A monitoring outage must not become a game outage. Note the deliberate contrast with `withAudit` in
  the admin console (`12` §10), where the audit row *is* the accountability and a failure aborts the
  mutation.
- **`ACCESS_TOKEN_TTL_SEC` default dropped 900 → 600** to match `07` §5.3's 10 minutes. A stateless
  token cannot be revoked, so its TTL *is* the revocation lag.
- **`interface/http/middleware/placeholders.ts` is deleted.** Every `02` §7 slot has a body now, and a
  test asserts the `x-pending-middleware` header is gone.
- **`GET /api/v1/_probe/table/:tableId` is a dev-only stand-in** so S16's central property is checkable
  today — `/tables/:id` does not exist until S18. Same middleware, same 403, same audit row. Delete it
  when S18 lands.

## The assertions I'd read first

```
★ a guest token for table A does not verify against table B
★ cannot be re-pointed at another table by editing the token
★ stored refresh token is a hash — the raw value appears nowhere in the row
★ replaying a revoked token kills the family, including the live token
★ two parallel refreshes leave exactly one live token in the family
★ refuses another table with 403 — and audits it
★ a duplicate email is 409 EMAIL_TAKEN and leaves no partial rows
★ a wrong password and an unknown email are indistinguishable
★ stops working the moment the account is banned
★ a claimed guest token stops working immediately
★ a broken audit write never fails the caller
★ every field error is an i18n key, never English prose
★ /metrics and /admin/* are 404 on :3000 — asserted by walking the router stack
```

The first two are the reason persona P2 is not a privilege-escalation hole. The refresh trio is the
reason a stolen cookie is contained in minutes rather than 30 days.

## One thing you have to do before verifying

**Re-run `npm install` from Windows, then `npm run db:generate`.** Phase C added four dependencies
(`jose`, `helmet`, `cors`, `cookie-parser`) and I installed them from WSL, which swapped
`esbuild`/`rollup` to their Linux builds — so the suite currently runs from WSL, not Windows. One
`npm install` from your usual shell picks up the new packages and swaps the binaries back.

Port 3000 is still occupied on this machine; everything above was verified live on `PORT=3999`.
Playwright still can't launch (missing `libnspr4`/`libnss3`, needs sudo). Neither blocks Phase C.

Every checkbox in `plan.md` is still unticked — those are yours after the "You verify" pass. The exact
commands are in `.claude/context/build/context.md`, and `requests/auth.http` walks the whole flow from
your editor.

Commit message when you're ready:

```
feat(m0): auth through Phase C (S11–S16)

Auth primitives: argon2id with config-driven cost and a needsRehash upgrade
path, HS256 access tokens, opaque refresh tokens stored as a peppered hash,
and HMAC-signed guest tokens provably bound to one tableId before any database
lookup. Cookie helpers set httpOnly + SameSite=Lax, Secure in production, with
the refresh cookie scoped to /api/v1/auth so logout can revoke its own family.

The boundary: strict Zod validation with no coercion and i18n-keyed field
errors, helmet, credentialed CORS on one exact origin, a sliding-window rate
limiter behind an application port, and CSRF as an Origin check plus the 07
§5.4 double-submit token — demanded only of requests that carry an Origin,
since a client without one has no cookie jar to ride.

Register creates user, preferences, one wallet per asset and the DEFAULT
cosmetic grants in a single transaction; a duplicate email is 409 EMAIL_TAKEN
from the unique constraint, not from a read-then-write check, and leaves no
partial rows. Login equalises timing between a wrong password and an unknown
email, throttles 5/15min per email AND per IP, and upgrades a stale argon2
hash. /auth/me resolves from the cookie alone and stops working the instant an
account is banned.

Refresh rotates inside a family via an atomic revokeIfActive; replaying a
revoked token revokes the whole family and writes an ALERT BAD_TOKEN event,
while two parallel refreshes leave exactly one live token instead of a fork.

SecurityEventService and MetricsRegistry produce the S15 data with no HTTP
route — /metrics and /admin/* stay 404 on :3000, asserted by walking the
router stack.

POST /auth/guest issues an identity bound to the invite's table with a
PROVISIONAL wallet and no account; cross-table use is 403 plus a
SEAT_IMPERSONATION audit row.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```
