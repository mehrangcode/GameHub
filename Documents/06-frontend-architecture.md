# Frontend Architecture

> **Status:** Draft · **Depends on:** [02-technical-prd.md](./02-technical-prd.md), [04-realtime-protocol.md](./04-realtime-protocol.md)

Vite + React 19 + TypeScript, Zustand for global state, Axios for REST, `socket.io-client` for
gameplay.

**The governing constraint:** the frontend contains **zero game rules**. It renders the projection
the server sent and the `legalMoves` the server computed. If you find yourself writing
`if (card.suit === trump)` in a component, the logic belongs on the server.

---

## 1. Project Setup

```bash
npm create vite@latest frontend -- --template react-ts
```

```ts
// vite.config.ts
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: 5173,
    proxy: {
      '/api':       { target: 'http://localhost:3000', changeOrigin: true },
      '/socket.io': { target: 'ws://localhost:3000', ws: true },   // ← ws:true is essential
    },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router'],
          socket: ['socket.io-client'],
          // game engines are NOT chunked here — each game's renderer is a lazy route
        },
      },
    },
  },
})
```

Proxying in dev means the app runs same-origin, so httpOnly cookies work locally exactly as they
do in production. No CORS special-casing, no "works in prod only" auth bugs.

---

## 2. Routes

```tsx
// src/routes/index.tsx — React Router 7 data router
const routes = [
  { path: '/',                element: <WelcomePage /> },              // preview cards
  { path: '/login',           element: <LoginPage /> },
  { path: '/register',        element: <RegisterPage /> },
  { path: '/t/:inviteCode',   element: <InviteLandingPage /> },        // ★ public, no auth
  { path: '/table/:tableId',  element: <TablePage />, loader: requireIdentity },
  { path: '/games/:slug',     element: <GameDetailPage /> },
  { path: '/play',            element: <QueuePage /> },                              // matchmaking
  { path: '/customize',       element: <CustomizePage />, loader: requireIdentity },
  { path: '/store',           element: <StorePage />, loader: requireIdentity },     // browse as guest
  { path: '/wallet',          element: <WalletPage />, loader: requireUser },
  { path: '/premium',         element: <PremiumPage /> },
  { path: '/profile',         element: <ProfilePage />, loader: requireUser },
  { path: '/matches/:id',     element: <MatchSummaryPage /> },
  { path: '*',                element: <NotFoundPage /> },
]
```

> `/store` uses `requireIdentity`, not `requireUser`: **guests may browse and see prices** — that's
> the whole point of showing them what their unvested coins could buy — but the purchase button
> becomes "Create an account to spend your 340 coins". `/wallet` (the full ledger statement) is
> user-only, since guests have no transaction history worth paginating.

| Guard | Allows | Used by |
|---|---|---|
| *(none)* | anyone | welcome, invite landing, game detail |
| `requireIdentity` | signed-in user **or** guest | table, customize |
| `requireUser` | signed-in user only | profile, stats |

`requireIdentity` — not `requireUser` — on `/table/:id` is the entire guest-play promise expressed
as a route guard. Getting this wrong reintroduces the signup wall.

### 2.1 Invite landing — the highest-stakes screen

`/t/:inviteCode` decides whether persona P2 plays or leaves.

```
┌──────────────────────────────────────────┐
│  [Shelem art]                            │
│  Ali invited you to play Shelem          │
│  3 of 4 seats open · 30–45 min           │
│                                          │
│  Your name  [ Sara            ]          │
│  ┌────────────────────────────────────┐  │
│  │       ▶  Play now                  │  │   ← primary, immediate
│  └────────────────────────────────────┘  │
│  Already have an account? Sign in        │   ← secondary text link
└──────────────────────────────────────────┘
```

Rules:
- Data comes from `GET /api/v1/invites/:code` — **unauthenticated**.
- One field, one button. **No email, no password, no checkbox.**
- Sign-in is a text link, never a competing button.
- Guest name persisted to `localStorage` so a refresh doesn't re-prompt.
- Failure states are specific and actionable: expired ("ask Ali for a new link"), table full
  ("join as spectator?"), game already started ("watch, or wait for the next hand").

---

## 3. State — Zustand Slices

