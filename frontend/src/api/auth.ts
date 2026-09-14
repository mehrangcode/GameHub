import { api } from './client'
import type {
  AuthSessionResponse,
  GuestClaimRequest,
  GuestClaimResponse,
  GuestRequest,
  Identity,
  LoginRequest,
  RegisterRequest,
} from '@/contracts/dto/auth'

/**
 * One module per resource, each returning `contracts/`-typed DTOs. Components
 * never touch `api` directly — 06 §4.1.
 *
 * Every function here returns the *parsed* shape the backend declared in the
 * shared contract, so a route that changes shape is a compile error on the next
 * `contracts:sync` rather than an `undefined` at render time.
 */

export async function register(input: RegisterRequest): Promise<AuthSessionResponse> {
  const { data } = await api.post<AuthSessionResponse>('/auth/register', input)
  return data
}

export async function login(input: LoginRequest): Promise<AuthSessionResponse> {
  const { data } = await api.post<AuthSessionResponse>('/auth/login', input)
  return data
}

export async function logout(): Promise<void> {
  await api.post('/auth/logout')
}

/**
 * `GET /auth/me` answers with the identity itself — no envelope. A 401 here is
 * the ordinary "not signed in" answer, so callers treat it as a value, not a
 * failure.
 */
export async function me(): Promise<Identity> {
  const { data } = await api.get<Identity>('/auth/me')
  return data
}

/** Journey J1→J2: a name and an invite code, and you are playing. No account. */
export async function joinAsGuest(input: GuestRequest): Promise<AuthSessionResponse> {
  const { data } = await api.post<AuthSessionResponse>('/auth/guest', input)
  return data
}

/**
 * ★ The claim — 03 §6.1.
 *
 * There is no `guestSessionId` or `tableId` to pass: which guest is being
 * claimed comes from the `guest` cookie, and `redirectTo` is decided by the
 * same transaction that preserved the seat. The client never reconstructs the
 * destination, because a client that guessed could guess a different table.
 */
export async function claimGuestAccount(input: GuestClaimRequest): Promise<GuestClaimResponse> {
  const { data } = await api.post<GuestClaimResponse>('/auth/guest/claim', input)
  return data
}
