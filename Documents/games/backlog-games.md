# Backlog Games — Assessments

> **Status:** Documented, not scheduled · **Companion:** [../08-roadmap.md](../08-roadmap.md) "Later"

Seven games worth adding after the v1 five. Each entry is an **effort assessment**, not a full
spec — enough to choose the next one, and enough that an idea has a parking place instead of
derailing the current milestone.

**Recommended order (cheapest-first, so momentum never stalls):**

```
Hokm → Checkers → Crazy Eights → Uno → Rummy → Durak → Backgammon
  S        S            S          M      M       M         M
```

| Effort | Meaning |
|---|---|
| **S** | A weekend. Reuses an existing engine core almost wholesale |
| **M** | 1–2 weeks. Needs one new mechanic module plus a renderer |

> **The G5 test:** Hokm should take one weekend. If it takes two weeks, the `GameEngine`
> abstraction failed — and the right response is to fix the abstraction before adding game #7,
> not to power through six more games on a bad foundation.

---

## 1. Hokm (حکم) — **S** — do this first

> 4 players (2 partnerships) · 20–35 min · Medium · **Reuses ~70% of Shelem**

Persian trick-taking game, and the natural companion to Shelem. Shares the partnership model, the
follow-suit legality check, and trick resolution — the three most expensive parts of Shelem.

### Rules sketch
- 52 cards, 13 to each of 4 players, partners opposite. No widow, no bidding.
- **Hakem (ruler) selection:** deal cards face-up around the table; the first player to receive an
  Ace becomes Hakem for the first hand.
- Hakem sees their first 5 cards and **names the trump suit** (hokm), then the rest is dealt.
- 13 tricks. Follow suit if able; highest trump wins, else highest card of the led suit.
- **First team to 7 tricks wins the hand.** Card points are irrelevant — this is the key
  difference from Shelem.
- Match scoring: first team to 7 hands. A hand won 7–0 while the opponents took zero tricks is a
  **kot** and counts double (variants: some count 13–0 as a double kot).
- Hakem's team keeps the Hakem role while they win hands; losing passes it on.

### Reuse
| Reused from Shelem | New |
|---|---|
| `shared/trick.ts` — follow-suit legality, trick resolution | Hakem selection (deal-until-ace) |
| Partnership model (`team = seat % 2`) | Trick-count-based hand scoring (**no card points at all**) |
| Seat ring UI, hand fan, trick area | Kot detection and double scoring |
| Bot's trick-play heuristics | **An explicit trump-naming phase** — see below |
| Projection shape (hands hidden, counts public) | — |

> ⚠️ **The one place Hokm and Shelem genuinely diverge: how trump is set.**
> In **Shelem**, trump is a side effect of the declarer's opening lead — there is no
> `TRUMP_SELECTION` phase and no `SELECT_TRUMP` move
> ([shelem.md](./shelem.md) §3). In **Hokm**, the Hakem sees 5 cards and **announces** trump
> before the rest is dealt, which *does* need a phase and a move.
>
> Build Hokm second and it's an addition. Build it first and you will likely give Shelem a
> trump-selection phase it should not have. Also note Hokm has **no card points** — only trick
> counts — so Shelem's two-component scoring is not reusable here at all.

### Effort notes
No bidding phase, no widow, no card points — Hokm is **simpler than Shelem**. The phase machine is
`HAKEM_SELECTION → TRUMP_SELECTION → TRICK_PLAY → HAND_SCORING → …`. Realistically a weekend, most
of it UI and translations.

> **Open question:** kot rules vary (7–0 vs 13–0, double vs triple). Expose as options, same
> approach as [shelem.md](./shelem.md) §0.

---

## 2. Checkers / Draughts — **S**

> 2 players · 10–25 min · Light · **Reuses the chess board layer**

### Rules sketch
- 8×8 board, 12 pieces each on dark squares. Diagonal forward moves.
- Captures by jumping; **multi-jumps chain** in a single turn.
- **Capture is mandatory** (international rules) — configurable, since American/English casual
  play often makes it optional.
