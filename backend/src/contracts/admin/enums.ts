import { z } from 'zod'

/**
 * The admin console's vocabulary — 12-admin-console.md §4, §6.2, §7.3.
 *
 * Same discipline as `contracts/enums.ts`: the schema stores a `String` and the
 * union lives here, so the database stays inside the SQLite ∩ Postgres
 * intersection (02 §6.2) and the widening happens in exactly one place
 * (`infrastructure/prisma/mappers.ts`).
 *
 * > **Note for MA.** `sync-contracts.mjs` mirrors this directory *alone* into
 * > `admin-frontend/src/contracts`, so anything here that imports from `../`
 * > will not resolve once that project exists. Admin-only vocabulary therefore
 * > lives in this file rather than being appended to the shared enums; where a
 * > shared type is genuinely needed (`UserRole`, `UserStatus`), the admin DTOs
 * > import it from `../enums.js` and MA must widen that mirror's source rather
 * > than duplicate the union.
 */

/**
 * 12 §7.3 — three states, and the middle one is the useful one.
 *
 * | State | Welcome page | Live matches | New tables |
 * |---|---|---|---|
 * | `ENABLED` | listed | play on | allowed |
 * | `HIDDEN` | **absent** | **play on** | allowed by direct link |
 * | `DISABLED` | absent | closed at the hand boundary | refused |
 *
 * `HIDDEN` exists because the realistic operational need is "stop *new* people
 * finding this while we look at it", and the alternative — `DISABLED` — ends
 * matches that four people are halfway through.
 */
export const GAME_FLAG_STATES = ['ENABLED', 'HIDDEN', 'DISABLED'] as const
export type GameFlagState = (typeof GAME_FLAG_STATES)[number]
export const GameFlagStateSchema = z.enum(GAME_FLAG_STATES)

/** The two `PlatformFlag` keys that exist in v1 (12 §7.3). */
export const PLATFORM_FLAG_KEYS = ['maintenance', 'registrationOpen'] as const
export type PlatformFlagKey = (typeof PLATFORM_FLAG_KEYS)[number]
export const PlatformFlagKeySchema = z.enum(PLATFORM_FLAG_KEYS)

/** What an audit row points at. Kept coarse on purpose — it is a filter, not a foreign key. */
export const ADMIN_TARGET_TYPES = [
  'user',
  'table',
  'game',
  'flag',
  'wallet',
  'rewardRule',
  'storeItem',
  'report',
  'cooldown',
  'session',
] as const
export type AdminTargetType = (typeof ADMIN_TARGET_TYPES)[number]
export const AdminTargetTypeSchema = z.enum(ADMIN_TARGET_TYPES)

/**
 * Every mutating admin action, as a closed set — 12 §3.5.
 *
 * Closed rather than a free `string` because this is the column an investigation
 * filters on. A typo'd `'user.disabled'` alongside `'user.disable'` would split
 * one history into two, silently, and only ever be noticed by the person who
 * most needed it not to be.
 *
 * The list is deliberately ahead of the routes: S50 implements `user.disable`
 * and `admin.login` only, and M2/M3/MA fill in the rest against names that were
 * agreed before anyone was in a hurry.
 */
export const ADMIN_ACTIONS = [
  // Auth — 12 §3.3. Logins are audited too: "who was in the console at 3am"
  // is an audit question, and a log that only records writes cannot answer it.
  'admin.login',
  'admin.logout',
  'admin.totpEnroll',
  'admin.stepUp',

  // Users & moderation — §7.1
  'user.disable',
  'user.enable',
  'user.ban',
  'user.forceLogout',
  'user.resetDisplayName',
  'user.passwordReset',
  'user.roleChange',
  'report.resolve',

  // Economy — §7.2
  'wallet.adjust',
  'wallet.reconcile',
  'rewardRule.update',
  'storeItem.update',

  // Platform — §7.3
  'game.setFlag',
  'flag.set',
  'table.close',
  'table.kickSeat',
  'broadcast.send',
  'cooldown.clear',
] as const
export type AdminAction = (typeof ADMIN_ACTIONS)[number]
export const AdminActionSchema = z.enum(ADMIN_ACTIONS)

/**
 * 12 §6.2 — what the admin process asks the gameplay process to do.
 *
 * The kinds are the *catalog*; the payloads are in `control.ts`. They are
 * separate because the outbox row stores the kind in a queryable column and the
 * payload as JSON (rule 3), and only the consumer ever parses the latter.
 */
export const CONTROL_COMMAND_KINDS = [
  'table.close',
  'table.kickSeat',
  'user.forceLogout',
  'user.disabled',
  'game.stateChanged',
  'platform.flagChanged',
  'broadcast',
] as const
export type ControlCommandKind = (typeof CONTROL_COMMAND_KINDS)[number]
export const ControlCommandKindSchema = z.enum(CONTROL_COMMAND_KINDS)
