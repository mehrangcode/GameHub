import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
  createHash,
} from 'node:crypto'

/**
 * RFC 6238 TOTP, and the encryption that keeps a stolen database dump from
 * yielding a working second factor — 12-admin-console.md §3.3.
 *
 * Hand-written rather than pulled from a package, for the same reason
 * `shared/rng.ts` and the argon2 wrapper are: the whole of it is eighty lines
 * of HMAC and a truncation, it is specified to the bit by an RFC that ships
 * test vectors, and `tests/unit/admin/totp.test.ts` checks this code against
 * those published vectors rather than against itself. A dependency here would
 * be a supply-chain surface in the authentication path bought with no
 * reduction in the amount that has to be understood.
 *
 * Three properties the rest of the system depends on:
 *
 *   1. **Secrets are never stored in plaintext.** `encryptTotpSecret` produces
 *      `iv:tag:ciphertext`, AES-256-GCM under `ADMIN_TOTP_ENC_KEY`. A dump
 *      alone is not a second factor.
 *   2. **A code is spendable once.** `verifyTotp` returns the *step* it
 *      matched, and `AdminAuthService` stores it as `lastTotpStep` and refuses
 *      anything at or below it next time. Shoulder-surfing a code, or replaying
 *      one out of a proxy log, buys nothing.
 *   3. **Comparison is constant-time.** `timingSafeEqual` on every code and
 *      recovery-code check — a six-digit space is small enough that a timing
 *      oracle genuinely helps an attacker.
 */

/** RFC 6238 §4: 30-second steps, SHA-1, 6 digits. What every authenticator app assumes. */
export const TOTP_STEP_SEC = 30
const TOTP_DIGITS = 6
/** ±1 step: RFC 6238 §5.2's recommended tolerance for clock drift. */
export const TOTP_WINDOW = 1

