Phase G (S28–S30) is built and green. Here's the state.

What shipped

S28 — GameInstance, seed commitment, GameEvent append
GameSessionService.createInstance draws a 256-bit seed through the Rng port, computes seedCommit = sha256(rngSeed + gameId), snapshots the seating, and broadcasts game:started before anything is dealt. The game id is now caller-chosen (NewGameInstance.id?) — the commitment includes it, so a create-then-update would leave a window where the committed value on disk was wrong. Rejected moves land as AUDIT events in the same ordered stream, with the clientMoveId in the payload rather than the unique column.

S29 — rebuildState, snapshots, resync
State is rebuilt from snapshot + events on every move. Snapshots every 25 events, at every phase boundary, always on FINISHED; pruneSnapshots keeps the two newest and touches zero events. game:requestSync gives delta inside a 50-event gap, full otherwise — and full for no lastSeq at all, which is the always-correct fallback.

S30 — the \_fixture engine and the move pipeline
The first real GameEngine: hidden per-seat secrets, a genuine advance(), a bot, a timeout default that passes rather than presses. applyMove runs 05 §6 exactly, and broadcastState caler. Generic tests/helpers/leak.ts and

The one decision worth your attention

Randomness is keyed by the log — gameRng(rngSeed, seq), a fresh generator per input event. A single Rng per game is correct only while every rebuild replays from event 0; a snapshot records the state but not the stream position, so rebuilding from seq 25 would deal different cards than the live game did — invisible until the first game long enough to snapshot. Keying by clientMoveId would have been easier and is a cheat: the client picks it, so a player could retry under new ids until the deck obliged. There's a test that deletes every snapshot, rebuilds the long way, and demands byte-identical state.

Also: the projection guard changed shape. It forbade game:state → spectatorRoom, but 04 §3.2 settles that the other way (a spectator projection is public by construction). The syntactic check narrowed to tableRoom; the semantic guarantee moved to the leak harness, which is stronger. The Phase F canary was replaced by ★ the only thing that projects state is GameSessionService.broadcastState — game state now has exactly one emitter.

Verification run

npm run typecheck && npm run lint && npm run format:check ✓
npm test 1427 passed (57 files), up from 1338
npm run contracts:sync && contracts:check ✓ 13 files, frontend typecheck green
newman postman/… 71 requests, 99 assertions, 0 failures

Phase G added no REST routes (a move is socket traffic), so the collection is unchanged — re-run only to prove nothing broke. The prisma:error Unique constraint failed on (gameId, seq) lines in the event-log output are the retry loop working.

Your gate

.claude/context/build/context.md has the full Phase G section; backend/requests/socket.md has the two-terminal walk with exact curls. The short version:

PORT=3999 npm run dev
npx tsx scripts/dev-socket.ts --url http://localhost:3999 --cookies /tmp/c.txt --join $TID --seat 0
npx tsx scripts/dev-socket.ts --url http://localhost:3999 --cookies /tmp/g.txt --join $TID --seat 1

Terminal 1: start, then compare the two game:state payloads side by side. view.secret is a different 7-digit number in each and neither contains the other's — one server state through projectState twice. Then kill the server mid-game, restart, sync 0 — the presses are still there.

Two things I want to flag:

- SEQ_RETRIES went 5 → 12 in the Prisma event repository. The worst case for N simultaneous appenders is N−1 retries, and N is bounded by seat count; a budget of 5 would only ever bite under exactly the load it exists for.
- The 100-append concurrency test runs ten waves of ten, not 100 at once. Prisma's SQLite datasource holds one connection, so 100 interactive transactions blow the 5 s acquisition timeout — the test would fail on pool starvation while saying nothing about ordering. The assertion is still [1..100] exactly.

Documents/PhasesDevelopResultReport/ has reports for Phases A–E but none for F. Say the word and I'll write Phase06 (F) and Phase07 (G) to match.

Commit message

feat(backend): Implement Phase G — Event log

S28 GameInstance + seed commitment + GameEvent append with seq
S29 Snapshot policy, rebuildState, delta/full resync
S30 The \_fixture engine + GameSessionService move pipeline

- Randomness keyed by the log (gameRng(rngSeed, seq)), never by clientMoveId
- GameInstance.id is caller-chosen: the commitment is sha256(seed + id)
- Rejected moves audit with the key in the payload, not the unique column
- projectState once per viewer; game state now has exactly one emitter
- Generic leak-test harness and replayFixture kit, for M1 to reuse
- SEQ_RETRIES 5 -> 12; six Phase G counters

1427 backend tests green (up from 1338). Postman: 71/99/0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
