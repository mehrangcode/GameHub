import { randomUUID } from 'node:crypto'
import type { NextFunction, Request, RequestHandler, Response } from 'express'

/**
 * First in the chain (02 §7), because everything after it wants to say which
 * request it is talking about.
 *
 * An inbound `x-request-id` is honoured so a trace survives a proxy hop, but it
 * is length-capped: the header is attacker-controlled and ends up in every log
 * line for the request.
 */
export const REQUEST_ID_HEADER = 'x-request-id'
const MAX_INBOUND_LENGTH = 128

/**
 * `req.id` is declared by `pino-http` on `IncomingMessage`, so we set that
 * field rather than augmenting Express with a second, conflicting one — which
 * is also why pino-http picks the value up with no extra wiring.
 */
export function requestIdOf(req: Request): string {
  return String(req.id ?? '')
}

export function requestId(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const inbound = req.get(REQUEST_ID_HEADER)
    req.id = inbound && inbound.length <= MAX_INBOUND_LENGTH ? inbound : randomUUID()
    res.setHeader(REQUEST_ID_HEADER, requestIdOf(req))
    next()
  }
}
