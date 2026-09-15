import { describe, expect, it } from 'vitest'
import {
  base32Decode,
  base32Encode,
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  hotp,
  matchRecoveryCode,
  normalizeRecoveryCode,
  totpCodeAt,
  totpStepAt,
  totpUri,
  verifyTotp,
  TOTP_STEP_SEC,
} from '../../../src/infrastructure/admin/totp.js'

/**
 * S49 — the second factor, checked against the specification rather than
 * against itself.
 *
 * Every assertion about the algorithm below comes from **RFC 6238 Appendix B**
 * and **RFC 4226 Appendix D**, which publish concrete values for a known key.
 * That is the whole reason hand-writing this was defensible: a TOTP
 * implementation that agrees with its own test suite and with nothing else
 * fails on the operator's phone, at the only moment it matters, with no way to
 * tell whether the code, the clock or the app is wrong.
 */

/** RFC 6238 Appendix B: the ASCII seed "12345678901234567890", as base32. */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'))

const KEY = Buffer.alloc(32, 9).toString('base64')

describe('base32 (RFC 4648) — what an authenticator app reads', () => {
  it('round-trips arbitrary bytes', () => {
    for (const text of ['', 'a', 'ab', 'abc', 'abcd', 'abcde', '12345678901234567890']) {
      expect(base32Decode(base32Encode(Buffer.from(text))).toString()).toBe(text)
    }
  })

  it('matches RFC 4648 §10 test vectors', () => {
    expect(base32Encode(Buffer.from('f'))).toBe('MY')
    expect(base32Encode(Buffer.from('fo'))).toBe('MZXQ')
    expect(base32Encode(Buffer.from('foo'))).toBe('MZXW6')
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI')
  })

  it('is case-insensitive and tolerates the spaces apps insert', () => {
    expect(base32Decode('mzxw6ytboi').toString()).toBe('foobar')
    expect(base32Decode('MZXW 6YTB OI').toString()).toBe('foobar')
  })

  it('refuses a character outside the alphabet', () => {
    expect(() => base32Decode('MZXW6YTB01')).toThrow(/base32/)
  })
})

describe('★ HOTP against RFC 4226 Appendix D', () => {
  // The RFC's table, for the key above, counters 0..9.
  const EXPECTED = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ]

  it.each(EXPECTED.map((code, counter) => ({ counter, code })))(
    'counter $counter → $code',
    ({ counter, code }) => {
      expect(hotp(RFC_SECRET, counter)).toBe(code)
    },
  )
})

describe('★★ TOTP against RFC 6238 Appendix B', () => {
  /**
   * The RFC publishes 8-digit values; an authenticator app shows the last 6 of
   * the same number, which is what `TOTP_DIGITS` picks. Asserting at 8 digits
   * pins the truncation *and* the counter arithmetic — the 6-digit form would
   * still pass if the top two digits were wrong.
   */
  const VECTORS = [
    { timeSec: 59, code: '94287082' },
    { timeSec: 1_111_111_109, code: '07081804' },
    { timeSec: 1_111_111_111, code: '14050471' },
    { timeSec: 1_234_567_890, code: '89005924' },
    { timeSec: 2_000_000_000, code: '69279037' },
    { timeSec: 20_000_000_000, code: '65353130' },
  ]

  it.each(VECTORS)('T=$timeSec → $code', ({ timeSec, code }) => {
    expect(hotp(RFC_SECRET, totpStepAt(timeSec * 1000), 8)).toBe(code)
  })

  it('and the 6-digit form an app actually shows is the tail of it', () => {
    for (const { timeSec, code } of VECTORS) {
      expect(totpCodeAt(RFC_SECRET, timeSec * 1000)).toBe(code.slice(-6))
    }
  })

  it('advances every 30 seconds, and not within one', () => {
    const base = 1_700_000_000_000
    const step = TOTP_STEP_SEC * 1000
    const start = Math.floor(base / step) * step

    expect(totpCodeAt(RFC_SECRET, start)).toBe(totpCodeAt(RFC_SECRET, start + step - 1))
    expect(totpCodeAt(RFC_SECRET, start)).not.toBe(totpCodeAt(RFC_SECRET, start + step))
  })
})

