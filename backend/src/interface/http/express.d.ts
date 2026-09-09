import type { Identity } from '../../contracts/dto/auth.js'
import type { Table } from '../../domain/entities/table.js'

/**
 * The two things middleware attaches to a request.
 *
 * `req.id` is **not** here on purpose: pino-http already declares it on
 * `IncomingMessage` as `ReqId`, and re-declaring it as `string` breaks
 * `app.use` overload resolution. `requestId.ts` writes that field and
 * `requestIdOf(req)` reads it.
 */
declare global {
  namespace Express {
    interface Request {
      /**
       * Set by `zodValidate`. Present only for the parts a route declared a
       * schema for — read it through `validBody`/`validQuery`/`validParams`,
       * which fail loudly rather than handing back `undefined`.
       */
      validated?: {
        body?: unknown
        query?: unknown
        params?: unknown
      }

      /**
       * Set by `authenticate` when a valid access or guest cookie was present.
       * Absent means anonymous — which is a legitimate state for public routes,
       * so this is optional rather than a nullable field nobody checks.
       */
      identity?: Identity

      /**
       * Set by `requireHost` (access level **H**), which had to read the table
       * to check ownership. The handler then reuses it instead of issuing the
       * same query again — one read per request, and no window in which the
       * row the guard approved differs from the row the handler edits.
       */
      table?: Table
    }
  }
}
