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

## Controls

Arrows/WASD steer (keyboard mode) · `J` toggle Pac-Man jev/keyboard · `P` pause · `R` restart · speed slider.

## Cost

With jev controlling Pac-Man the game makes about 3–4 jev calls per second (fewer in keyboard mode or at a lower speed). Each call costs roughly $0.00005, so about $0.6 per hour of play.

## How decisions work

When a character commits to a corridor its next junction is known, so the game asks jev about it
straight away (one System One request per frame, one `choice` question per character, options =
legal directions described with computed distances). If the character reaches the junction before
the answer, it waits there ("thinking" bubble). After 2 s, or on an error, it uses a greedy rule.