describe('verifyTotp — the ±1 window and the replay guard', () => {
  const now = 1_700_000_000_000

  it('accepts the current code and reports its step', () => {
    const result = verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, now), { nowMs: now })
    expect(result?.step).toBe(totpStepAt(now))
  })

  it('accepts one step either side — RFC 6238 §5.2 clock drift', () => {
    const step = TOTP_STEP_SEC * 1000
    expect(verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, now - step), { nowMs: now })).not.toBeNull()
    expect(verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, now + step), { nowMs: now })).not.toBeNull()
  })

  it('refuses two steps away — the window is tolerance, not a free minute', () => {
    const step = TOTP_STEP_SEC * 1000
    expect(verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, now - 2 * step), { nowMs: now })).toBeNull()
    expect(verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, now + 2 * step), { nowMs: now })).toBeNull()
  })

  it('★★ the SAME code is refused once its step has been spent (the replay guard)', () => {
    const code = totpCodeAt(RFC_SECRET, now)
    const first = verifyTotp(RFC_SECRET, code, { nowMs: now, minStep: null })

    expect(first).not.toBeNull()
    // `AdminAuthService` writes `first.step` to `lastTotpStep`; presenting the
    // same six digits half a second later now fails. Without this, intercepting
    // one code buys the full 30-second window, however many times it is used.
    expect(verifyTotp(RFC_SECRET, code, { nowMs: now, minStep: first!.step })).toBeNull()
  })

  it('and so is an EARLIER code, not merely the same one', () => {
    const step = TOTP_STEP_SEC * 1000
    const spent = totpStepAt(now)
    const older = totpCodeAt(RFC_SECRET, now - step)

    expect(verifyTotp(RFC_SECRET, older, { nowMs: now, minStep: spent })).toBeNull()
  })

  it('but the NEXT step still works — the guard must not lock the operator out', () => {
    const step = TOTP_STEP_SEC * 1000
    const spent = totpStepAt(now)
    const next = totpCodeAt(RFC_SECRET, now + step)

    expect(verifyTotp(RFC_SECRET, next, { nowMs: now, minStep: spent })).not.toBeNull()
  })

  it.each(['', '12345', '1234567', 'abcdef', '12 34 56', '000000x'])(
    'refuses a malformed code without touching the secret: %o',
    (code) => {
      expect(verifyTotp(RFC_SECRET, code, { nowMs: now })).toBeNull()
    },
  )

  it('tolerates surrounding whitespace, which phones and clipboards add', () => {
    expect(verifyTotp(RFC_SECRET, ` ${totpCodeAt(RFC_SECRET, now)} `, { nowMs: now })).not.toBeNull()
  })
})