One store per domain, created with `create()` + `immer` + `subscribeWithSelector`. No single
mega-store; no context providers wrapping the tree.

```
src/stores/
├── authStore.ts        identity, refresh coordination
├── socketStore.ts      connection lifecycle, seq tracking
├── tableStore.ts       lobby: members, seats, options, presence
├── gameStore.ts        ★ the server's projection, verbatim
├── matchmakingStore.ts ticket state, queue position, release payload
├── walletStore.ts      balances, vesting status, last reward
├── chatStore.ts        messages, unread count
├── themeStore.ts       locale, dir, theme, cosmetics
└── uiStore.ts          modals, toasts, dismissed nudges
```

### 3.1 `authStore`

```ts
interface AuthState {
  identity: Identity | null              // { kind:'user'|'guest', ... }
  status: 'unknown' | 'authenticated' | 'guest' | 'anonymous'
  bootstrap(): Promise<void>             // GET /auth/me on app start
  login(c: Credentials): Promise<void>
  registerAsGuest(inviteCode: string, name: string): Promise<void>
  claimGuestAccount(input: RegisterInput): Promise<{ redirectTo: string }>   // ★ journey J2
  logout(): Promise<void>
}
```

`claimGuestAccount` returns `redirectTo` **from the server**, so the post-signup destination
(the invited table) is decided by the same transaction that preserved the seat — not reconstructed
client-side where it could drift.

### 3.2 `gameStore` — the important one

```ts
interface GameState {
  gameId: string | null
  gameSlug: string | null
  seq: number                            // last applied
  phase: string | null
  /** ★ EXACTLY what the server sent. Never augmented, never derived. */
  view: unknown
  /** ★ Server-computed. The client NEVER computes this. */
  legalMoves: unknown[] | null
  toAct: SeatId | null
  timers: { seat: SeatId; endsAt: number } | null
  pendingMoveId: string | null           // in flight → disable input
  syncing: boolean
  seedCommit: string | null

  applyServerState(p: GameStatePayload): void   // drops stale seq, flags gaps
  submitMove(move: unknown): Promise<void>
  reset(): void
}
```

**Forbidden in this store** (each of these is a P1 violation, and reviewable as such):

```ts
// ❌ computing legality
const canPlay = (c: Card) => c.suit === view.trump || !hasSuit(view.hand, view.leadSuit)
// ❌ inferring hidden information
const remaining = 52 - playedCards.length - myHand.length
// ❌ scoring
const points = tricks.reduce((s, t) => s + cardPoints(t), 0)
// ❌ deciding turn order
const next = (view.toAct + 1) % 4
```

Every one of these is server-supplied instead: `legalMoves`, `view.deckCount`, `view.scores`,
`view.toAct`. The `view` type per game is imported from `contracts/`, so the shape is checked at
compile time.

### 3.3 `matchmakingStore` and the turn timer

```ts
interface MatchmakingState {
  ticketId: string | null
  presetId: string | null
  status: 'idle' | 'queued' | 'matched' | 'released'
  position: number | null
  humansWaiting: number
  /** Absolute server timestamp. NEVER a local countdown seeded once. */
  timeoutAt: number | null
  allowBotFill: boolean
  release: ReleasePayload | null       // reason + suggestions, drives the release screen
  cooldownEndsAt: number | null

  join(presetId: string, allowBotFill: boolean): Promise<void>
  leave(): Promise<void>
  /** Rehydrate from GET /matchmaking/status — a ticket is server state, not client state. */
  hydrate(): Promise<void>
}
```

Two rules the UI must not break:

1. **A ticket lives on the server.** On mount, `hydrate()` from `GET /matchmaking/status`. A queue
   that exists only in the browser looks alive after a refresh and isn't.
2. **Countdowns render from `timeoutAt` minus the handshake clock offset**, never from a local
   `setInterval` started at join. Same rule as the turn timer below, and for the same reason.

```ts
// gameStore, turn-timer slice
interface TurnTimerSlice {
  turnEndsAt: number | null        // absolute, server-supplied
  turnSeat: SeatId | null
  strikes: number
  /** Set by game:ejectionWarning. Drives the "you're about to be removed" banner. */
  ejectionWarning: { secondsRemaining: number; consequence: string } | null
  ejected: { reason: string; reclaimableUntil: number | null } | null
}
```

