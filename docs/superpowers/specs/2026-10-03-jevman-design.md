# jevman — Pac-Man driven by the jev decision model

Date: 2026-10-03

## Goal

A local browser Pac-Man game whose characters are driven by the Opper-hosted
decision model `typesafe/jev-1.13.0`. The primary purpose is to **showcase jev's
decisions**: every junction turn a jev-controlled character makes is jev's
choice, and the UI shows the probabilities, confidence, latency and cost behind
each one.

### Requirements (from the user)

- Ghosts are always driven by jev.
- Pac-Man can be toggled at runtime between keyboard control and jev control.
- Showcase-first: live visualisation of decisions is a core feature, not a debug extra.
- Runs locally only (`npm run dev`, open localhost). No deployment.

### Non-goals

- Hosting, multi-user access, rate limiting or key protection beyond keeping
  the key server-side.
- Sound, intermission cut-scenes, fruit bonuses, high-score persistence.
- Pixel-perfect arcade fidelity (ghost speed tables, cornering rules, etc.).

## The jev model

jev is an *evaluation* model, not a chat model. It is only reachable through
Opper's System One endpoint:

```
POST {OPPER_BASE_URL}/v3/compat/v1/systemone
Authorization: Bearer <project-scoped Opper API key>
X-Opper-Name: jevman-decide
```

Request: `{ model, state, questions }` where `state` is any JSON value and
`questions` is a map of named typed questions. We use only `choice` questions:

```json
{ "type": "choice", "instructions": "...", "criteria": { "left": "...", "up": "..." } }
```

Response: `{ model, answers: { <name>: { type: "choice", choice, confidence,
probabilities: { <option>: p } } }, usage: { input_tokens, output_tokens } }`.
Cost is returned in the `X-Opper-Cost` response header.

Measured on 2026-10-03: ~340 ms round-trip for a small state with one question;
correct choice with confidence 0.99. Org-level personal keys are rejected
("System One requires a project-scoped Opper API key"); the key from the
`chadda` CLI slot works. The `gw` slot key is currently invalid and should
replace `chadda` once re-issued.

## Architecture

Vite + TypeScript, HTML canvas rendering, no game framework. One command:
`npm run dev`.

### Server: `/api/decide`

A Vite dev-server middleware (plugin `configureServer`) exposes
`POST /api/decide`. It:

1. Reads `OPPER_API_KEY` and `OPPER_BASE_URL` (default `https://api.opper.ai`)
   from `.env` (gitignored, mode 0600). `.env.example` documents the variables.
2. Accepts `{ state, questions }` from the browser, adds
   `model: "typesafe/jev-1.13.0"`, forwards to System One with a 2 s timeout.
3. Returns `{ answers, usage, latencyMs, costUsd, traceId }`, where latency is
   measured server-side and cost/trace come from the `X-Opper-Cost` /
   `X-Opper-Trace-Id` headers.
4. On upstream error, timeout or missing key returns a JSON error
   `{ error, status }` with a non-200 status, and logs one line to the server
   console. The handler is a plain function `handleDecide(req, deps)` with an
   injectable `fetch`, so it is unit-testable outside Vite.

The key never reaches the browser.

### Client units

Each unit is a focused module with a small interface and no hidden coupling.

