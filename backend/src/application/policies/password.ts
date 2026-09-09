import { ValidationError } from '../../domain/errors/errors.js'

/**
 * Password policy — 07 §5.3.
 *
 * The length floor (10 characters) is in `contracts/dto/auth.ts` so the form
 * enforces it before a request is made. What lives here is the part that needs
 * the *rest of the request* to evaluate: a password must not be one of the
 * handful of passwords everybody picks, and must not simply be the user's own
 * email or display name.
 *
 * There are deliberately **no composition rules**. Requiring an uppercase, a
 * digit and a symbol reliably produces `Password1!` — 12 characters of almost
 * no entropy that satisfies every rule. 07 §5.3 rejects them for that reason.
 */

/**
 * A short list, not a 100k-entry corpus. The value of the long lists is in
 * blocking credential-stuffing reuse, which a real breach-corpus check (k-
 * anonymity against an external service) would do properly — and which is not
 * something to add before the app has users.
 */
export const COMMON_PASSWORDS: readonly string[] = [
  'password',
  'password1',
  'password123',
  'passw0rd',
  '1234567890',
  '12345678901',
  '123456789012',
  'qwertyuiop',
  'qwerty123',
  'letmein123',
  'iloveyou123',
  'welcome123',
  'admin12345',
  'football123',
  'baseball123',
  'trustno1234',
  'dragon1234',
  'sunshine123',
  'princess123',
  'monkey12345',
  'abc123456789',
  'changeme123',
  'secret1234',
  'passphrase',
]

export interface PasswordContext {
  readonly email?: string
  readonly displayName?: string
}

/**
 * @throws {ValidationError} with `password` in `fieldErrors`.
 */
export function assertPasswordAcceptable(password: string, context: PasswordContext = {}): void {
  const folded = password.toLowerCase()

  if (COMMON_PASSWORDS.includes(folded)) {
    throw reject('errors.passwordTooCommon')
  }

  // A single repeated character passes a length check and nothing else.
  if (new Set(folded).size <= 3) {
    throw reject('errors.passwordTooSimple')
  }

  for (const personal of personalTokens(context)) {
    if (personal.length >= 4 && folded.includes(personal)) {
      throw reject('errors.passwordTooPersonal')
    }
  }
}

/** The email's local part and the display name, folded the same way. */
function personalTokens(context: PasswordContext): string[] {
  const tokens: string[] = []
  if (context.email) tokens.push((context.email.split('@')[0] ?? '').toLowerCase())
  if (context.displayName) tokens.push(context.displayName.toLowerCase())
  return tokens.filter((token) => token.length > 0)
}

function reject(i18nKey: string): ValidationError {
  return new ValidationError('Password is not acceptable', { password: [i18nKey] })
}