> **The turn countdown is the highest-stakes number in the UI.** A client whose system clock is
> skewed, or that drifts because it counted locally, will show a player more time than they have —
> and that deadline now costs them the match *and* their coins. Always
> `turnEndsAt - (Date.now() + clockOffset)`, recomputed on every tick from the server value.

### 3.4 `walletStore`

```ts
interface WalletState {
  balances: Record<AssetCode, { vested: number; provisional: number }>
  /** True for guests: the balance exists but cannot be spent until signup. */
  isProvisional: boolean
  lastReward: { coins: number; forfeited: boolean; reason?: string } | null

  hydrate(): Promise<void>              // GET /wallet
  applyUpdate(p: WalletUpdatedPayload): void   // wallet:updated socket event
}
```

**Display only.** The balance here is never the basis for a purchase decision — `POST
/store/purchase` re-reads and row-locks server-side ([07](./07-security-and-anticheat.md) §11.3).
The client shows a "not enough coins" state as a *courtesy*, exactly as it greys out an illegal
card: helpful, never authoritative.

### 3.5 `themeStore` — drives cosmetics and RTL

```ts
interface ThemeState {
  theme: 'light' | 'dark' | 'system'
  locale: 'en' | 'fa'
  dir: 'ltr' | 'rtl'                     // derived from locale
  numeralSystem: 'auto' | 'latin' | 'persian'
  cosmetics: { cardBackId, cardFaceId, feltId, avatarRef }
  animationSpeed: 'off' | 'fast' | 'normal'
  sound: { enabled: boolean; volume: number }

  setLocale(l: Locale): void             // sets <html lang> + <html dir>, loads namespace
  setCosmetic(cat: CosmeticCategory, id: string): void
  persist(): Promise<void>               // PUT /me/preferences (user) or localStorage (guest)
}
```

A single `subscribeWithSelector` subscription writes `document.documentElement`'s
`lang`, `dir`, `data-theme`, and the cosmetic CSS custom properties. Components never touch the
DOM root themselves.

---

## 4. Networking

### 4.1 Axios

```ts
// src/api/client.ts
export const api = axios.create({
  baseURL: '/api/v1',
  withCredentials: true,                 // ← httpOnly cookies
  timeout: 15_000,
  headers: { 'X-Request-Id': () => crypto.randomUUID() },
})

// Single-flight refresh: N concurrent 401s trigger ONE refresh call.
let refreshing: Promise<void> | null = null

api.interceptors.response.use(undefined, async (error: AxiosError) => {
  const cfg = error.config as RetriableConfig | undefined
  const status = error.response?.status

  if (status === 401 && cfg && !cfg._retried && !cfg.url?.includes('/auth/refresh')) {
    cfg._retried = true
    refreshing ??= api.post('/auth/refresh')
      .then(() => { refreshing = null })
      .catch((e) => { refreshing = null; useAuthStore.getState().onSessionLost(); throw e })
    await refreshing
    return api(cfg)
  }
  throw toAppError(error)                // → { code, i18nKey, fieldErrors? }
})
```

Three details that matter:
- **Single-flight**: without it, a page that fires five requests on mount triggers five parallel
  refreshes, and refresh-token *rotation* then invalidates the family — logging the user out for
  loading a page. This is a real and confusing bug class; the `refreshing` promise prevents it.
- **`_retried` guard**: prevents an infinite refresh loop.
- **`toAppError`**: every rejection becomes `{ code, i18nKey }`, so UI renders localized errors
  from the server's key rather than an English string.

One module per resource (`api/auth.ts`, `api/tables.ts`, …), each returning `contracts/`-typed
DTOs. Components never call `api` directly.

### 4.2 Socket manager

