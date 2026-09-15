import { Router, type RequestHandler } from 'express'
import type { AdminServices } from '../../../container.js'
import { ADMIN_ROUTES, rolesFor, type AdminRouteSpec } from '../manifest.js'
import { requireAdminRole, requireStepUp } from '../middleware/adminAuth.js'
import { requireReason } from '../middleware/auditContext.js'

/**
 * ★★ The router, built **from** the manifest — 12-admin-console.md §3.5.
 *
 * This is the direction that makes the manifest worth having. A manifest the
 * router merely agreed with would be a document, and documents drift; a
 * manifest the router is *generated from* cannot disagree with reality, so the
 * tests that read it (`tests/integration/admin/spine.test.ts`) are testing the
 * software rather than the description of it.
 *
 * Every route gets its guards in this order, and the order is the design:
 *
 *     requireAdminRole → requireStepUp → requireReason → controller
 *
 *   - **Role first.** Cheapest, and it is the question that decides whether the
 *     caller may know the route exists at all.
 *   - **Step-up before reason**, so a ⚡📝 route called with a stale factor
 *     answers `STEP_UP_REQUIRED` rather than `REASON_REQUIRED`. The operator
 *     types six digits, the client replays the request it already has, and the
 *     reason they wrote is not thrown away by an ordering accident.
 *   - **Both before the controller**, which is the property S50's tests assert
 *     directly: a refused ⚡ or 📝 route leaves **no state change**. A check
 *     made inside a handler, after the first `await`, is a confirmation dialog.
 */

export type AdminHandlers = Readonly<Record<string, RequestHandler>>

export function mountManifest(
  services: AdminServices,
  handlers: AdminHandlers,
  specs: readonly AdminRouteSpec[] = ADMIN_ROUTES,
): Router {
  const router = Router()

  for (const spec of specs) {
    const handler = handlers[spec.key]
    if (handler === undefined) {
      // At construction, not at request time. A manifest entry with no
      // controller would otherwise be a 404 that looks like a routing problem
      // and is actually a wiring one — and the RBAC and audit tests would
      // happily "pass" against a route that does not exist.
      throw new Error(
        `admin manifest declares "${spec.key}" (${spec.method.toUpperCase()} ${spec.path}) ` +
          `but no controller was provided for it`,
      )
    }
    if (spec.mutating && spec.action === undefined) {
      // Every mutating route must name the action its audit row carries;
      // without it the audit-completeness test has nothing to assert against.
      throw new Error(`admin manifest entry "${spec.key}" is mutating but declares no action`)
    }

    const guards: RequestHandler[] = [requireAdminRole(...rolesFor(spec))]
    if (spec.requiresStepUp) guards.push(requireStepUp(services))
    if (spec.requiresReason) guards.push(requireReason(spec))

    router[spec.method](spec.path, ...guards, handler)
  }

  return router
}