- Reaching the far rank promotes to a **king**, which moves and captures backward too.
- Win by capturing all pieces or leaving the opponent with no legal move.

### Reuse
| Reused from Chess (M6) | New |
|---|---|
| 8×8 board renderer, coordinate system, drag/click input | Move generation (simple: diagonals + jump chains) |
| Server-authoritative clocks | Mandatory-capture legality |
| `dir="ltr"` board island | King promotion |
| Move history + review UI | Multi-jump as a **single move** with an intermediate-square path |
| Perfect-information projection (near-identity) | — |

### Effort notes
No suitable library is needed — checkers move generation is genuinely simple (~150 lines).
The one non-obvious part is representing a multi-jump: the move must be
`{ from, path: string[] }` so a chain of three jumps is one atomic, undoable move rather than
three, or the turn boundary breaks.

> **Open question:** international (mandatory capture, flying kings) vs English/American (optional
> capture, short kings)? Default assumption: **English rules with mandatory capture as an option**,
> since that's what most people learned.

---

## 3. Crazy Eights — **S** — builds the shedding base

> 2–6 players · 10–20 min · Light · **Pay once, unlock Uno and Durak**

Its real value is building `shared/shedding.ts`, the base module for the whole shedding-game
family. As a game it's also a great smoke test: rules simple enough that any bug in the shared
module is immediately obvious.

### Rules sketch
- 52 cards, 5–7 each, rest is the stock; top card starts the discard pile.
- Play a card matching the top card's **suit or rank**, or any **8** as a wild (declaring a suit).
- Can't play → draw from the stock (variants: draw one, or draw until playable).
- First to empty their hand wins. Scoring by remaining card values, or simple first-out.

### The shared module this creates
```ts
// domain/games/shared/shedding.ts
interface SheddingState {
  hands: Record<SeatId, Card[]>        // ★ server only
  stock: Card[]                        // ★ server only → stockCount
  discard: Card[]                      // top card public; full pile as a count
  direction: 1 | -1
  toAct: SeatId
  pendingDraw: number                  // stacked draw penalties (Uno's +2/+4)
  declaredSuit: Suit | null            // after a wild
}
legalSheddingPlays(hand, top, declaredSuit, rules): Card[]
applyShed(state, seat, card): SheddingState
advanceTurn(state, skip?, reverse?): SheddingState
reshuffleDiscardIntoStock(state, rng): SheddingState
```

Uno and Durak both build on this. Two projection traps live here and get solved once:
**`stock` must project as `stockCount`**, and **the discard pile below the top card must project
as a count** (its contents are memorizable at a real table, but sending the array leaks the
reshuffle order).

---

## 4. Uno — **M** — most-requested casual game

> 2–8 players · 15–30 min · Light–Medium · Custom deck + action-card resolution

### Rules sketch
- 108-card custom deck: 4 colors × (0, 1–9 ×2, Skip ×2, Reverse ×2, Draw Two ×2) + 4 Wild + 4 Wild Draw Four.
- 7 cards each. Match the top card by **color, number, or symbol**; wilds are always playable.
- Action cards: Skip (next player loses a turn), Reverse (direction flips; **acts as Skip in
  2-player**), Draw Two, Wild (choose color), Wild Draw Four (choose color + next draws 4).
- **"Uno!" call:** a player at one card must declare; failing to before the next play draws a
  penalty. Only meaningful with a challenge mechanic.
- First to shed all cards wins the round; scoring by opponents' remaining card values, first to
  500 points.

