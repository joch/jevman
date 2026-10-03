# jevman

Pac-Man where the characters are driven by Opper's decision model `typesafe/jev-1.13.0`.
Ghosts are always jev; Pac-Man toggles between keyboard and jev. The side panel shows each
decision's probabilities, confidence, latency and running cost. Red entries are greedy fallbacks
used when jev could not answer (timeout, error, invalid answer or missing key) — never jev's own choice.

## Run

Requires Node ≥ 20.6 (developed on Node 26).

```bash
cp .env.example .env   # then set OPPER_API_KEY to a project-scoped Opper key
npm install
npm run dev            # http://localhost:5173
```

`npm test` runs the unit tests; `npm run smoke` makes one real batched call to jev.

`npm run bench` plays headless games and reports survival time, score, pellets, deaths, calls,
fallbacks, escape questions and cost. It makes paid jev calls whenever jev drives a character.
Flags: `--games 4` (played in parallel), `--pacman jev|greedy`, `--ghosts greedy|jev`, `--max 120`
(seconds of play per game). For example `npm run bench -- --games 2 --pacman jev`.

## Controls

Arrows/WASD steer (keyboard mode) · `J` toggle Pac-Man jev/keyboard · `P` pause · `R` restart · speed slider.

## Cost

Each jev call costs about $0.00005. How many calls a game makes depends on who jev drives and
the game speed (fewer in keyboard mode or at a lower speed). Pac-Man's escape questions raised the
cost per game roughly 2.6× compared with junction questions alone; `npm run bench` reports the
current cost per game.

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
