import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express'
import type { Logger } from 'pino'
import { AppError, isAppError } from '../../../domain/errors/AppError.js'
import { requestIdOf } from './requestId.js'
import { NotFoundError, ValidationError } from '../../../domain/errors/errors.js'
import type { ApiError } from '../../../contracts/errors.js'

/**
 * The single place an error becomes a response (02 §5.6).
 *
 * Two rules, and the second is the one that matters:
 *
 *   1. An `AppError` becomes its documented status and `{ code, i18nKey,
 *      details }` — a machine code plus a translation key, never a rendered
 *      English sentence, so the client renders it in the reader's language.
 *   2. **Anything else becomes an opaque 500 `INTERNAL`.** The real error is
 *      logged with the `requestId` and stays on the server. A stack trace in a
 *      response body is a free map of the codebase for anyone probing the API,
 *      and the `requestId` gives support everything it needs without one.
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req: Request, res: Response, next: NextFunction) => {
    // Express requires the 4-arg shape; if headers are already out, the only
    // correct move is to let Express destroy the socket.
    if (res.headersSent) {
      next(error)
      return
    }

    const requestId = requestIdOf(req)
    const child = logger.child({ requestId, method: req.method, path: req.path })

    // `express.json()` rejects malformed bodies and oversized ones with its own
    // errors, before any route's Zod schema runs. Left alone they surface as
    // opaque 500s, which reads as "the server is broken" for what is plainly a
    // bad request — so they are translated here, at the same boundary.
    const translated = translateBodyParserError(error)
    if (translated) {
      child.warn({ code: translated.code, status: translated.httpStatus }, translated.message)
      res.status(translated.httpStatus).json(translated.toApiError())
      return
    }

    if (isAppError(error)) {
      const body: ApiError = error.toApiError()
      // 4xx is the client's problem and routine; 5xx is ours. A stack trace on
      // every 404 buries the one line that matters, so only 5xx carries `err`.
      if (error.httpStatus >= 500) {
        child.error({ code: error.code, status: error.httpStatus, err: error }, error.message)
      } else {
        child.warn(
          { code: error.code, status: error.httpStatus, details: error.details },
          error.message,
        )
      }
      if (error.httpStatus === 429 && 'retryAfterMs' in body && body.retryAfterMs !== undefined) {
        res.setHeader('Retry-After', Math.ceil(body.retryAfterMs / 1000))
      }
      res.status(error.httpStatus).json(body)
      return
    }

    child.error({ err: error }, 'unhandled error')
    res.status(500).json({ code: 'INTERNAL', i18nKey: 'errors.internal' } satisfies ApiError)
  }
}

/**
 * body-parser's errors carry a numeric `status` and a `type`. Only the two
 * cases a client can actually cause are translated; anything else keeps
 * falling through to the opaque 500, which is the right default.
 */
function translateBodyParserError(error: unknown): AppError | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const candidate = error as { type?: string; status?: number }

  if (candidate.type === 'entity.parse.failed') {
    return new ValidationError('Request body is not valid JSON', {
      _: ['errors.malformedJson'],
    })
  }
  if (candidate.type === 'entity.too.large') {
    return new ValidationError('Request body is too large', { _: ['errors.bodyTooLarge'] })
  }
  return undefined
}

/**
 * Turns an unmatched route into a `NotFoundError` so it travels the same path
 * as every other failure — including `/admin/*` on the public port, which must
 * be an ordinary 404 and not a hint that the admin app exists elsewhere.
 */
export function notFoundHandler(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    next(new NotFoundError('Route', { method: req.method, path: req.path }))
  }
}

/**
 * Wraps an async handler so a rejected promise reaches `errorHandler`.
 *
 * Express 5 forwards rejections on its own, but being explicit at the call site
 * keeps the intent readable — and makes the behaviour independent of which
 * Express major we are on.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next)
  }
}

export { AppError }