| Module | Responsibility | Depends on |
|---|---|---|
| `maze.ts` | Parse the classic 28×31 layout; walls, pellets, power pellets, ghost house, tunnel wrap; `openDirs(tile)`, `isJunction(tile, heading)`, BFS distances. | — |
| `sim.ts` | Pure game simulation stepped by `step(state, dtMs, intents)`: movement on the grid, pellet/power-pellet eating, frightened timer, scatter/chase mode timer, collisions, lives, score, level clear/reset. Never awaits the network. | `maze` |
| `features.ts` | For a character at its upcoming junction, compute per-option facts: BFS distance to Pac-Man (or to the ghost's personality target), nearest pellet distance, pellets along the next corridor, nearest ghost distance / whether the corridor passes a ghost, distance to the nearest frightened ghost. | `maze`, `sim` types |
| `brain.ts` | Build one System One request for a batch of pending decisions (one `choice` question per character), and parse the response back into `Decision { actor, choice, probabilities, confidence, source: "jev" }`. Rejects choices that are not one of the offered options. | `features` |
| `scheduler.ts` | Decide *when* to ask. When a character commits to a corridor, its next junction is known; a decision for it is requested immediately. Decisions requested in the same frame are batched (≤3 batches in flight). If the character reaches the junction before the answer, it waits there (“thinking”). After 2 s, or on error/invalid answer, it falls back to a greedy rule and the decision is tagged `source: "fallback"`. | `brain`, injectable clock + transport |
| `render.ts` | Canvas drawing: maze, pellets, Pac-Man, ghosts (normal / frightened / eaten), a “thinking” indicator over waiting characters. | `sim` types |
| `panel.ts` | DOM side panel: per-character live probability bars + confidence + latency for the most recent decision; a scrolling decision log (actor, junction, choice, p, source); running totals of calls, tokens, cost, mean latency, fallback count; error banner. | decision events |
| `main.ts` | Wire-up: game loop (`requestAnimationFrame`), keyboard input, controls (Pac-Man keyboard/jev toggle, speed slider, pause/restart). | all |

### Data flow

```
sim state ──► scheduler (character committed to corridor → next junction known)
                 │  features.ts per option
                 ▼
              brain.buildRequest(batch) ──► POST /api/decide ──► System One (jev)
                 ▲                                                     │
                 └──── brain.parseResponse ◄───────────────────────────┘
                 │
                 ├──► sim intents (direction to take at that junction)
                 └──► panel (probabilities, confidence, latency, cost, source)
```

## Decision design

### When a decision is requested

- A character needs a decision for a junction tile where it has **more than one
  legal exit**.
- Ghosts may not reverse (classic rule), so corridors and most turns need no
  call. jev-Pac-Man may reverse; reversal is offered as an option.
- Eaten ghosts (eyes) return to the house via BFS — no jev call.
- Ghosts inside the ghost house leave on a timer via a fixed path — no jev call.
- Keyboard Pac-Man is never sent to jev.

### Request shape

`state` carries global context; per-character facts live in each question's
`criteria`, so jev evaluates concrete options rather than solving the maze.

```json
{
  "state": {
    "maze": ["############################", "#o...P......##............o#", "..."],
    "legend": "# wall, . pellet, o power pellet, P pacman, B/I/K/C ghosts, - house door",
    "mode": "chase",
    "frightened_seconds_left": 0,
    "pacman": { "x": 13, "y": 23, "dir": "left" },
    "ghosts": { "blinky": { "x": 12, "y": 11, "dir": "down", "state": "normal" } },
    "pellets_left": 212,
    "lives": 3
  },
  "questions": {
    "blinky": {
      "type": "choice",
      "instructions": "You are Blinky, the red ghost. Relentless: always close the distance to Pac-Man. You are approaching junction (12,23). Pick your direction.",
      "criteria": {
        "left": "Pac-Man 3 steps away via this route; no other ghosts on it",
        "up": "Pac-Man 11 steps away via this route",
        "down": "Pac-Man 9 steps away via this route; passes Inky"
      }
    }
  }
}
```

Question names are the actor ids: `pacman`, `blinky`, `pinky`, `inky`, `clyde`.

### Personalities (instructions)

| Actor | Normal instructions | Frightened |
|---|---|---|
| Blinky | Chase Pac-Man directly. | Flee: maximise distance from Pac-Man. |
| Pinky | Ambush: aim ~4 tiles ahead of Pac-Man's heading. | Flee. |
| Inky | Flank: approach Pac-Man from the side opposite Blinky. | Flee. |
| Clyde | Chase when >8 tiles from Pac-Man; otherwise retreat to bottom-left corner. | Flee. |
| Pac-Man | Eat pellets, avoid ghosts, take power pellets when ghosts are near. | Hunt frightened ghosts while time remains. |

During **scatter** mode, ghost instructions switch to "head to your home
corner" (classic corners). Feature strings include the distance relevant to
the current goal (Pac-Man, ambush tile, flank tile, corner), so each
personality's criteria carry the numbers it needs.

### Timing and latency

- The request for a junction is sent as soon as the character commits to the
  corridor leading to it, giving jev the corridor-traversal time (typically
  0.3–1 s) to answer.
- If the character arrives first, it stops at the junction centre and shows
  the thinking indicator until the answer arrives or the timeout fires.
- The speed slider scales game speed (0.25×–1×) so the user can trade
  smoothness against how often waits happen.
- Answers are applied only if still relevant (same actor, same junction, actor
  not eaten/reset since). Stale answers are logged to the panel and dropped.

### Error handling

- Timeout (2 s), non-200, network error, or a choice outside the offered
  options ⇒ greedy fallback for that character. Greedy rule: pick the option
  with the best goal distance from `features` (for Pac-Man: nearest pellet,
  avoiding options whose corridor contains a non-frightened ghost).
- Fallback decisions are shown in red in the log and counted in totals — never
  presented as jev's.
- Server errors (including missing key) surface as a panel error banner, not
  only the console.
- Missing `OPPER_API_KEY`: the game still loads, the banner says
  "No OPPER_API_KEY in .env — all decisions are fallbacks".

## Controls

- Arrow keys / WASD: steer Pac-Man in keyboard mode.
- `J` or a toggle: switch Pac-Man between keyboard and jev.
- Speed slider (0.25×–1×), Pause (`P` / button), Restart (`R` / button).
- Default on load: Pac-Man under jev control (demo mode), game running.

## Testing

TDD with Vitest for all logic modules.

- `maze`: open directions, junction detection, tunnel wrap, BFS distances on
  the real layout and small fixture mazes.
- `sim`: pellet / power-pellet eating, frightened timer and expiry, ghost
  eaten → eyes → house, Pac-Man death and life loss, level clear and reset,
  scatter/chase switching.
- `features`: per-option values on fixture mazes.
- `brain`: request building (questions per actor, only legal options,
  personality/mode instructions), response parsing including malformed
  answers and out-of-set choices.
- `scheduler` (fake clock + fake transport): early request on corridor commit,
  batching within a frame, max-in-flight, wait-at-junction, timeout → fallback,
  error → fallback, stale-answer drop.
- `handleDecide` (fake fetch): key injection, missing key, upstream error
  pass-through, cost/trace header extraction, timeout.
- **Live smoke** `npm run smoke`: one real batched call to jev with a real
  game state; asserts every question returns a valid choice with probabilities.
- **End-to-end** in the built-in browser:
  1. Load the game with jev-Pac-Man; confirm the panel updates and
     `/api/decide` requests are made.
  2. Toggle Pac-Man to keyboard; confirm the requests no longer contain a
     `pacman` question and arrow keys steer.
  3. Run without a key; confirm banner + red fallback decisions.
  4. Check the dev-server log and Opper traces to confirm real jev calls.

## Project layout

```
jevman/
  index.html
  package.json, tsconfig.json, vite.config.ts
  .env (gitignored), .env.example
  server/decide.ts          # handleDecide + Vite plugin
  src/maze.ts, src/layout.ts, src/sim.ts, src/features.ts, src/brain.ts,
  src/scheduler.ts, src/render.ts, src/panel.ts, src/main.ts, src/types.ts
  tests/*.test.ts
  scripts/smoke.ts
  docs/superpowers/specs/2026-10-03-jevman-design.md
```