describe('secrets at rest — AES-256-GCM (12 §3.3)', () => {
  it('★ the stored value contains no trace of the base32 secret', () => {
    const secret = generateTotpSecret()
    const stored = encryptTotpSecret(secret, KEY)

    // The assertion that matters: a database dump is not a second factor.
    expect(stored).not.toContain(secret)
    expect(stored.toUpperCase()).not.toContain(secret.toUpperCase())
    expect(stored.split(':')).toHaveLength(3)
  })

  it('round-trips', () => {
    const secret = generateTotpSecret()
    expect(decryptTotpSecret(encryptTotpSecret(secret, KEY), KEY)).toBe(secret)
  })

  it('encrypts the same secret differently every time — a fresh IV per write', () => {
    const secret = generateTotpSecret()
    const a = encryptTotpSecret(secret, KEY)
    const b = encryptTotpSecret(secret, KEY)

    // Equal ciphertexts would mean two admins with the same secret were
    // identifiable as such from the table alone.
    expect(a).not.toBe(b)
    expect(decryptTotpSecret(a, KEY)).toBe(decryptTotpSecret(b, KEY))
  })

  it('★ refuses a tampered ciphertext rather than decrypting to garbage', () => {
    const stored = encryptTotpSecret(generateTotpSecret(), KEY)
    const [iv, tag, ct] = stored.split(':')
    const flipped = Buffer.from(ct!, 'base64')
    flipped[0] = flipped[0]! ^ 0xff

    // GCM authenticates. Without the tag check this would decrypt to noise and
    // present as the operator mistyping their code, forever.
    expect(() => decryptTotpSecret(`${iv}:${tag}:${flipped.toString('base64')}`, KEY)).toThrow()
  })

  it('refuses the wrong key', () => {
    const stored = encryptTotpSecret(generateTotpSecret(), KEY)
    const otherKey = Buffer.alloc(32, 1).toString('base64')

    expect(() => decryptTotpSecret(stored, otherKey)).toThrow()
  })

  it('refuses a key that is not 32 bytes — naming the length it got', () => {
    expect(() => encryptTotpSecret('X', Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/)
  })

  it('★★ refuses the seed placeholder — an unenrolled admin verifies against nothing', () => {
    // 12 §4.1 seeds `totpSecretEnc: ''`. A decrypt that returned '' for it
    // would make an admin who has never enrolled look verifiable.
    expect(() => decryptTotpSecret('', KEY)).toThrow(/not enrolled/)
    expect(() => encryptTotpSecret('', KEY)).toThrow(/empty/)
  })

  it('refuses a malformed stored value', () => {
    expect(() => decryptTotpSecret('nonsense', KEY)).toThrow(/malformed/)
    expect(() => decryptTotpSecret('a:b', KEY)).toThrow(/malformed/)
  })
})

describe('the provisioning URI', () => {
  const uri = totpUri({ secret: 'JBSWY3DPEHPK3PXP', account: 'admin@local.dev', issuer: 'Boardgames' })

  it('is a scannable otpauth:// URI carrying the parameters apps need', () => {
    expect(uri.startsWith('otpauth://totp/')).toBe(true)
    const params = new URL(uri).searchParams
    expect(params.get('secret')).toBe('JBSWY3DPEHPK3PXP')
    expect(params.get('issuer')).toBe('Boardgames')
    expect(params.get('algorithm')).toBe('SHA1')
    expect(params.get('digits')).toBe('6')
    expect(params.get('period')).toBe('30')
  })

  it('labels the entry — an unnamed row is how re-enrollment leaves three of them', () => {
    expect(decodeURIComponent(uri)).toContain('Boardgames:admin@local.dev')
  })
})

describe('recovery codes (12 §3.3)', () => {
  it('issues ten, and stores only their hashes', () => {
    const { codes, hashes } = generateRecoveryCodes()

    expect(codes).toHaveLength(10)
    expect(hashes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10)
    for (const code of codes) expect(hashes).not.toContain(code)
  })

  it('★ avoids the characters that get misread when written down', () => {
    const { codes } = generateRecoveryCodes(40)
    // No I/O/0/1 — these are read aloud over the phone and copied by hand at
    // the one moment the operator has already lost their phone.
    expect(codes.join('')).not.toMatch(/[IO01]/)
  })

  it('matches regardless of case, spacing or dashes', () => {
    const { codes, hashes } = generateRecoveryCodes()
    const code = codes[3]!

    expect(matchRecoveryCode(code, hashes)).toBe(hashRecoveryCode(code))
    expect(matchRecoveryCode(code.toLowerCase(), hashes)).not.toBeNull()
    expect(matchRecoveryCode(code.replace('-', ''), hashes)).not.toBeNull()
    expect(matchRecoveryCode(` ${code} `, hashes)).not.toBeNull()
  })

  it('returns null for a code that is not in the list', () => {
    const { hashes } = generateRecoveryCodes()
    expect(matchRecoveryCode('ZZZZZ-ZZZZZ', hashes)).toBeNull()
  })

  it('normalizes to something a hash can be taken of deterministically', () => {
    expect(normalizeRecoveryCode(' ab-cde fghij ')).toBe('ABCDEFGHIJ')
  })
})

describe('generateTotpSecret', () => {
  it('is 160 bits, per RFC 4226 §4 R6', () => {
    expect(base32Decode(generateTotpSecret())).toHaveLength(20)
  })

  it('is different every time', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateTotpSecret()))
    expect(secrets.size).toBe(50)
  })
})
