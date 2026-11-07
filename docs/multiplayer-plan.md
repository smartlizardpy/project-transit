# Multiplayer: co-op and racing

Friends play Project Transit together over the internet, peer to peer, with no server of ours.

## Modes

1. **Co-op (built).** Two to four people run one company in one game. Everyone sees the others' cursors on the map, and anyone can build, buy or change anything. Nothing is restricted: if a friend is "helping", they just move their mouse and do things.
2. **Race (next).** Same city, same seed, separate companies, one shared clock and a live scoreboard. Each player runs their own simulation, so this needs no lockstep.

Dropped: rival companies competing for the same passengers, and roles/permissions.

## How co-op works

**Lockstep, like OpenTTD.**
- Every computer runs the same simulation. Only player actions travel over the network.
- The host owns the clock. It applies each action at its current game second and stamps the action with that second.
- The host sends a *frame* about 15 times a second: "you may run up to second T; here are the actions".
- A guest never runs past T, so it always reaches an action's second before applying it, between the same two ticks as the host did.
- The host never runs more than about one real second ahead of the slowest guest. While it waits, the HUD says "waiting for Sam".

**Joining.**
- The host sends its save plus the built map data (the region's road graph, demand grid and so on), packed and gzipped.
- The guest does not rebuild the map from tiles. OpenFreeMap quietly serves the newest tiles when a pinned version is gone, so two builds could differ.
- Actions applied while the copy was on its way are replayed on top of it.

**Drift safety net.**
- Every ten game minutes each guest sends a checksum: the random-number state, money, all buses and passenger counts.
- If a checksum differs from the host's, the host sends that guest a fresh copy and the guest swaps it in. This takes about a second.
- OpenTTD disconnects instead. We can resync because reloading a save mid-game already continues identically (`src/game/test/determinism.ts`).

**Map growth.** When a licence grows the map, the host builds the bigger map and sends it to everyone as a fresh copy. Guests never grow the map themselves.

**Cross-platform math.**
- Mac (JavaScriptCore) and Windows (V8) differ in the last bit of `Math.sin/exp/pow/hypot`. Out of 2000 inputs, native `exp` differs on 190 and `atan2` on about 355.
- `src/game/dmath.ts` replaces them in the simulation with fdlibm-style versions built from `+ − × ÷ √` and literal constants, which IEEE 754 makes identical everywhere. Error is under 5e-15.
- `localeCompare` became `cmp`, a code-unit order, because collation depends on the system locale.
- `node scripts/check-dmath.mjs` compares bit patterns in Node, Chromium and WebKit: 0 differences.
- A guard test in `src/game/test/dmath.test.ts` keeps `Math.*` transcendentals, `**` and `localeCompare` out of `src/game`.
- Cost: the hourly passenger choice is about 2.5 ms (about 9%) slower. The per-tick simulation is not measurably slower.

## Code map

| File | What |
|---|---|
| `src/game/actions.ts` | Every player change as a JSON action: the game methods, plus Improve service plans, route-check fixes, templates, and undo/redo of those by key |
| `src/app/act.ts` | `act('buyVehicle', …)` and `setSpeed()`: the only way the UI changes the game. Single-player applies at once; co-op routes through the session |
| `src/net/lockstep.ts` | `HostSim` / `GuestSim`: the clock, frames, stamping, catch-up, checksums and resync. No React; tested with an in-memory transport |
| `src/net/protocol.ts` | Message types (`PROTO` version) |
| `src/net/codec.ts` | JSON + typed-array packing with gzip, for snapshots |
| `src/net/checksum.ts` | The ten-minute fingerprint |
| `src/net/rtc.ts` | WebRTC transport (Trystero): public Nostr relays only introduce the peers, with the offer encrypted by the room code. Loaded lazily |
| `src/net/coop.ts` | Host/join/leave, wiring to the session and action router, the feed, cursors and pings |
| `src/ui/Coop.tsx`, `src/map/coopLayer.ts`, `src/styles/coop.css` | Invite and join dialogs, the strip under the clock, cursors and pings on the map |
| `scripts/coop.mjs` | Two real browsers over real WebRTC: found, invite, join, both act, force a drift, compare |

## Rules for new code

- **The UI never calls a mutating `Game` method directly.** Use `act()` / `send()`. A new mutating method goes in `GAME_METHODS`.
- Action arguments must survive `JSON.stringify` (no Maps, closures or class instances). The host applies the round-tripped copy, so differences show up there too.
- Rendering must never write to `game.state`. The onboarding guide used to do this.
- Simulation code must not use `Math.sin` and friends, the `**` operator, `localeCompare` for ordering, wall-clock time or `Math.random`. Use `dmath.ts`, `hash.ts` and `game.random()`.
- Anything that changes the game must be saved in the state. Unsaved state is OpenTTD's most common desync cause, and the reload-continuity tests catch it.
- A cache built at the minute tick (such as `game.demand`) can be stale or empty between minutes, and a guest's copy starts with it empty. Code that can run between minutes (actions, and anything they trigger) must read it through `game.freshDemand()`. `src/game/test/act-on-copy.test.ts` applies actions to a game and to a mid-minute copy of it, and fails if they react differently.

## Limits and known gaps

- **The host is the session.** If the host quits, guests keep a paused copy they can save.
- **About 10–20% of home networks can't connect peer to peer without a TURN relay.** Trystero has no TURN by default; adding a free TURN service is a later option.
- **Linux:** WebKitGTK is often built without WebRTC, so the menu explains that co-op is unavailable there. macOS WKWebView was checked natively (data channels work). Windows WebView2 is Chromium.
- **AI agents** can read during co-op but cannot change workflows.
- **Undo of an Improve service or route-check change** only works for players who saw the original change. A guest who joined later gets resynced instead.

## Next

1. **Race mode.**
   - Host picks city, seed and goal (first to level 3, most riders by day 30…).
   - Each player plays their own game with the host's clock and speed.
   - Stats are exchanged each game hour for a scoreboard.
   - Optionally show the rival's lines faintly on your map (same city).
2. **TURN fallback** for networks where direct connections fail.
3. **Native check on Windows** (WebView2) with two real machines, Mac ↔ Windows, to confirm the math work in practice.
