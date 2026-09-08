// AUTO-GENERATED FROM backend/src/contracts — DO NOT EDIT
// Run `npm run contracts:sync` in backend/ to regenerate.

import { z } from 'zod'

/** Cursor pagination — the only pagination shape in the API. */
export const CursorPageSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

export type CursorPage = z.infer<typeof CursorPageSchema>

export type Paginated<T> = {
  items: T[]
  nextCursor: string | null
}

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
})

export type HealthResponse = z.infer<typeof HealthResponseSchema>
