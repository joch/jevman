# jevman

Pac-Man where the characters are driven by Opper's decision model `typesafe/jev-1.13.0`.
Ghosts are always jev; Pac-Man toggles between keyboard and jev. The side panel shows each
decision's probabilities, confidence, latency and running cost. Red entries are greedy fallbacks
used when jev could not answer (timeout, error, invalid answer or missing key) — never jev's own choice.

Source: <https://github.com/joch/jevman>

## Run

Requires Node ≥ 20.6 (developed on Node 26).

```bash
npm install
cp .env.example .env   # then pick option A, B or C below
npm run dev            # http://localhost:5173
```

### Option A — your own Opper key in `.env`

Set `OPPER_API_KEY` to a **project-scoped** Opper API key. Every jev call is billed to that key.
This is meant for local development: on an https deployment the key is ignored (unless you set
`JEV_ALLOW_DEV_KEY=1`), because it would pay for every visitor.

### Option C — your own TypeSafe key (jev straight from TypeSafe)

jev is made by [TypeSafe](https://typesafe.ai). To call TypeSafe's own System One API instead of going
through Opper, set `TYPESAFE_API_KEY` in `.env` (and optionally `TYPESAFE_BASE_URL`, default
`https://api.typesafe.ai`). Calls then go to `POST {TYPESAFE_BASE_URL}/v1/systemone` with model
`jev-1.13.0`; the request and answers are the same as through Opper. TypeSafe's API returns no
cost, so the panel shows an **estimate** (`≈`) from token usage at TypeSafe's published price
($0.042 per million input tokens; output is free). Like option A this is a local key: it wins over
`OPPER_API_KEY` when both are set, signed-in Login-with-Opper players still play on their own Opper
wallet, and it is ignored on https deployments unless `JEV_ALLOW_DEV_KEY=1`. `npm run smoke` and
`npm run bench` use it too.

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

If several are set, a signed-in player's key wins; otherwise `TYPESAFE_API_KEY`, then `OPPER_API_KEY`.

### Deploying

`npm run build` produces a static site plus server routes (`/auth/*`, `/api/me`, `/api/decide`)
that `vite preview` and the dev server mount; the handlers in `server/` are framework-agnostic so a
standalone Node server can mount them too. For an https deployment:

- set `OPPER_REDIRECT_URI` to `https://your-domain/auth/callback` (and register it on the OAuth app);
- set a real `SESSION_SECRET` (32+ characters) — startup refuses without one;
- do **not** set `OPPER_API_KEY` or `TYPESAFE_API_KEY` (both are ignored anyway unless `JEV_ALLOW_DEV_KEY=1`);
- serve the app at the domain root (paths are absolute).

## Scripts

- `npm test` — unit tests (includes a check that the committed demo still replays exactly).
- `npm run smoke` — one real batched call to jev with the `.env` key (TypeSafe or Opper).
- `npm run bench` — headless games reporting survival time, score, pellets, deaths, calls,
  fallbacks, escape questions and cost. Paid whenever jev drives a character. Flags: `--games 4`
  (played in parallel), `--pacman jev|greedy`, `--ghosts greedy|jev`, `--max 120` (seconds per game),
  `--record path.json` (with `--games 1`: save the game for replay). The demo was recorded with
  `npm run bench -- --games 1 --pacman jev --ghosts jev --max 90 --record public/demo/jev-demo.json`;
  re-record it if a change to the game rules makes the replay test fail.

## Controls

Arrows/WASD steer (keyboard mode) · `J` toggle Pac-Man jev/keyboard · `P` pause · `R` restart · speed slider.

## Cost

Each jev call costs about **$0.00005**, through Opper or straight from TypeSafe. With jev driving all five characters a game makes roughly
5–6 calls per second, so a typical game (about 1–1.5 minutes until Pac-Man runs out of lives)
costs **about $0.02–0.03**, or **about $1 per hour** of continuous play. Steering Pac-Man yourself
or lowering the speed makes fewer calls. `npm run bench` reports the exact cost per game.

## How decisions work

When a character commits to a corridor its next junction is known, so the game asks jev about it
straight away (one System One request per frame, one `choice` question per character, options =
legal directions described with computed facts: distances to pellets, power pellets, fruit and
ghosts, whether the nearest ghost is coming closer, and whether a ghost can reach the end of the
corridor before Pac-Man). If the character reaches the junction before the answer, it waits there
("thinking" bubble). After 2 s, or on an error, it uses a greedy rule.

Pac-Man can also get a second question mid-corridor: when a dangerous ghost is in the corridor
ahead, or can reach the junction at its end before he does, jev is asked whether to keep going or
turn back right now (`pacman_escape`). Pac-Man keeps moving while it is open, and each situation is
asked once.
