/**
 * One inline SVG sprite, `<use>`-referenced — no icon font, and **no emoji as
 * icons**: an emoji renders differently on every platform, cannot inherit
 * `currentColor`, and is read aloud by a screen reader as its Unicode name.
 *
 * Decorative icons are `aria-hidden`. An icon that is the *only* content of a
 * control takes a `title`, which becomes its accessible name — a bare icon
 * button with neither is unusable without sight, so the prop is not optional in
 * practice.
 */

import type { IconName } from './icons'

export type { IconName }

interface IconProps {
  name: IconName
  /** Accessible name. Omit only when an adjacent text label already names it. */
  title?: string
  size?: 'sm' | 'md'
  className?: string
}

export function Icon({ name, title, size = 'md', className }: IconProps) {
  const dimension = size === 'sm' ? '1em' : '1.25em'

  return (
    <svg
      className={className}
      width={dimension}
      height={dimension}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title === undefined ? 'presentation' : 'img'}
      aria-hidden={title === undefined}
      focusable="false"
      style={{ flex: 'none' }}
    >
      {title !== undefined && <title>{title}</title>}
      <use href={`#i-${name}`} />
    </svg>
  )
}

/**
 * Rendered once, at the top of the app. Kept out of `index.html` so the symbol
 * set travels with the code that names it — a sprite in the shell and an
 * `IconName` union in TypeScript drift apart the first time someone removes an
 * icon.
 */
export function IconSprite() {
  return (
    <svg style={{ display: 'none' }} aria-hidden="true">
      <defs>
        <symbol id="i-spade" viewBox="0 0 24 24">
          <path d="M12 3c-3 3.5-7 6-7 9.5A4.5 4.5 0 0 0 12 16a4.5 4.5 0 0 0 7-3.5C19 9 15 6.5 12 3Z" />
          <path d="M12 16v5m-2.5 0h5" />
        </symbol>
        <symbol id="i-grid" viewBox="0 0 24 24">
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </symbol>
        <symbol id="i-cards" viewBox="0 0 24 24">
          <rect x="3" y="5" width="11" height="15" rx="2" />
          <path d="M9 3h8a2 2 0 0 1 2 2v12" />
        </symbol>
        <symbol id="i-crown" viewBox="0 0 24 24">
          <path d="M3 7l4 4 5-7 5 7 4-4-2 12H5L3 7Z" />
        </symbol>
        <symbol id="i-chip" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="3.5" />
          <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
        </symbol>
        <symbol id="i-knight" viewBox="0 0 24 24">
          <path d="M8 20h9M9 20c0-4 1-6 4-8 1.5-1 2-2.5 1.5-4L13 5l-2 2-3 1c-1.5.5-2 2-1 3l2-1 1 2-2 3" />
        </symbol>
        <symbol id="i-coin" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5v9M14.5 9.5c0-1-1-1.5-2.5-1.5s-2.5.6-2.5 1.6 1 1.4 2.5 1.6 2.5.7 2.5 1.7-1 1.6-2.5 1.6-2.5-.6-2.5-1.6" />
        </symbol>
        <symbol id="i-gem" viewBox="0 0 24 24">
          <path d="M6 4h12l3 5-9 11L3 9l3-5Z" />
          <path d="M3 9h18M9 4l-2 5 5 11 5-11-2-5" />
        </symbol>
        <symbol id="i-ticket" viewBox="0 0 24 24">
          <path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V8Z" />
          <path d="M13 6v12" />
        </symbol>
        <symbol id="i-moon" viewBox="0 0 24 24">
          <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z" />
        </symbol>
        <symbol id="i-sun" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="4.5" />
          <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
        </symbol>
        <symbol id="i-plus" viewBox="0 0 24 24">
          <path d="M12 5v14M5 12h14" />
        </symbol>
        <symbol id="i-play" viewBox="0 0 24 24">
          <path d="M7 4.5v15l12-7.5-12-7.5Z" />
        </symbol>
        <symbol id="i-users" viewBox="0 0 24 24">
          <path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20" />
          <circle cx="9" cy="7" r="3.5" />
          <path d="M22 20v-1.5a4 4 0 0 0-3-3.87" />
          <path d="M16 3.6a4 4 0 0 1 0 6.8" />
        </symbol>
        <symbol id="i-clock" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </symbol>
        <symbol id="i-copy" viewBox="0 0 24 24">
          <rect x="9" y="9" width="12" height="12" rx="2" />
          <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
        </symbol>
        <symbol id="i-check" viewBox="0 0 24 24">
          <path d="M4 12.5l5 5L20 6.5" />
        </symbol>
        <symbol id="i-info" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 8h.01" />
        </symbol>
        <symbol id="i-alert" viewBox="0 0 24 24">
          <path d="M10.3 3.9 2.4 17.1A2 2 0 0 0 4.1 20h15.8a2 2 0 0 0 1.7-2.9L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          <path d="M12 9v4M12 17h.01" />
        </symbol>
        <symbol id="i-close" viewBox="0 0 24 24">
          <path d="M6 6l12 12M18 6L6 18" />
        </symbol>
        <symbol id="i-chat" viewBox="0 0 24 24">
          <path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-4.5A8 8 0 0 1 11 4h2a8 8 0 0 1 8 8Z" />
        </symbol>
        <symbol id="i-send" viewBox="0 0 24 24">
          <path d="M4 12 20 4l-4 16-4-6-8-2Z" />
        </symbol>
        <symbol id="i-bot" viewBox="0 0 24 24">
          <rect x="4" y="8" width="16" height="12" rx="3" />
          <path d="M12 4v4M9 14h.01M15 14h.01" />
        </symbol>
        <symbol id="i-refresh" viewBox="0 0 24 24">
          <path d="M20 11a8 8 0 1 0-.6 4" />
          <path d="M20 4v7h-7" />
        </symbol>
        <symbol id="i-logout" viewBox="0 0 24 24">
          <path d="M9 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3" />
          <path d="M16 16l4-4-4-4M20 12H9" />
        </symbol>
        <symbol id="i-eye" viewBox="0 0 24 24">
          <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </symbol>
        <symbol id="i-lock" viewBox="0 0 24 24">
          <rect x="4" y="10" width="16" height="11" rx="2" />
          <path d="M8 10V7a4 4 0 1 1 8 0v3" />
        </symbol>
        <symbol id="i-link" viewBox="0 0 24 24">
          <path d="M10 13a4.5 4.5 0 0 0 6.5.4l2.5-2.5a4.5 4.5 0 0 0-6.4-6.4l-1.4 1.4" />
          <path d="M14 11a4.5 4.5 0 0 0-6.5-.4L5 13.1a4.5 4.5 0 0 0 6.4 6.4l1.4-1.4" />
        </symbol>
      </defs>
    </svg>
  )
}
