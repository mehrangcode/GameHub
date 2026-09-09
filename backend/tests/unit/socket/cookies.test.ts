import { describe, expect, it } from 'vitest'
import { parseCookieHeader } from '../../../src/interface/socket/cookies.js'

/**
 * S23 — the fifteen lines that decide who you are.
 *
 * A Socket.IO handshake does not go through Express middleware, so the gateway
 * reads the raw `Cookie:` header itself. This is written in-house rather than
 * pulled from the `cookie` package because that package is a *transitive*
 * dependency of Express and `cookie-parser` — a version bump in either could
 * remove it, and the failure would be "nobody can connect" at boot. Which is
 * only a defensible trade if the fifteen lines are tested.
 */
describe('parseCookieHeader', () => {
  it('reads a normal header', () => {
    expect(parseCookieHeader('access=abc; guest=def; csrf=ghi')).toEqual({
      access: 'abc',
      guest: 'def',
      csrf: 'ghi',
    })
  })

  it('an absent or empty header is an empty map, never a throw', () => {
    expect(parseCookieHeader(undefined)).toEqual({})
    expect(parseCookieHeader('')).toEqual({})
    expect(parseCookieHeader('   ')).toEqual({})
  })

  it('★ duplicates are first-wins, matching every browser', () => {
    // Not hypothetical. The refresh cookie is scoped to `/api/v1/auth` while the
    // access cookie sits at `/`, so a browser can genuinely send the same name
    // twice, most-specific path first. Taking the last would silently pick the
    // wrong session.
    expect(parseCookieHeader('access=correct; access=stale')).toEqual({ access: 'correct' })
  })

  it('tolerates the shapes a real header arrives in', () => {
    expect(parseCookieHeader('  access = abc  ;  guest=def ')).toEqual({
      access: 'abc',
      guest: 'def',
    })
    // A value containing `;` or `,` is quoted by the browser; the quotes are
    // transport, not content.
    expect(parseCookieHeader('access="a=b=c"')).toEqual({ access: 'a=b=c' })
    // JWTs are dot-separated base64url and contain `=` padding — a naive
    // `split('=')` mangles exactly the cookie that matters most.
    expect(parseCookieHeader('access=eyJhbGc.eyJzdWI.sig==')).toEqual({
      access: 'eyJhbGc.eyJzdWI.sig==',
    })
  })

  it('percent-encoding is decoded, and a broken escape does not lose the header', () => {
    expect(parseCookieHeader('name=a%20b')).toEqual({ name: 'a b' })
    // One malformed cookie must not cost us the others: they are still readable,
    // and this one simply will not verify.
    expect(parseCookieHeader('bad=%E0%A4%A; good=fine')).toEqual({
      bad: '%E0%A4%A',
      good: 'fine',
    })
  })

  it('skips fragments that are not name=value pairs', () => {
    expect(parseCookieHeader('=novalue; ;; justaname; real=yes')).toEqual({ real: 'yes' })
  })

  it('an empty value is kept — "present but empty" is a real state', () => {
    // The handshake treats an empty cookie as absent; that decision belongs
    // there, not here. A parser that silently dropped it would hide the
    // difference between "no cookie" and "a cookie that was cleared".
    expect(parseCookieHeader('access=; guest=x')).toEqual({ access: '', guest: 'x' })
  })
})
