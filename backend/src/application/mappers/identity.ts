import type { GuestIdentity, UserIdentity } from '../../contracts/dto/auth.js'
import type { GuestSession, User } from '../../domain/entities/user.js'

/**
 * Entity → wire identity.
 *
 * These exist as named functions with an explicit return type for one reason:
 * `User` carries `passwordHash`, and the only thing standing between it and a
 * JSON response is that nobody ever spreads the entity into a payload. Listing
 * the fields by hand makes the omission structural — add a column to `User` and
 * it does not appear in an API response until somebody writes it here.
 */

export function toUserIdentity(user: User): UserIdentity {
  return {
    kind: 'user',
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarKind: user.avatarKind,
    avatarRef: user.avatarRef,
    locale: user.locale,
    role: user.role,
  }
}

export function toGuestIdentity(guest: GuestSession): GuestIdentity {
  return {
    kind: 'guest',
    guestSessionId: guest.id,
    displayName: guest.displayName,
    tableId: guest.tableId,
    avatarRef: guest.avatarRef,
    locale: guest.locale,
    expiresAt: guest.expiresAt.toISOString(),
  }
}
