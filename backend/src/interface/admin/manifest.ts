import type { AdminAction } from '../../contracts/admin/enums.js'
import type { UserRole } from '../../contracts/enums.js'

/**
 * ★★ The admin route manifest — 12-admin-console.md §3.5, §10 tests 2, 3, 4, 6.
 *
 * Every admin route is declared here **and the router is built from this
 * array**, by `mountManifest`. That direction is the entire point: a manifest
 * the router merely agreed with would drift the first time someone added a
 * route in a hurry, and the tests that read it would then be certifying a
 * document rather than the software.
 *
 * Because the router is generated from it, four properties are enforced by
 * construction rather than by review:
 *
 * | Field | Enforced by | Test that would fail |
 * |---|---|---|
 * | `role` | `requireAdminRole` | RBAC matrix — `SUPPORT` × every `ADMIN` route |
 * | `requiresStepUp` | `requireStepUp` | a ⚡ route with a stale `mfaAt` |
 * | `requiresReason` | `requireReason` | a 📝 route called with no reason |
 * | `mutating` + `action` | the audit-completeness test | **a new mutating route that forgets `withAudit`** |
 *
 * The last one is the one worth the machinery. Adding `POST /users/:id/ban`
 * without its audit row is not a mistake anyone would make on purpose — it is a
 * mistake made at 6pm on a Friday, and the manifest test is what turns it into
 * a red CI run instead of a gap in the history nobody notices for a year.
 */
export interface AdminRouteSpec {
  /** Stable handler key. The generated router looks its controller up by this. */
  readonly key: string
  readonly method: 'get' | 'post' | 'put' | 'patch' | 'delete'
  /** Relative to `/admin/api/v1`. */
  readonly path: string
  /** The **minimum** role. `'SUPPORT'` means SUPPORT and ADMIN; `'ADMIN'` means ADMIN alone. */
  readonly role: Extract<UserRole, 'SUPPORT' | 'ADMIN'>
  /** Writes state ⇒ must produce exactly one `AdminAuditLog` row. */
  readonly mutating: boolean
  /** ⚡ — a TOTP within `ADMIN_STEPUP_WINDOW_MIN`. */
  readonly requiresStepUp: boolean
  /** 📝 — a non-blank `reason` in the body, or `REASON_REQUIRED`. */
  readonly requiresReason: boolean
  /** The action the audit row must carry. Required for every mutating route. */
  readonly action?: AdminAction
}

/**
 * S50's surface. Deliberately small — three reads and **one** write.
 *
 * One mutating endpoint is enough to prove the spine end to end, and proving it
 * before there are twenty is the whole argument for doing Phase L at M0 rather
 * than at MA: retrofitting A3 across twenty endpoints means auditing all
 * twenty, and getting one of them wrong is invisible.
 *
 * The rest of §5's table arrives with the milestone that needs it — the ledger
 * browser at M2, game flags and the control channel at M3, everything else at
 * MA — and each one is a line here plus a controller.
 */
export const ADMIN_ROUTES: readonly AdminRouteSpec[] = [
  {
    key: 'users.list',
    method: 'get',
    path: '/users',
    role: 'SUPPORT',
    mutating: false,
    requiresStepUp: false,
    requiresReason: false,
  },
  {
    key: 'users.get',
    method: 'get',
    path: '/users/:id',
    role: 'SUPPORT',
    mutating: false,
    requiresStepUp: false,
    requiresReason: false,
  },
  {
    key: 'audit.list',
    method: 'get',
    path: '/audit',
    role: 'SUPPORT',
    mutating: false,
    requiresStepUp: false,
    requiresReason: false,
  },
  {
    /**
     * `ADMIN` rather than `SUPPORT`, unlike every other read here.
     *
     * Verification answers "has this log been tampered with", and the person
     * most likely to have tampered with it is an operator. Keeping the check at
     * the higher role is not a real defence — it is a statement that the audit
     * log's integrity is not routine reading — but it costs nothing and it puts
     * the boundary in the right place from the start.
     */
    key: 'audit.verify',
    method: 'get',
    path: '/audit/verify',
    role: 'ADMIN',
    mutating: false,
    requiresStepUp: false,
    requiresReason: false,
  },
  {
    /**
     * ★ The one write. `SUPPORT` may disable (§3.1) — it is the core moderation
     * action and withholding it would make the role useless — but it is ⚡ and
     * 📝 because it ends somebody's session mid-game.
     */
    key: 'users.disable',
    method: 'post',
    path: '/users/:id/disable',
    role: 'SUPPORT',
    mutating: true,
    requiresStepUp: true,
    requiresReason: true,
    action: 'user.disable',
  },
]

/** The roles that satisfy a spec's minimum. */
export function rolesFor(spec: AdminRouteSpec): readonly UserRole[] {
  return spec.role === 'ADMIN' ? ['ADMIN'] : ['ADMIN', 'SUPPORT']
}

/** `/admin/api/v1/users/:id/disable` — what the tests and the console address. */
export function fullPath(spec: AdminRouteSpec, prefix = '/admin/api/v1'): string {
  return `${prefix}${spec.path}`
}
