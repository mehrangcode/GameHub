import { CHAT_BODY_MAX } from '../../contracts/dto/chat.js'
import { ValidationError } from '../../domain/errors/errors.js'
import { BLOCKED_SUBSTRINGS, normalizeDisplayName } from './displayName.js'

/**
 * Chat body policy — S26.
 *
 * The deliberate asymmetry with `assertDisplayNameAllowed`: a bad display name
 * is **refused**, a bad chat message is **masked**. A name is chosen once,
 * persists, and is how you are addressed for the whole evening, so making
 * somebody pick again is proportionate. A message is a sentence in a live
 * conversation — refusing it mid-hand teaches people that chat is unreliable,
 * and the swear was already thought. Masking keeps the conversation flowing and
 * removes the word.
 *
 * The list itself is the short reviewable one from `displayName.ts`, reused
 * rather than duplicated: two lists would drift, and the one that got forgotten
 * would be the one that mattered.
 *
 * > **Open question:** the Persian entries still need a native-speaker pass
 * > before M0 ships. Under-blocking stays the safe direction.
 */

/** What a masked word is replaced with. Visibly censored, not silently dropped. */
const MASK = '███'

/**
 * Code-point ranges stripped from every body: control characters (keeping tab
 * and newline), zero-width characters, and the bidirectional overrides.
 *
 * ★ The bidi ranges are the ones that are not merely cosmetic. A right-to-left
 * override reverses everything rendered after it, and in a UI that is *already*
 * bilingual and already switching `dir` per locale, that is a genuinely
 * effective way to make a message read as something it is not — in the one
 * place a reader has no reason to be suspicious. The zero-width characters go
 * with them: they are how a filtered word is smuggled past a filter.
 *
 * A table of ranges rather than a regex literal, because a character class of
 * invisible characters is a line of source that nobody can review.
 */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number, string]> = [
  [0x00, 0x08, 'C0 controls before tab'],
  [0x0b, 0x0c, 'vertical tab, form feed'],
  [0x0e, 0x1f, 'C0 controls after carriage return'],
  [0x7f, 0x9f, 'DEL and the C1 controls'],
  [0x200b, 0x200f, 'zero-width space … RLM'],
  [0x202a, 0x202e, 'LRE … RLO — the bidi overrides'],
  [0x2066, 0x2069, 'the bidi isolates'],
  [0xfeff, 0xfeff, 'zero-width no-break space (BOM)'],
]

function isInvisible(code: number): boolean {
  return INVISIBLE_RANGES.some(([from, to]) => code >= from && code <= to)
}

/** Collapses runs of whitespace and drops everything in {@link INVISIBLE_RANGES}. */
export function normalizeChatBody(body: string): string {
  let visible = ''
  for (const char of body.replace(/\r\n?/g, '\n')) {
    if (!isInvisible(char.codePointAt(0) ?? 0)) visible += char
  }

  return visible
    .replace(/[ \t]{3,}/g, '  ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Masks blocked words, comparing on the *normalised* form so `f u c k` and
 * `sh1t` are caught, while replacing the original token so the rest of the
 * sentence survives intact.
 *
 * Token-by-token rather than substring-over-the-whole-string, which is what
 * keeps "Scunthorpe" out of the mask: a token matches only when the token
 * itself normalises to something blocked, not when it merely contains it.
 *
 * Surrounding punctuation is split off and put back, so `shit,` becomes `███,`
 * rather than swallowing the comma. Not cosmetic — a mask that eats the
 * sentence structure around it makes the rest of the message harder to read
 * than the word it removed.
 */
export function maskBlockedWords(body: string): string {
  const blocked = new Set(BLOCKED_SUBSTRINGS.map((word) => normalizeDisplayName(word)))
  const EDGES = /^([^\p{L}\p{N}]*)([\s\S]*?)([^\p{L}\p{N}]*)$/u

  return body
    .split(/(\s+)/)
    .map((token) => {
      if (token.trim().length === 0) return token

      const parts = EDGES.exec(token)
      const [, before = '', core = token, after = ''] = parts ?? []
      if (core.length === 0) return token

      const normalized = normalizeDisplayName(core)
      if (normalized.length === 0) return token

      return blocked.has(normalized) ? `${before}${MASK}${after}` : token
    })
    .join('')
}

/**
 * Normalise, mask, then check what is left.
 *
 * @throws {ValidationError} when the message is empty or over-length *after*
 * normalisation — a body of 500 zero-width characters is not a message, and a
 * client that sends one is not a client.
 */
export function prepareChatBody(body: string): string {
  const normalized = normalizeChatBody(body)

  if (normalized.length === 0) {
    throw new ValidationError('Message is empty', { body: ['errors.chatBodyEmpty'] })
  }
  if (normalized.length > CHAT_BODY_MAX) {
    throw new ValidationError(
      'Message is too long',
      { body: ['errors.chatBodyTooLong'] },
      { max: CHAT_BODY_MAX },
    )
  }

  return maskBlockedWords(normalized)
}

/**
 * Emote ids are opaque to the server: the catalog is a cosmetic concern (M7),
 * and hard-coding a list here would mean a store release needed a backend
 * deploy. What *is* enforced is the shape — a slug, so an emote id can never be
 * a URL, a path, or a sentence smuggled through the cheaper rate limit.
 */
const EMOTE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/

export function assertEmoteIdAllowed(emoteId: string): void {
  if (!EMOTE_ID_PATTERN.test(emoteId)) {
    throw new ValidationError('Unknown emote', { emoteId: ['errors.emoteInvalid'] })
  }
}