### New work
| Item | Notes |
|---|---|
| **Custom deck** | The first non-standard deck in the project. `Card` becomes a union: `StandardCard \| UnoCard`, so `buildDeck` needs a per-game variant |
| Action resolution | Skip/Reverse/Draw stacking rules — the main rules complexity |
| Stacking house rules | Can a +2 be stacked on a +2? Very contentious. **Must be an option** |
| Wild Draw Four legality | Official rules forbid playing it when you hold a matching color, with a challenge mechanic. Most people ignore this. Option, default **off** |
| "Uno!" call | Needs a UI button and a timing window; without a challenge mechanic it's decorative |
| Art assets | 108 distinct card faces — the largest asset job in the backlog |

> **The card-type generalization is the real cost here.** `type Card = \`${Rank}${Suit}\`` from
> [../05-game-engine-spec.md](../05-game-engine-spec.md) §4.1 assumes a standard deck. Uno forces
> that to become a discriminated union, which touches the shared deck utilities and the leak-test
> helper. Worth doing deliberately rather than by accident — and worth doing **after** Crazy
> Eights has proven the shedding base with a standard deck.

> **Open questions:** stacking (+2 on +2)? Draw-until-playable or draw-one? Must you play a
> drawn card if legal? All three are contentious house rules → all three become options.

---

## 5. Rummy / Gin Rummy — **M** — unlocks a mechanic family

> 2–4 players · 20–40 min · Medium · Melding + discard pile

### Rules sketch (Gin Rummy, 2 players — the cleaner variant to build first)
- 52 cards, 10 each. Stock + discard pile.
- Turn: draw (stock or discard top), then discard one.
- **Melds:** sets (3–4 same rank) and runs (3+ consecutive, same suit).
- **Deadwood** = unmelded card values (A=1, face=10).
- **Knock** at ≤ 10 deadwood; opponent lays off deadwood onto your melds; the difference scores.
- **Gin** (0 deadwood) = 25-point bonus. Undercut = 25-point bonus to the opponent.
- First to 100 points wins.

### New work
| Item | Notes |
|---|---|
| **Meld detection** | The interesting algorithm: find the optimal partition of a hand into melds minimizing deadwood. Small enough for exhaustive/DP search over 10–11 cards |
| Lay-off resolution | After a knock, the opponent may extend your melds — needs correct interaction with the optimal partition |
| Draw-from-discard | The discard pile top is public, so drawing it **reveals information** — the projection must show what was drawn from the discard, but not from the stock |
| Deadwood scoring | Straightforward once melds are right |

> **The projection subtlety worth flagging early:** in Rummy, *where* a card was drawn from is
> strategic public information. `PLAYER_DREW_FROM_DISCARD` must be a public event including the
> card; `PLAYER_DREW_FROM_STOCK` must be public **without** the card. Two events, not one with a
> conditional field — a conditional field is exactly the kind of thing that leaks when someone
> later refactors it.

Once melding exists, Rummy 500, Canasta, and Kalooki all become S-effort variants.

---

## 6. Durak (Дурак) — **M**

> 2–5 players · 20–40 min · Medium · Attack/defend on the shedding base

Genuinely different structure from everything else in the catalog, which is the argument for it.

### Rules sketch
- 36-card deck (6 through Ace). 6 cards each; the bottom card is turned up to set trump and stays
  visible.
- One player **attacks**, the next **defends**. The attacker plays a card; the defender must beat
  it with a higher card of the same suit, or any trump (a trump can only be beaten by a higher
  trump).
- Other players may **join the attack** with cards matching any rank already on the table.
- Defender beats everything → the cards are discarded and the defender becomes the next attacker.
  Defender fails → they **pick up all the cards** on the table.
- Refill hands to 6 from the stock. When the stock is empty, play out.
- Last player holding cards is the **durak** (fool) — this is a **last-place** game, not a
  first-place one.

### New work
| Item | Notes |
|---|---|
| Attack/defend turn structure | Not a simple round-robin — the "turn" is a multi-card attack/defence exchange. The turn model in `shared/shedding.ts` needs to support this or Durak gets its own |
| Beat legality | Same-suit-higher, or trump-beats-non-trump, or higher-trump |
| Multi-attacker joining | Concurrent-ish input from several seats within one exchange — the only game here where more than one non-active seat can act |
| **Loser-determined result** | `GameResult.standings` handles this fine (last rank), but the UI must frame it as "avoid last" rather than "win" |
| 36-card stripped deck | `buildDeck({ strip: ['2','3','4','5'] })` — already supported |

