import type { RequestHandler } from 'express'
import { ForbiddenError } from '../../../domain/errors/errors.js'
import { clientIp } from '../../http/middleware/rateLimit.js'

/**
 * Belt-and-braces on top of TOTP — 12-admin-console.md §2.5.
 *
 * **Empty disables it, and that is the default.** An operator on a domestic
 * connection with a rotating address who pins an allowlist locks themselves out
 * at 3am, and the recovery is SSH plus an environment variable. Off by default
 * with TOTP mandatory is the honest configuration; the allowlist earns its
 * place when the console is reached from a fixed office address or a VPN.
 *
 * Accepts bare addresses and CIDR blocks, IPv4 and IPv6, comma-separated. A
 * malformed entry throws **at construction** rather than being skipped at
 * request time: a typo in an allowlist that silently widens it to everything,
 * or narrows it to nothing, is the worst of both outcomes.
 */

interface Rule {
  readonly bytes: Uint8Array
  readonly prefixBits: number
}

export function parseAllowlist(raw: string): Rule[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map(parseRule)
}

export function ipAllowlist(raw: string): RequestHandler {
  const rules = parseAllowlist(raw)

  if (rules.length === 0) {
    // A no-op handler rather than a conditional mount, so the middleware chain
    // is the same shape in every configuration and `app.use` order cannot
    // differ between deployments.
    return (_req, _res, next) => next()
  }

  return (req, _res, next) => {
    const ip = clientIp(req)
    if (rules.some((rule) => matches(ip, rule))) {
      next()
      return
    }
    // No `SecurityEvent` here: the allowlist sits in front of authentication,
    // so this fires for every stray scan that reaches the host and would bury
    // the events that describe an actual admin account under attack.
    next(new ForbiddenError('Not permitted from this address', { reason: 'IP_NOT_ALLOWED' }))
  }
}

function parseRule(entry: string): Rule {
  const [address, prefix] = entry.split('/')
  const bytes = toBytes(address ?? '')

  if (bytes === null) {
    throw new TypeError(
      `ADMIN_IP_ALLOWLIST contains an entry that is not an address or CIDR block: "${entry}"`,
    )
  }

  const maxBits = bytes.length * 8
  const prefixBits = prefix === undefined ? maxBits : Number(prefix)

  if (!Number.isInteger(prefixBits) || prefixBits < 0 || prefixBits > maxBits) {
    throw new TypeError(`ADMIN_IP_ALLOWLIST entry "${entry}" has an impossible prefix length`)
  }

  return { bytes, prefixBits }
}

function matches(ip: string, rule: Rule): boolean {
  const bytes = toBytes(ip)
  if (bytes === null || bytes.length !== rule.bytes.length) return false

  let remaining = rule.prefixBits
  for (let i = 0; i < bytes.length && remaining > 0; i += 1) {
    const take = Math.min(8, remaining)
    const mask = (0xff << (8 - take)) & 0xff
    if ((bytes[i]! & mask) !== (rule.bytes[i]! & mask)) return false
    remaining -= take
  }
  return true
}

/**
 * IPv4 → 4 bytes, IPv6 → 16. An IPv4-mapped IPv6 address (`::ffff:127.0.0.1`,
 * which is what a dual-stack Node server reports for an IPv4 client) is
 * normalised to its IPv4 form — otherwise an allowlist of `127.0.0.1` would
 * refuse the very host it was written for, on some machines and not others.
 */
function toBytes(address: string): Uint8Array | null {
  const mapped = /^::ffff:(?<v4>\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  const value = mapped?.groups?.v4 ?? address

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    const parts = value.split('.').map(Number)
    if (parts.some((part) => part > 255)) return null
    return Uint8Array.from(parts)
  }

  if (!value.includes(':')) return null
  return parseIpv6(value)
}

function parseIpv6(value: string): Uint8Array | null {
  const halves = value.split('::')
  if (halves.length > 2) return null

  const head = halves[0] === '' ? [] : (halves[0]?.split(':') ?? [])
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : (halves[1]?.split(':') ?? [])) : []
  const groups =
    halves.length === 2
      ? [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail]
      : head

  if (groups.length !== 8) return null

  const bytes = new Uint8Array(16)
  for (const [index, group] of groups.entries()) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
    const word = Number.parseInt(group, 16)
    bytes[index * 2] = word >> 8
    bytes[index * 2 + 1] = word & 0xff
  }
  return bytes
}
