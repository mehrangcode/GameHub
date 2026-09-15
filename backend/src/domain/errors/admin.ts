import { AppError } from './AppError.js'

/**
 * 12-admin-console.md §5.1 — the six failures only the admin process can
 * produce. Same base class, same `{ code, i18nKey, details }` wire shape as
 * every other error in the platform (02 §5.6).
 *
 * Two of them are worth reading as design rather than plumbing:
 *
 *   - {@link StepUpRequiredError} is the entire cost of making a stolen laptop
 *     session unable to mint coins. The operator loses four seconds and types
 *     six digits; whoever walked past their desk loses everything.
 *   - {@link ReasonRequiredError} is thrown **before** any write, so a 📝 route
 *     called without a reason changes nothing. A `reason` that were merely a
 *     UI placeholder would leave the audit log full of rows that record what
 *     happened and never why — which is the half that matters six months later.
 */

/** Session valid, second factor stale (§3.4). The client re-prompts and replays. */
export class StepUpRequiredError extends AppError {
  readonly code = 'STEP_UP_REQUIRED' as const
  readonly httpStatus = 401
  readonly i18nKey = 'errors.admin.stepUpRequired'

  constructor(details?: Record<string, unknown>) {
    super('A fresh second factor is required for this action', details)
  }
}

/**
 * The password step succeeded and the code has not been supplied yet.
 *
 * Deliberately **not** thrown by `POST /auth/login`, which answers 200 with a
 * `challengeId` — this is for a protected route reached with a half-finished
 * login, so a client that skipped step two gets a code it can act on rather
 * than a bare 401 it would read as "wrong password".
 */
export class MfaRequiredError extends AppError {
  readonly code = 'MFA_REQUIRED' as const
  readonly httpStatus = 401
  readonly i18nKey = 'errors.admin.mfaRequired'

  constructor(details?: Record<string, unknown>) {
    super('Second factor required', details)
  }
}

/**
 * The admin has no TOTP secret yet (§3.3).
 *
 * 403 rather than 401: the credentials were fine. The only route that does not
 * throw this for an unenrolled admin is `POST /auth/totp/enroll`, which is what
 * makes enrollment mandatory instead of merely recommended.
 */
export class MfaEnrollmentRequiredError extends AppError {
  readonly code = 'MFA_ENROLLMENT_REQUIRED' as const
  readonly httpStatus = 403
  readonly i18nKey = 'errors.admin.mfaEnrollmentRequired'

  constructor(details?: Record<string, unknown>) {
    super('Second-factor enrollment is required before anything else', details)
  }
}

/**
 * Too many failed codes (§3.3). **423 Locked**, not 429: this is not a rate
 * limit that decays as you stop knocking, it is an account state with an end
 * time, and `lockedUntil` travels in `details` so the console can say when.
 */
export class AdminLockedError extends AppError {
  readonly code = 'ADMIN_LOCKED' as const
  readonly httpStatus = 423
  readonly i18nKey = 'errors.admin.locked'

  constructor(lockedUntil?: Date, details?: Record<string, unknown>) {
    super('Admin account is temporarily locked', {
      ...(lockedUntil === undefined ? {} : { lockedUntil: lockedUntil.toISOString() }),
      ...details,
    })
  }
}

/** A 📝 route called without a `reason`. Thrown before the transaction opens. */
export class ReasonRequiredError extends AppError {
  readonly code = 'REASON_REQUIRED' as const
  readonly httpStatus = 400
  readonly i18nKey = 'errors.admin.reasonRequired'

  constructor(action?: string, details?: Record<string, unknown>) {
    super(action === undefined ? 'A reason is required' : `A reason is required for ${action}`, {
      ...(action === undefined ? {} : { action }),
      ...details,
    })
  }
}

/**
 * A role change or a ban aimed at the acting admin (§5.1).
 *
 * Refused because the realistic version of this is not malice, it is an
 * operator with two tabs open demoting the account they are using — and the
 * recovery from a platform with no remaining `ADMIN` is CLI plus database
 * access, at whatever hour it happens.
 */
export class SelfTargetError extends AppError {
  readonly code = 'SELF_TARGET_FORBIDDEN' as const
  readonly httpStatus = 409
  readonly i18nKey = 'errors.admin.selfTargetForbidden'

  constructor(details?: Record<string, unknown>) {
    super('An admin may not aim this action at their own account', details)
  }
}
