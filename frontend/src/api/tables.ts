import { api } from './client'
import type {
  CreateTableRequest,
  PatchTableRequest,
  TableDetail,
  TableSummary,
} from '@/contracts/dto/tables'

/**
 * Table *lifecycle* only — 02 §3.1.
 *
 * ★ No game state crosses this module, and that is a transport rule rather than
 * an omission. Cards, hands, turn order and legal moves travel over the socket,
 * projected once per viewer, because that is the only path with a
 * `projectState` boundary on it. If you ever find yourself adding
 * `getTableState()` here, the thing you want is `gameStore`.
 */

export async function createTable(input: CreateTableRequest): Promise<TableDetail> {
  const { data } = await api.post<TableDetail>('/tables', input)
  return data
}

export async function myTables(): Promise<TableSummary[]> {
  const { data } = await api.get<TableSummary[]>('/tables/mine')
  return data
}

export async function getTable(id: string): Promise<TableDetail> {
  const { data } = await api.get<TableDetail>(`/tables/${encodeURIComponent(id)}`)
  return data
}

export async function patchTable(id: string, patch: PatchTableRequest): Promise<TableDetail> {
  const { data } = await api.patch<TableDetail>(`/tables/${encodeURIComponent(id)}`, patch)
  return data
}

/** Closes the table; the row is never deleted, only stamped `closedAt`. */
export async function closeTable(id: string): Promise<void> {
  await api.delete(`/tables/${encodeURIComponent(id)}`)
}
