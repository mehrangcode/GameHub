import { api } from './client'
import type { GameDetail, GameSummary } from '@/contracts/dto/games'

/**
 * The registry, as the welcome page reads it — 02 §5, S41.
 *
 * ★ Nothing here is a hard-coded list of games. `GET /games` is driven by the
 * backend registry, which is what lets game #6 appear on the welcome page with
 * **no frontend deploy** (P5). Every label in the payload is an i18n key, never
 * "Shelem", so a Persian reader gets a Persian card.
 */

export async function listGames(): Promise<GameSummary[]> {
  const { data } = await api.get<GameSummary[]>('/games')
  return data
}

export async function getGame(slug: string): Promise<GameDetail> {
  const { data } = await api.get<GameDetail>(`/games/${encodeURIComponent(slug)}`)
  return data
}
