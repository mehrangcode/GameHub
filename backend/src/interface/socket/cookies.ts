/**
 * Cookie-header parsing for the handshake — S23.
 *
 * Express has `cookie-parser`; a Socket.IO handshake does not go through
 * Express middleware, so the gateway gets the raw `Cookie:` header and has to
 * read it itself.
 *
 * Written here in fifteen lines rather than pulled from the `cookie` package,
 * which is a *transitive* dependency of both Express and `cookie-parser` and
 * therefore not ours to import: a version bump in either could remove it, and
 * the failure would be "nobody can connect to the socket" at boot. Fifteen
 * reviewable lines with a unit test beats an undeclared dependency on the one
 * code path that decides who you are.
 */

/**
 * Parses a `Cookie:` header into a name → value map.
 *
 * Deliberately lenient about malformed pairs and deliberately **first-wins** on
 * duplicates, which matches every browser and `cookie-parser`. Duplicates are
 * not hypothetical here: a cookie set at `/` and again at `/api/v1/auth` (which
 * is exactly how the refresh cookie is scoped) arrives twice, most-specific
 * path first, and taking the last one would silently pick the wrong session.
 */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  if (!header) return cookies

  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=')
    if (separator < 1) continue

    const name = pair.slice(0, separator).trim()
    if (name.length === 0 || name in cookies) continue

    let value = pair.slice(separator + 1).trim()
    // A value containing `;` or `,` is quoted by the browser; the quotes are
    // transport, not content.
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
    }

    try {
      cookies[name] = decodeURIComponent(value)
    } catch {
      // A malformed percent-escape is not worth rejecting the whole header
      // over: the other cookies are still readable, and this one simply will
      // not verify.
      cookies[name] = value
    }
  }

  return cookies
}