```ts
// src/socket/manager.ts
class SocketManager {
  private socket: TypedSocket | null = null

  connect() {
    if (this.socket?.connected) return
    this.socket = io({ withCredentials: true, transports: ['websocket', 'polling'],
                       reconnectionDelay: 500, reconnectionDelayMax: 5000 })
    this.socket.on('game:state',  (p) => useGameStore.getState().applyServerState(p))
    this.socket.on('game:event',  (p) => useGameStore.getState().appendNarration(p))
    this.socket.on('table:snapshot', (p) => useTableStore.getState().hydrate(p))
    this.socket.on('chat:message',(p) => useChatStore.getState().append(p))
    this.socket.on('connect_error', this.onConnectError)
    // ...
  }

  /** Retained until acked → a reconnect retry is idempotent. */
  async move(gameId: string, move: unknown) {
    const clientMoveId = crypto.randomUUID()
    useGameStore.getState().markPending(clientMoveId)
    const ack = await this.emitWithAck('game:move', { gameId, move, clientMoveId })
    if (!ack.ok) useGameStore.getState().onMoveRejected(clientMoveId, ack)
  }

  private onConnectError = async (e: Error & { data?: { code?: string } }) => {
    if (e.data?.code === 'UNAUTHORIZED' && !this.refreshTried) {
      this.refreshTried = true
      try { await api.post('/auth/refresh'); this.socket?.connect() }
      catch { useAuthStore.getState().onSessionLost() }
    }
  }
}
export const socketManager = new SocketManager()
```

**One socket per tab**, owned by this module — never created inside a component. A `useEffect`
that opens a socket will open several under React's StrictMode double-invoke and fast refresh.

### 4.3 No optimistic game updates

```ts
// ❌ this is a rules engine in the client
setHand(hand.filter(c => c !== card)); setTrick([...trick, card])

// ✅ show intent, wait for truth
markPending(clientMoveId)          // card lifts, input disables
await socketManager.move(gameId, { type: 'PLAY_CARD', card })
// gameStore updates when `game:state` arrives
```

The pending affordance (card raised, subtle spinner, controls disabled) makes the ~100 ms
round-trip feel responsive without the client ever predicting a rule. Chat *is* optimistic — it
isn't game state.

---

## 5. Component Structure

### 5.1 Shared table shell — built once, reused by every game

```
features/table/
├── TablePage.tsx              orchestrates: connect, join, route to renderer
├── TableShell.tsx             layout frame: seats around a game area
├── SeatRing.tsx               seat positions per player count; MIRRORS under RTL
├── Seat.tsx                   avatar, name, team, presence badge, turn indicator, timer
├── GameArea.tsx               slot filled by the per-game renderer
├── TableChat.tsx              chat + emote bar
├── TableToolbar.tsx           host controls: start, bots, options, invite
├── InvitePanel.tsx            link, copy, QR, revoke
├── PresenceBadge.tsx          "reconnecting… 0:58"
├── TurnTimerRing.tsx          countdown from server endsAt; reddens under 10 s
├── EjectionWarning.tsx        "Play within 10s or you'll be removed and earn no coins"
├── EjectionNotice.tsx         post-ejection state + [Reclaim my seat] while in window
├── RewardSummary.tsx          post-match breakdown, incl. the forfeiture message
└── SyncOverlay.tsx            shown while gameStore.syncing
```

### 5.3 Matchmaking, wallet & store

```
features/matchmaking/
├── QueuePicker.tsx        preset list with live "N waiting"; Quick play vs Create table
├── QueuePill.tsx          dismissible corner pill — queueing never blocks the UI
├── QueueOverlay.tsx       elapsed, humans waiting, timeout countdown, bot-fill toggle
├── MatchFound.tsx         full-screen countdown, then auto-navigate
└── ReleaseScreen.tsx      ★ the most important screen in this folder (see below)

features/store/
├── StorePage.tsx          categories, featured rotation, affordability filter
├── StoreItemCard.tsx      price, owned/locked/premium states, buy → confirm
├── PurchaseDialog.tsx     price, resulting balance, irreversibility notice
└── CoinBalance.tsx        header chip; shows provisional vs vested for guests

features/wallet/
├── WalletPage.tsx         balances + statement
└── TransactionRow.tsx     kind, amount, reason — including CAP_REJECTED rows

features/premium/
├── PremiumPage.tsx        tier comparison; leads with earn rate and cosmetics
└── SubscriptionPanel.tsx  status, period end, cancel-at-period-end
```

