import { api } from './client'
import type {
  InviteResponse,
  PublicInviteResponse,
  RedeemInviteResponse,
} from '@/contracts/dto/invites'

/**
 * ★ `resolveInvite` is called with **no authentication at all** — that is the
 * property that makes an invite link work in a private window (journey J1→J2,
 * 07 §5.2). If this ever needs a cookie, the signup wall is back.
 *
 * A revoked code and a code that never existed answer identically, on purpose:
 * distinguishing them would turn this route into an oracle for enumerating live
 * invites. The UI must therefore render one message for both.
 */
export async function resolveInvite(code: string): Promise<PublicInviteResponse> {
  const { data } = await api.get<PublicInviteResponse>(`/invites/${encodeURIComponent(code)}`)
  return data
}

/**
 * The signed-in counterpart — S43. A guest gets their destination from
 * `POST /auth/guest`; a user who already has an account gets it from here,
 * rather than being asked to become a guest to use their friend's link.
 */
export async function redeemInvite(code: string): Promise<RedeemInviteResponse> {
  const { data } = await api.post<RedeemInviteResponse>(
    `/invites/${encodeURIComponent(code)}/redeem`,
  )
  return data
}

/** Host-side: mint a link for a table you own. */
export async function createInvite(tableId: string): Promise<InviteResponse> {
  const { data } = await api.post<InviteResponse>(
    `/tables/${encodeURIComponent(tableId)}/invites`,
    {},
  )
  return data
}

export async function listInvites(tableId: string): Promise<InviteResponse[]> {
  const { data } = await api.get<InviteResponse[]>(`/tables/${encodeURIComponent(tableId)}/invites`)
  return data
}

export async function revokeInvite(tableId: string, code: string): Promise<void> {
  await api.delete(
    `/tables/${encodeURIComponent(tableId)}/invites/${encodeURIComponent(code)}`,
  )
}