> The multi-attacker mechanic is the one part that doesn't fit the existing "one seat acts at a
> time" model. Worth confirming the turn abstraction can express it *before* starting — this is
> the backlog game most likely to reveal a limitation in `GameEngine`.

---

## 7. Backgammon — **M**

> 2 players · 20–40 min · Medium · New board layer + **verifiable dice**

Its distinctive value: it would extend the seed-commitment fairness system from hidden cards to
**visible randomness**, where players actively suspect the dice.

### Rules sketch
- 24 points, 15 checkers each, opposing directions.
- Roll two dice; move checkers by each die's value. **Doubles play four times.**
- A point with 2+ opposing checkers is blocked. Landing on a single opposing checker (a **blot**)
  sends it to the **bar**; it must re-enter before any other move.
- **Bear off** all 15 checkers to win. Opponent with none off = **gammon** (double); opponent with
  checkers still on the bar or in your home board = **backgammon** (triple).
- **Doubling cube:** either player may double the stake before their roll; the opponent accepts or
  forfeits.

### New work
| Item | Notes |
|---|---|
| Board renderer | Points, checker stacks, bar, home boards. Unlike chess, **direction of travel matters** and mirroring is genuinely ambiguous under RTL — needs a decision |
| Move generation | The hard part: enumerating all legal ways to play a roll, including forced-move rules ("must use both dice if possible") |
| **Verifiable dice** | Per-roll seed commitment: `commit_n = sha256(seed_n + gameId + rollNumber)` published before the roll, revealed after. Extends [../07-security-and-anticheat.md](../07-security-and-anticheat.md) §4 to per-move randomness |
| Doubling cube | State + accept/decline flow + stake multiplication |
| Bearing off | Special legality when all checkers are home |

> **The dice-commitment design deserves thought.** Cards are committed once per deal; dice need a
> commitment *per roll*, published before the player decides to double. A single game-level seed
> would let a player who knows the seed predict every future roll — so this needs a commitment
> chain, not one commitment. That's the interesting engineering in this game, and it's the reason
> Backgammon is last: it's the only backlog game that extends a *security* mechanism rather than a
> gameplay one.

---

## Summary

| Game | Players | Effort | Primary reuse | New mechanic it unlocks |
|---|---|---|---|---|
| **Hokm** | 4 | S | Shelem trick-taking (~70%) | An explicit trump-naming phase; trick-count-only scoring. The G5 validation test |
| **Checkers** | 2 | S | Chess board layer | Multi-jump atomic moves |
| **Crazy Eights** | 2–6 | S | Deck utilities | **Shedding base** → Uno, Durak |
| **Uno** | 2–8 | M | Shedding base | **Custom (non-standard) decks** |
| **Rummy / Gin** | 2–4 | M | Deck utilities | **Melding** → Canasta, Rummy 500 |
| **Durak** | 2–5 | M | Shedding base | **Attack/defend + multi-attacker turns** |
| **Backgammon** | 2 | M | Board layer, clocks | **Per-roll verifiable dice** |

Every one of these is a *plug-in* under [../05-game-engine-spec.md](../05-game-engine-spec.md) —
none should require modifying an existing game. Where an entry above notes a possible limitation
(Uno's card type, Durak's turn model), that is a flag to check the abstraction **before** starting,
not a reason to avoid the game.

---

**Related:** [../05-game-engine-spec.md](../05-game-engine-spec.md) · [shelem.md](./shelem.md) (Hokm's parent) · [chess.md](./chess.md) §12 (Checkers' parent) · [../08-roadmap.md](../08-roadmap.md)
