import type { Logger } from 'pino'
import type { z } from 'zod'
import type { SocketAck } from '../../contracts/errors.js'
import { AppError } from '../../domain/errors/AppError.js'
import { InternalError, ValidationError } from '../../domain/errors/errors.js'
import { zodFieldErrors } from '../validation/zodErrors.js'

/**
 * The socket equivalent of `errorHandler` + `zodValidate` — S23.
 *
 * Every client→server event goes through {@link handler}, which does the four
 * things the REST chain does per request, in the same order:
 *
 *   1. **Zod-parses the payload.** Types catch our mistakes at compile time;
 *      Zod catches a hostile client at runtime (04 §3.3). Both are required —
 *      the client is untrusted by definition, and a socket payload has had no
 *      body parser, no content-type and no schema anywhere upstream of here.
 *   2. Runs the handler.
 *   3. Maps `AppError → { ok:false, code, i18nKey }`, so the wire contract is
 *      identical to REST's (02 §5.6): a stable machine code plus an i18n key,
 *      never a rendered English sentence.
 *   4. Turns anything else into an opaque `INTERNAL`, with the real error and
 *      the socket id in the log and nothing but a code on the wire.
 *
 * ### The ack that isn't there
 *
 * A client may simply not pass a callback — Socket.IO does not require one, and
 * a hostile client certainly will not. So `respond` is defensive: when there is
 * no callback, a failure is delivered over the `error` event instead of being
 * swallowed. Silently dropping it would make every "it doesn't work and there's
 * no error" bug report unanswerable.
 */

export interface AckContext {
  readonly socketId: string
  readonly logger: Logger
  /** Called for every refused event, so the gateway can count them. */
  readonly onRejected?: (code: string) => void
}

export function toAck(error: unknown): Extract<SocketAck<never>, { ok: false }> {
  const app = error instanceof AppError ? error : new InternalError()
  const api = app.toApiError()

  return {
    ok: false,
    code: api.code,
    i18nKey: api.i18nKey,
    ...(api.details === undefined ? {} : { details: api.details }),
    ...(api.fieldErrors === undefined ? {} : { fieldErrors: api.fieldErrors }),
    ...(api.retryAfterMs === undefined ? {} : { retryAfterMs: api.retryAfterMs }),
  }
}

export type SocketHandler<In, Out> = (payload: In) => Promise<Out> | Out

/**
 * Wraps a handler into the `(payload, ack)` listener Socket.IO expects.
 *
 * The `unknown` payload type is the point: whatever the typed `ClientToServerEvents`
 * map claims, what actually arrives is bytes off a socket, and it is `schema`
 * that turns it into the declared type. A handler never sees an unparsed value.
 */
export function handler<S extends z.ZodTypeAny, Out>(
  context: AckContext,
  schema: S,
  run: SocketHandler<z.output<S>, Out>,
): (payload: unknown, respond?: unknown) => void {
  return (payload, respond) => {
    const reply = typeof respond === 'function' ? (respond as (ack: SocketAck<Out>) => void) : null

    const parsed = schema.safeParse(payload)
    if (!parsed.success) {
      const fieldErrors = zodFieldErrors(parsed.error)
      context.logger.debug(
        { socketId: context.socketId, zod: parsed.error.message },
        'socket payload rejected',
      )
      context.onRejected?.('VALIDATION_FAILED')
      reply?.(toAck(new ValidationError('Invalid payload', fieldErrors)))
      return
    }

    void (async () => {
      try {
        /**
         * ★ The work is done **before** the reply, on its own line, and that is
         * not style.
         *
         * `reply?.({ data: await run(…) })` reads naturally and is wrong:
         * optional chaining short-circuits the *whole* expression, arguments
         * included. With no ack callback — which Socket.IO permits and a
         * hostile client guarantees — `run` would never be called, and every
         * event from such a client would be silently ignored while looking
         * perfectly healthy from the server's side.
         */
        const data = await run(parsed.data as z.output<S>)
        reply?.({ ok: true, data })
      } catch (error) {
        if (!(error instanceof AppError)) {
          // The stack never leaves the process; the socket id is what ties this
          // line to the connection that caused it.
          context.logger.error({ err: error, socketId: context.socketId }, 'socket handler threw')
        }
        const ack = toAck(error)
        context.onRejected?.(ack.code)
        reply?.(ack)
      }
    })()
  }
}
