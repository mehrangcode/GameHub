import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { handler, toAck } from '../../../src/interface/socket/ack.js'
import type { SocketAck } from '../../../src/contracts/errors.js'
import {
  CapRejectedError,
  ForbiddenError,
  RateLimitError,
  SeatTakenError,
  ValidationError,
} from '../../../src/domain/errors/errors.js'

/**
 * S23 — the socket's boundary, which is the REST boundary in a different coat.
 *
 * The contract crossing the wire is the same one 02 §5.6 defines for HTTP: a
 * stable machine `code` plus an `i18nKey`, never a rendered English sentence.
 * That matters more here than it looks, because a socket ack is the *only*
 * feedback a player gets for a move — there is no status line, no URL, and no
 * network tab entry a support conversation can lean on.
 */

const silent = pino({ level: 'silent' })
const context = { socketId: 'sock-1', logger: silent }

const Schema = z.object({ tableId: z.string().min(1), seat: z.number().int() }).strict()

function capture() {
  const acks: Array<SocketAck<unknown>> = []
  return { acks, reply: (ack: SocketAck<unknown>) => acks.push(ack) }
}

describe('toAck', () => {
  it('maps an AppError to its code and key', () => {
    expect(toAck(new ForbiddenError('nope', { reason: 'HOST_REQUIRED' }))).toEqual({
      ok: false,
      code: 'FORBIDDEN',
      i18nKey: 'errors.forbidden',
      details: { reason: 'HOST_REQUIRED' },
    })
  })

  it('carries retryAfterMs, because a limit with no "when" reads as a bug', () => {
    expect(toAck(new RateLimitError(1500))).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: 1500,
    })
    expect(toAck(new CapRejectedError('capped', 900))).toMatchObject({ retryAfterMs: 900 })
  })

  it('carries the details that tell two 409s apart', () => {
    // "That seat is taken" and "you are already sitting here" are different
    // problems with different buttons to press.
    expect(toAck(new SeatTakenError(2, { reason: 'ALREADY_SEATED', yourSeat: 1 }))).toMatchObject({
      code: 'SEAT_TAKEN',
      details: { seat: 2, reason: 'ALREADY_SEATED', yourSeat: 1 },
    })
  })

  it('carries fieldErrors, the shape a form binds to', () => {
    expect(toAck(new ValidationError('bad', { body: ['errors.chatBodyTooLong'] }))).toMatchObject({
      fieldErrors: { body: ['errors.chatBodyTooLong'] },
    })
  })

  it('★ anything unrecognised becomes an opaque INTERNAL', () => {
    // The stack never leaves the process. A thrown `Error` from a repository
    // must not put a table name or a query on somebody's screen.
    for (const thrown of [
      new Error('DB connection string is postgres://u:p@h'),
      'a string',
      null,
    ]) {
      expect(toAck(thrown)).toEqual({ ok: false, code: 'INTERNAL', i18nKey: 'errors.internal' })
    }
  })
})

describe('handler', () => {
  it('parses, runs, and acks with the result', async () => {
    const { acks, reply } = capture()
    const run = vi.fn().mockResolvedValue({ seat: 1 })

    handler(context, Schema, run)({ tableId: 't', seat: 1 }, reply)
    await vi.waitFor(() => expect(acks).toHaveLength(1))

    expect(run).toHaveBeenCalledWith({ tableId: 't', seat: 1 })
    expect(acks[0]).toEqual({ ok: true, data: { seat: 1 } })
  })

  it('★ an unknown key is a refused event, not a dropped field', () => {
    const { acks, reply } = capture()
    const run = vi.fn()

    // This is the seat-impersonation defence in its cheapest form: a payload
    // carrying `userId` never reaches a handler at all.
    handler(context, Schema, run)({ tableId: 't', seat: 1, userId: 'someone' }, reply)

    expect(run).not.toHaveBeenCalled()
    expect(acks[0]).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
      fieldErrors: { userId: ['errors.field.unknownKey'] },
    })
  })

  it('does not coerce — "1" where a number is required is a refusal', () => {
    const { acks, reply } = capture()
    handler(context, Schema, vi.fn())({ tableId: 't', seat: '1' }, reply)

    expect(acks[0]).toMatchObject({
      ok: false,
      fieldErrors: { seat: ['errors.field.invalidType'] },
    })
  })

  it('★ fieldErrors are i18n keys, never Zod’s English', () => {
    const { acks, reply } = capture()
    handler(context, Schema, vi.fn())({}, reply)

    const ack = acks[0]
    expect(ack?.ok).toBe(false)
    if (ack !== undefined && !ack.ok) {
      for (const messages of Object.values(ack.fieldErrors ?? {})) {
        for (const message of messages) {
          expect(message).toMatch(/^errors\./)
          // "Expected number, received string" in front of a Persian reader is
          // the exact failure the code + i18nKey contract exists to prevent.
          expect(message).not.toMatch(/\s/)
        }
      }
    }
  })

  it('a schema’s own key wins over the generic one', () => {
    const { acks, reply } = capture()
    const Custom = z.object({ body: z.string().min(1, 'errors.chatBodyEmpty') }).strict()

    handler(context, Custom, vi.fn())({ body: '' }, reply)
    expect(acks[0]).toMatchObject({ fieldErrors: { body: ['errors.chatBodyEmpty'] } })
  })

  it('a thrown AppError becomes its ack', async () => {
    const { acks, reply } = capture()
    handler(context, Schema, () => {
      throw new SeatTakenError(1, { reason: 'SEAT_OCCUPIED' })
    })({ tableId: 't', seat: 1 }, reply)

    await vi.waitFor(() => expect(acks).toHaveLength(1))
    expect(acks[0]).toMatchObject({ ok: false, code: 'SEAT_TAKEN' })
  })

  it('★ a missing callback is survivable — a hostile client will not send one', async () => {
    const run = vi.fn().mockResolvedValue(undefined)

    // Socket.IO does not require an ack callback. Throwing here would let any
    // client take the handler down by omitting one.
    expect(() => handler(context, Schema, run)({ tableId: 't', seat: 1 })).not.toThrow()
    await vi.waitFor(() => expect(run).toHaveBeenCalled())

    expect(() =>
      handler(context, Schema, run)({ tableId: 't', seat: 1 }, 'not-a-function'),
    ).not.toThrow()
  })

  it('reports every refusal to the counter, so a probe is visible', () => {
    const codes: string[] = []
    const counting = { ...context, onRejected: (code: string) => codes.push(code) }

    handler(counting, Schema, vi.fn())({ nope: true }, capture().reply)
    handler(counting, Schema, () => {
      throw new ForbiddenError()
    })({ tableId: 't', seat: 0 }, capture().reply)

    expect(codes).toContain('VALIDATION_FAILED')
  })
})