> **`ReleaseScreen` deserves the same care as the invite landing page.** With a small player base
> the queue times out more often than it matches ([09](./09-matchmaking.md) §5), so this is a
> primary surface, not an error state. It leads with **Play with bots**, offers **Create a table
> and invite friends** second, and shows other presets with people waiting. A spinner that gives
> up is how you lose the solo player for good.

> **`TransactionRow` renders `CAP_REJECTED` rows too**, with their reason ("removed for
> inactivity", "daily cap reached"). A ledger that hides the zero-amount rows makes "why didn't I
> get coins?" unanswerable — which is exactly the support question the economy will generate most.

The per-game folder supplies **only** the renderer:

```
features/games/shelem/
├── ShelemRenderer.tsx         reads gameStore.view + legalMoves
├── ShelemBidPanel.tsx
├── ShelemTrick.tsx
├── ShelemScoreboard.tsx
└── locales/{en,fa}.json
```

```tsx
// features/games/registry.tsx — lazy, so a game's bundle loads only when played
export const gameRenderers: Record<string, LazyExoticComponent<FC>> = {
  sudoku:    lazy(() => import('./sudoku/SudokuRenderer')),
  blackjack: lazy(() => import('./blackjack/BlackjackRenderer')),
  shelem:    lazy(() => import('./shelem/ShelemRenderer')),
  poker:     lazy(() => import('./poker/PokerRenderer')),
  chess:     lazy(() => import('./chess/ChessRenderer')),
}
```

Adding a game touches: this map, a renderer folder, and two locale files. Nothing else in the
frontend — the P5 promise on the client side.

### 5.2 Card primitives

```
components/cards/
├── Card.tsx           face or back; cosmetic-aware; playable/disabled/pending states
├── CardBack.tsx       reads --card-back-image
├── Hand.tsx           fanned layout, overlap by count, RTL-aware fan direction
├── CardStack.tsx      deck/pile with a COUNT (never the actual cards)
└── TrickPile.tsx      cards played this trick, positioned by seat
```

`Card` takes `card?: Card` — **undefined means face-down**, and no face data is passed at all.
The component *cannot* render a card it wasn't given, which makes hand privacy a property of the
component API rather than of remembering to set a flag.

---

## 6. Theming & the Customization Page

### 6.1 Token architecture

Everything themeable is a CSS custom property. Cosmetics then become a *data* change.

```css
/* src/styles/tokens.css */
:root {
  /* palette */
  --color-bg: #f7f7f8;
  --color-surface: #ffffff;
  --color-text: #17171a;
  --color-text-muted: #6b6b74;
  --color-accent: #2f6f4f;
  --color-danger: #b3261e;

  /* table cosmetics — swapped at runtime by themeStore */
  --felt-color: #14663f;
  --felt-pattern: none;
  --card-back-image: url('/assets/backs/classic.svg');
  --card-face-set: 'classic';
  --card-radius: 8px;
  --card-aspect: 5 / 7;

  /* motion — 0s when animationSpeed = off */
  --anim-card-deal: 260ms;
  --anim-card-flip: 180ms;
  --anim-ease: cubic-bezier(0.2, 0.8, 0.2, 1);

  /* layout */
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --radius-md: 10px;
  --font-sans: system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-fa: 'Vazirmatn', var(--font-sans);
}

[data-theme='dark'] {
  --color-bg: #101013;
  --color-surface: #1a1a1f;
  --color-text: #f2f2f5;
  --color-text-muted: #9a9aa4;
  --felt-color: #0d4a2d;
}

:root[lang='fa'] { --font-sans: var(--font-fa); }

@media (prefers-reduced-motion: reduce) {
  :root { --anim-card-deal: 0ms; --anim-card-flip: 0ms; }
}
```

```ts
// applying a cosmetic is one line — no component re-render needed
document.documentElement.style.setProperty('--card-back-image', `url(${asset})`)
```

### 6.2 The customization page

`/customize` — available to **guests too** (persisted to `localStorage`, then carried into the
account on claim, which is a concrete reason to sign up).

```
┌─────────────────────────────────────────────────────────────┐
│  Customize                                                  │
│  ┌──────────────┬────────────────────────────────────────┐  │
│  │ Appearance   │   ┌─── LIVE PREVIEW ───────────────┐   │  │
│  │ • Theme      │   │  [felt background]              │   │  │
│  │ • Table felt │   │   ♠A ♥K ♦Q  ▓▓ ▓▓   (avatar)    │   │  │
│  │ • Card backs │   │   a real mini table              │   │  │
│  │ • Card faces │   └─────────────────────────────────┘   │  │
│  │ Profile      │                                          │  │
│  │ • Avatar     │   Card backs                             │  │
│  │ • Name       │   [✓classic][persian][minimal][🔒 gold]  │  │
│  │ Gameplay     │                       ↑ unlock: 10 wins  │  │
│  │ • Animations │                                          │  │
│  │ • Sound      │   Table felt                             │  │
│  │ Language     │   [●green][●blue][●burgundy][●charcoal]  │  │
│  └──────────────┴────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

| Group | Options |
|---|---|
| **Theme** | Light · Dark · System |
| **Table felt** | Green, Blue, Burgundy, Charcoal + optional subtle pattern |
| **Card backs** | Classic, Persian tile, Minimal, + unlockables (`PLAY_COUNT`/`WIN_COUNT`) |
| **Card faces** | Classic (French) · **Persian** (traditional styling, for Shelem/Hokm) · High-contrast (accessibility) |
| **Avatar** | Preset gallery · initials-with-color · upload (users only) |
| **Animations** | Off · Fast · Normal — also auto-forced off by `prefers-reduced-motion` |
| **Sound** | Toggle + volume; per-category (deal, play, win, chat) |
| **Language** | English · فارسی — includes the numeral-system toggle |

Implementation notes:
- **Live preview is a real `TableShell`** with `--*` variables scoped to the preview container, so
  what you see is literally the component you'll play on — not a mock that can drift.
- Selecting a cosmetic applies **instantly** (optimistic; this is UI, not game state), then
  debounce-persists at 800 ms via `PUT /me/preferences`.
- Items render in one of four states, and the distinction matters:
  | State | Rendering |
  |---|---|
  | **Owned** | Selectable, checkmark |
  | **Free unlock in progress** | Condition + progress ("7 / 10 wins"). Still free — `PLAY_COUNT` / `WIN_COUNT` / `ACHIEVEMENT` unlocks remain ([10](./10-economy-and-rewards.md) §4.1) |
  | **Purchasable** | Coin price, affordability state, one-tap buy → confirm |
  | **Premium-only** | Badge + a link to `/premium`, never a hard paywall on the page itself |
- **Guests see prices and a signup path**, not a purchase button: *"Create an account to spend your
  340 coins."* The customization page is therefore a second conversion surface after the in-table
  nudge.
- Avatar upload: client-side validated (≤ 2 MB, jpeg/png/webp), center-cropped square, resized to
  256 px, re-encoded to webp **before** upload; server re-encodes again (never trust the client
  with image bytes — see [07-security-and-anticheat.md](./07-security-and-anticheat.md) §6).
- Assets are preloaded on hover so switching feels instant.

---

## 7. i18n & RTL in the Client

```ts
// src/i18n/index.ts
i18n.use(LanguageDetector).use(HttpBackend).use(initReactI18next).init({
  fallbackLng: 'en',
  supportedLngs: ['en', 'fa'],
  ns: ['common', 'auth', 'table', 'errors'],       // game namespaces lazy-loaded
  defaultNS: 'common',
  interpolation: { escapeValue: false },
  detection: { order: ['querystring', 'localStorage', 'navigator'], caches: ['localStorage'] },
})

i18n.on('languageChanged', (lng) => {
  const dir = lng === 'fa' ? 'rtl' : 'ltr'
  document.documentElement.lang = lng
  document.documentElement.dir = dir
  useThemeStore.setState({ locale: lng as Locale, dir })
})
```

### 7.1 The rules, restated for components

| Rule | Detail |
|---|---|
| **Logical properties only** | `margin-inline-start`, `padding-inline`, `inset-inline-end`, `border-start-start-radius`. Enforced by `stylelint-plugin-logical-css`. There is no RTL stylesheet |
| **Mirror** | Seat ring order, hand fan direction, chat side, turn arrow, panel layout |
| **Do not mirror** | **Chess board** (a1 stays bottom-left), **Sudoku grid**, card faces/pips, clockwise trick direction. Wrapped in `<div dir="ltr">` islands so they ignore ambient direction |
| **Numerals** | `formatNumber()` helper respects `numeralSystem`; ids/codes always Latin |
| **Dates** | `Intl.DateTimeFormat(locale, { calendar: locale === 'fa' ? 'persian' : undefined })` |
| **Server errors** | Rendered from `i18nKey` + `details`. Never display a raw server string |
| **Fonts** | `Vazirmatn` subset for `fa`, `font-display: swap`, real fallback stack |

> The chess exception is worth stating loudly because it is counterintuitive: mirroring a chess
> board under RTL would break notation for anyone who reads it, which is every chess player. The
> UI *chrome* around the board mirrors; the board does not.

### 7.2 Accessibility

- Full keyboard play: arrow keys to traverse a hand, Enter to play, Esc to cancel. Chess and
  Sudoku are grid-navigable.
- `aria-live="polite"` region announcing game events from the same i18n keys the chat log uses —
  so a screen reader hears "Sara played the ace of spades".
- Cards carry `aria-label` from rank + suit words, not glyphs (`"ace of spades"`, not `"A♠"`).
- Suit color is never the only differentiator — the high-contrast card face set adds suit letters
  for color-blind players.
- Focus is visibly trapped in modals; the signup nudge is dismissible by Esc.
- Target: WCAG 2.1 AA contrast on all four felt colors in both themes (checked per milestone).

---

## 8. Performance

| Technique | Detail |
|---|---|
| Route splitting | Every route lazy; per-game renderers lazy |
| Selector subscriptions | `useGameStore(s => s.view.hand)` — never the whole store, or every card re-renders on any change |
| `subscribeWithSelector` | Theme/DOM side effects run outside React |
| Memoized cards | `Card` is `memo`'d on `(card, state, cosmeticIds)` |
| Asset strategy | Card faces as a single SVG sprite; backs and felts as individual small assets, preloaded on hover |
| Animation | Transforms/opacity only (never layout properties); Framer Motion `layoutId` for deal→hand continuity |
| Bundle budget | ≤ 200 KB gzip initial; each game renderer ≤ 80 KB gzip |
| Web fonts | Subset Vazirmatn to Persian + Latin ranges; `swap` |

---

## 9. Testing

| Level | Tool | Covers |
|---|---|---|
| Unit | Vitest | Store reducers — especially `applyServerState` seq handling (stale drop, gap detect) |
| Component | RTL | Card privacy (`Card` with no `card` prop renders a back and exposes no face data), seat ring layout, RTL mirroring snapshots |
| Integration | Vitest + mock socket | Move submit → pending → server state → settled; reject path; resync path; **turn countdown accuracy under a skewed system clock**; ticket rehydration after reload |
| **E2E** | Playwright | The five journeys, plus: two browser contexts at one table asserting **neither page's DOM or network log contains the other's cards**; queue → 2-min timeout → release → play with bots; idle → warned → ejected → reward summary shows zero; guest earns → signs up → balance vested |
| Visual | Playwright screenshots | Every game screen in `en`/LTR and `fa`/RTL, light and dark — a milestone exit gate |

> The two-context Playwright test is the client-side half of the anti-cheat guarantee: even a
> perfect server projection could be undone by a client that fetches something extra. Asserting on
> the *network log* as well as the DOM catches that.

---

## Related Documents

- [02-technical-prd.md](./02-technical-prd.md) — stack, contract sync, i18n strategy
- [04-realtime-protocol.md](./04-realtime-protocol.md) — event catalog, client socket discipline, §6 turn enforcement
- [03-data-model.md](./03-data-model.md) — `UserPreferences`, `CosmeticItem`, `StoreItem`
- [01-business-prd.md](./01-business-prd.md) — journeys J1–J5, welcome page spec
- [09-matchmaking.md](./09-matchmaking.md) §10 — queue, release, and match-found UI
- [10-economy-and-rewards.md](./10-economy-and-rewards.md) §4, §11 — store catalog and reward transparency