// ── base32 (RFC 4648, unpadded) — the alphabet otpauth:// URIs use ─────────

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''

  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []

  for (const char of clean) {
    const index = B32_ALPHABET.indexOf(char)
    if (index === -1) throw new TypeError(`not base32: ${char}`)
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/**
 * A fresh shared secret. 20 bytes — RFC 4226 §4 R6's recommendation and the
 * length of the RFC's own test key, so every authenticator app handles it.
 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

/**
 * The `otpauth://` URI the operator scans. Returned exactly once, at
 * enrollment, and never stored — it contains the secret in the clear.
 *
 * The label is `issuer:account` *and* `issuer` is repeated as a parameter:
 * older apps read one, newer ones the other, and an authenticator that shows
 * six digits under no name at all is how an operator ends up with three
 * unlabelled entries after two re-enrollments.
 */
export function totpUri(input: { secret: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`)
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SEC),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

/** The counter value for a moment in time. Exported because the replay guard stores it. */
export function totpStepAt(nowMs: number, stepSec: number = TOTP_STEP_SEC): number {
  return Math.floor(nowMs / 1000 / stepSec)
}

/**
 * HOTP — RFC 4226 §5.3. The dynamic truncation is the fiddly part and the part
 * the RFC's vectors actually pin down.
 */
export function hotp(secret: string, counter: number, digits: number = TOTP_DIGITS): string {
  const key = base32Decode(secret)
  const buffer = Buffer.alloc(8)
  // 64-bit big-endian counter. Written as two 32-bit halves because a step
  // count never approaches 2^53 and BigInt here would buy nothing.
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  buffer.writeUInt32BE(counter >>> 0, 4)

  const digest = createHmac('sha1', key).update(buffer).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff)

  return String(binary % 10 ** digits).padStart(digits, '0')
}

/** The code an authenticator app is showing right now. */
export function totpCodeAt(
  secret: string,
  nowMs: number,
  digits: number = TOTP_DIGITS,
  stepSec: number = TOTP_STEP_SEC,
): string {
  return hotp(secret, totpStepAt(nowMs, stepSec), digits)
}

export interface TotpVerification {
  /** The step the code matched. Store it as `lastTotpStep` — this is the replay guard. */
  readonly step: number
}

/**
 * Verifies a code, returning the step it matched or `null`.
 *
 * `minStep` is the replay guard: pass the credential's `lastTotpStep` and a
 * code from that step or earlier is refused even though it is arithmetically
 * correct. Without it, a valid code stays valid for its whole 30-second window
 * no matter how many times it is presented — which is the entire value of
 * intercepting one.
 */
export function verifyTotp(
  secret: string,
  code: string,
  options: { nowMs: number; window?: number; minStep?: number | null },
): TotpVerification | null {
  const trimmed = code.trim()
  if (!/^\d{6}$/.test(trimmed)) return null

  const window = options.window ?? TOTP_WINDOW
  const current = totpStepAt(options.nowMs)

  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset
    if (step < 0) continue
    if (options.minStep !== null && options.minStep !== undefined && step <= options.minStep) {
      continue
    }
    if (constantTimeEquals(hotp(secret, step), trimmed)) return { step }
  }
  return null
}

// ── AES-256-GCM at rest ────────────────────────────────────────────────────

const ENC_ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12 // GCM's standard nonce length

/** `iv:tag:ciphertext`, each base64. Self-describing, and one column. */
export function encryptTotpSecret(plaintext: string, keyBase64: string): string {
  if (plaintext === '') throw new TypeError('refusing to encrypt an empty TOTP secret')

  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ENC_ALGORITHM, totpKey(keyBase64), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])

  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64')).join(':')
}

/**
 * @throws {TypeError} for an empty, malformed, or tampered value.
 *
 * The empty-string case is explicit and is not paranoia: the seed writes `''`
 * into `totpSecretEnc` for an admin who has not enrolled (12 §4.1), and a
 * decrypt that quietly returned `''` for it would make an unenrolled admin
 * verifiable against a secret nobody holds.
 */
export function decryptTotpSecret(encrypted: string, keyBase64: string): string {
  if (encrypted === '') {
    throw new TypeError('no TOTP secret is stored — this admin has not enrolled')
  }

  const [ivB64, tagB64, ciphertextB64] = encrypted.split(':')
  if (ivB64 === undefined || tagB64 === undefined || ciphertextB64 === undefined) {
    throw new TypeError('malformed encrypted TOTP secret')
  }

  const decipher = createDecipheriv(
    ENC_ALGORITHM,
    totpKey(keyBase64),
    Buffer.from(ivB64, 'base64'),
  )
  // GCM authenticates: a tampered ciphertext throws on `final()` rather than
  // decrypting to garbage that then fails to verify a code, which would look
  // like the operator mistyping.
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

function totpKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64')
  if (key.length !== 32) {
    throw new TypeError(`ADMIN_TOTP_ENC_KEY must decode to 32 bytes, got ${key.length}`)
  }
  return key
}

// ── recovery codes ─────────────────────────────────────────────────────────

/** Ten, per §3.3. Enough to survive a lost phone; few enough to print. */
export const RECOVERY_CODE_COUNT = 10
/** Crockford-ish: no I, O, 0 or 1, because these get read aloud and written down. */
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export interface RecoveryCodes {
  /** Shown to the operator **once**. Never stored, never logged, never re-derivable. */
  readonly codes: readonly string[]
  /** What goes in the database: sha256 of each, JSON-encoded by the caller. */
  readonly hashes: readonly string[]
}

export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): RecoveryCodes {
  const codes: string[] = []

  for (let i = 0; i < count; i += 1) {
    let code = ''
    for (let c = 0; c < 10; c += 1) {
      if (c === 5) code += '-'
      code += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]!
    }
    codes.push(code)
  }

  return { codes, hashes: codes.map(hashRecoveryCode) }
}

/**
 * Plain sha256, deliberately — **not** argon2.
 *
 * A recovery code is 50 bits of uniform randomness from a generator we control,
 * so there is no dictionary to attack and nothing for a slow KDF to buy. The
 * argon2 cost exists for passwords, which humans choose badly.
 */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex')
}

/** Typed by a human under pressure: case and dashes must not matter. */
export function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]/g, '')
}

/**
 * Finds the matching hash, or `null`. The caller removes it from the stored
 * list — a recovery code is single-use, which is most of the point of there
 * being ten of them.
 */
export function matchRecoveryCode(code: string, hashes: readonly string[]): string | null {
  const candidate = hashRecoveryCode(code)
  for (const hash of hashes) {
    if (constantTimeEquals(hash, candidate)) return hash
  }
  return null
}

/**
 * Compares the sha256 of each side rather than the bytes.
 *
 * `timingSafeEqual` throws outright on a length mismatch, which would leak the
 * length and turn every comparison into a branch. Hashing first makes both
 * sides exactly 32 bytes, so one code path handles equal and unequal lengths
 * alike — the standard way to make a variable-length comparison constant-time.
 */
function constantTimeEquals(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a, 'utf8').digest(),
    createHash('sha256').update(b, 'utf8').digest(),
  )
}
