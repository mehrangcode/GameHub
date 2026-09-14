import { create } from 'zustand'
import type { MemberView, TableDetail } from '@/contracts/dto/tables'
import type {
  MemberJoinedPayload,
  MemberLeftPayload,
  OptionsChangedPayload,
  PresencePayload,
  SeatChangedPayload,
  StatusChangedPayload,
  TableSnapshotPayload,
  YouView,
} from '@/contracts/events'

/**
 * The lobby — members, seats, options, presence (06 §3).
 *
 * Kept separate from `gameStore` because the two have different lifetimes: the
 * table outlives any single game, and a finished match must not blank the seat
 * map everyone is still sitting in.
 *
 * `members` is indexed by person and carries spectators; `table.seats` is
 * indexed by seat and always has exactly `seatCount` entries, so the "sit here"
 * buttons have something to bind to. Both, because neither answers the other's
 * question.
 */

interface TableState {
  table: TableDetail | null
  members: MemberView[]
  you: YouView | null
  connectedTableId: string | null

  hydrate: (payload: TableSnapshotPayload) => void
  applyMemberJoined: (payload: MemberJoinedPayload) => void
  applyMemberLeft: (payload: MemberLeftPayload) => void
  applySeatChanged: (payload: SeatChangedPayload) => void
  applyOptionsChanged: (payload: OptionsChangedPayload) => void
  applyStatusChanged: (payload: StatusChangedPayload) => void
  applyPresence: (payload: PresencePayload) => void
  reset: () => void
}

export const useTableStore = create<TableState>()((set, get) => ({
  table: null,
  members: [],
  you: null,
  connectedTableId: null,

  hydrate: (payload) => {
    set({
      table: payload.table,
      members: [...payload.members],
      you: payload.you,
      connectedTableId: payload.table.id,
    })
  },

  applyMemberJoined: (payload) => {
    const members = get().members.filter((m) => m.memberId !== payload.member.memberId)
    set({ members: [...members, payload.member] })
  },

  applyMemberLeft: (payload) => {
    set({ members: get().members.filter((m) => m.memberId !== payload.memberId) })
  },

  applySeatChanged: (payload) => {
    const table = get().table
    if (table === null || table.id !== payload.tableId) return

    const seats = table.seats.map((seat) =>
      seat.seat === payload.seat
        ? {
            ...seat,
            memberId: payload.memberId,
            occupant: payload.occupant,
            team: payload.team,
            botSubstituted: payload.botSubstituted,
            // `isSelf` cannot be recomputed here — the payload deliberately
            // carries no ids (a seat map is shown to spectators). The snapshot
            // that follows a reconnect is what re-establishes it; until then
            // the previous value is the best answer we have.
            isSelf: payload.memberId === null ? false : seat.isSelf,
          }
        : seat,
    )

    set({
      table: {
        ...table,
        seats,
        seatsTaken: seats.filter((seat) => seat.occupant !== null).length,
      },
    })
  },

  applyOptionsChanged: (payload) => {
    const table = get().table
    if (table === null || table.id !== payload.tableId) return

    set({
      table: {
        ...table,
        options: payload.options,
        seatCount: payload.seatCount,
        allowSpectators: payload.allowSpectators,
        requireApproval: payload.requireApproval,
      },
    })
  },

  applyStatusChanged: (payload) => {
    const table = get().table
    if (table === null || table.id !== payload.tableId) return
    set({ table: { ...table, status: payload.status } })
  },

  applyPresence: (payload) => {
    set({
      members: get().members.map((member) =>
        member.memberId === payload.memberId
          ? { ...member, presence: payload.state, graceEndsAt: payload.graceEndsAt }
          : member,
      ),
    })
  },

  reset: () => {
    set({ table: null, members: [], you: null, connectedTableId: null })
  },
}))
