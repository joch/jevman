# jevman

Pac-Man where the characters are driven by the jev decision model (`typesafe/jev-1.13.0`), called
through Opper or straight from TypeSafe. jev plays one side at a time. In **Watch jev play** (the
default) jev steers Pac-Man and the ghosts follow the classic scripted rules. In **Play against jev**
you steer Pac-Man and jev plays the four ghosts. Pick the mode in the Play dialog, or switch with `J`
during a game.

The side panel shows each of jev's decisions with its probabilities, confidence, latency and the
running cost. Red entries were not jev's own choice: greedy fallbacks used when jev could not answer
(timeout, error or invalid answer) and safety overrides (see [How decisions work](#how-decisions-work)).

Source: <https://github.com/joch/jevman>

## Run

Requires Node ≥ 22.18, which runs the TypeScript server directly. Developed on Node 26; the Docker image uses Node 24.

```bash
npm install
cp .env.example .env   # then set up option A, B or C below
npm run dev            # http://localhost:5173
```

### Option A — your own Opper key in `.env`

Set `OPPER_API_KEY` to a **project-scoped** Opper API key. Every jev call is billed to that key.
This is meant for local development: on an https deployment the key is ignored (unless you set
`JEV_ALLOW_DEV_KEY=1`), because it would pay for every visitor.

### Option B — Login with Opper (players pay for their own play)

1. Register an OAuth app with Opper and add the redirect URI `http://localhost:5173/auth/callback`
   (or your deployment's `https://…/auth/callback`).
2. Set `OPPER_CLIENT_ID`, `OPPER_CLIENT_SECRET`, `OPPER_REDIRECT_URI` and `SESSION_SECRET`
   (`openssl rand -hex 32`) in `.env`.

Visitors who aren't signed in watch a **recorded demo** of a jev game. "Sign in with Opper" sends
them through Opper's sign-in; afterwards jev plays live and every call is billed to **their own
Opper wallet**. The player's key is kept in an encrypted, httpOnly cookie (the page's JavaScript
never sees it). "Sign out" clears the cookie; to revoke the app's key entirely, remove jevman under
connected apps in your [Opper wallet](https://platform.opper.ai/wallet).

### Option C — your own TypeSafe key (jev straight from TypeSafe)

jev is made by [TypeSafe](https://typesafe.ai). To call TypeSafe's own System One API instead of going
through Opper, get an API key from TypeSafe (see [docs.typesafe.ai](https://docs.typesafe.ai/introduction/quickstart))
and set `TYPESAFE_API_KEY` in `.env` (and optionally `TYPESAFE_BASE_URL`, default
`https://api.typesafe.ai`). Calls then go to `POST {TYPESAFE_BASE_URL}/v1/systemone` with model
`jev-1.13.0`; the request and answers are the same as through Opper. TypeSafe's API returns no
cost, so the panel shows an **estimate** (`≈`) from token usage at TypeSafe's published price
($0.042 per million input tokens; output is free). Like option A this is a local key, ignored on
https deployments unless `JEV_ALLOW_DEV_KEY=1`. `npm run smoke` and `npm run bench` use it too.

This is also the easiest way to play jevman without an Opper account: clone the repo, add your
TypeSafe key, `npm run dev`. The hosted page links here from its header, under "Sign in with Opper".

### Which key is used

A signed-in Login-with-Opper player always plays on their own key, through Opper. Otherwise the
server uses `TYPESAFE_API_KEY` if set, else `OPPER_API_KEY`. Variables exported in your shell take
precedence over `.env`. The account area in the page header says which one is in use.

## Scripts

- `npm test` — unit tests (includes a check that the committed demo still replays exactly).
- `npm run build` / `npm start` — production build, then the production server on `PORT` (default 3000).
- `npm run smoke` — one real batched call to jev with the `.env` key (TypeSafe or Opper).
- `npm run bench` — headless real-time games reporting survival time, score, pellets, deaths,
  calls, fallbacks, safety overrides, latency and cost. Paid whenever a model drives a character.
  Flags: `--games 4` (played in parallel), `--pacman jev|greedy` and `--ghosts greedy|jev` (`jev`
  means "a decision model"), `--pacman-model` and `--ghost-model` (any id below; default jev),
  `--max 120` (seconds per game), `--safety on|off` (the safety check described below),
  `--record path.json` (with `--games 1`: save the game for replay). Each model gets a warm-up call
  first, because Opper-hosted models can take many seconds to answer after being idle. The demo was recorded with
  `npm run bench -- --games 1 --pacman jev --ghosts greedy --max 120 --record public/demo/jev-demo.json`;
  re-record it if a change to the game rules makes the replay test fail.
- `npm run leaderboard` — every decision model plays Pac-Man against the scripted ghosts, with the
  safety check **off** so the model itself is measured. Writes `bench/leaderboard.json` (ranked by
  mean score) and prints a table. Same flags as `bench`, plus `--models id,id` (default: all),
  `--parallel 4` (games at a time per model); defaults to 8 games per model and a 300 s cap.
- `npm run deaths -- game.json` — replays a recorded game and prints, for each of Pac-Man's deaths,
  his last few junction decisions with the routes as jev saw them.

## Decision models

Opper serves several System One decision models with the same API, listed in
[`shared/models.ts`](shared/models.ts): `typesafe/jev-1.13.0` (TypeSafe, the default),
`opper/clef` and `opper/clef-flash` (Cloudflare), `opper/kev-4b` (a Qwen3.5-4B fine-tune by Jared
Palmer) and `berget/convaiinnovations/laya` (ConvAI Innovations; its 512-token context is shorter
than one of our questions). The server forwards only these. Through Opper any of them can play; a
TypeSafe key (option C) reaches jev only. The game itself still plays jev.

## Controls

Arrows/WASD steer Pac-Man in Play against jev · `J` or the Pac-Man button switches mode · `P` pause ·
`R` restart · the speed slider slows the game down. Space/Enter presses Play.

## Cost

Each jev call costs about **$0.00005**, through Opper or straight from TypeSafe. With jev playing
Pac-Man a game makes about 1–2 calls per second, so a typical game (two to three minutes until he
runs out of lives) costs **about $0.01**, or **about $0.35 per hour** of continuous play. When you
steer Pac-Man and jev plays the four ghosts it makes about 4 calls per second, **about $0.75 per
hour**. Lowering the speed makes fewer calls. `npm run bench` reports the exact cost per game.

## How decisions work

When a character commits to a corridor its next junction is known, so the game asks jev about it
straight away (one System One request per frame, one `choice` question per character, options =
legal directions described with computed facts: distances to pellets, power pellets, fruit and
ghosts, whether the nearest ghost is coming closer, and whether a ghost can reach the end of the
corridor before Pac-Man). Up to three requests are in flight at once. If the character reaches the
junction before the answer, it waits there (its panel card says "thinking…"). After 2 s, or on an
error, it uses a greedy rule.

Pac-Man can also get a second question mid-corridor: when a dangerous ghost is in the corridor
ahead, or can reach the junction at its end before he does, jev is asked whether to keep going or
turn back right now (`pacman_escape`). Pac-Man keeps moving while it is open, and each situation is
asked once.

jev answers from a snapshot taken when the question was asked, often a whole corridor before Pac-Man
reaches the junction, and the ghosts keep moving. So when Pac-Man takes jev's answer, a **safety
check** looks at the board again. If jev's pick now leads into a ghost, a trap or a ghost about to
touch him, he takes the safe route jev rated highest instead. If every route is unsafe, he takes the
least bad one when jev's pick is clearly worse. The panel and the game-over card count these as
**safety overrides**. An escape question is only asked when the way ahead is already dangerous, so
there the check turns Pac-Man back whenever that is safe, and jev's answer decides only when both
ways are risky. Against the scripted ghosts the safety check roughly doubled how long jev Pac-Man
survives.

## License

Copyright © 2026 Johnny Chadda. jevman is free software under the
[GNU Affero General Public License v3.0 or later](LICENSE). You may use, change and host it. If you
run a modified version as a service, you must offer its users the source of your version, as the
game's "Source on GitHub" link does for this one.
