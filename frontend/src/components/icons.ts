/**
 * The icon vocabulary, separate from the component that renders it.
 *
 * Split out so `Icon.tsx` exports components only — which is what keeps React
 * fast refresh working on it during development.
 */
export type IconName =
  | 'spade'
  | 'grid'
  | 'cards'
  | 'crown'
  | 'chip'
  | 'knight'
  | 'coin'
  | 'gem'
  | 'ticket'
  | 'hint'
  | 'moon'
  | 'sun'
  | 'plus'
  | 'play'
  | 'users'
  | 'clock'
  | 'copy'
  | 'check'
  | 'info'
  | 'alert'
  | 'close'
  | 'chat'
  | 'send'
  | 'bot'
  | 'refresh'
  | 'logout'
  | 'eye'
  | 'lock'
  | 'link'

const GAME_ICONS: Record<string, IconName> = {
  shelem: 'crown',
  poker: 'chip',
  blackjack: 'cards',
  chess: 'knight',
  sudoku: 'grid',
  fixture: 'spade',
}

/**
 * Slug → icon, with a generic fallback.
 *
 * ★ The fallback is the P5 case and not a defensive nicety: `GET /games` can
 * name a sixth game tomorrow, and its card has to render today's build without
 * a deploy. An icon is the one thing about a game this client legitimately
 * knows locally, so it is the one thing that needs a default.
 */
export function gameIcon(slug: string): IconName {
  return GAME_ICONS[slug] ?? 'spade'
}
