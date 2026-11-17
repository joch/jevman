# Contributing

Issues and pull requests are welcome. Before opening a pull request, run `npm run typecheck` and `npm test`.

## Dependency updates

[Dependabot](.github/dependabot.yml) checks the root npm manifest/lockfile,
Dockerfile and GitHub Actions every Saturday at 06:00 Europe/Stockholm, ahead of
the 08:00 maintenance review. Each ecosystem permits up to five open version
update PRs and uses a three-day cooldown. npm development and production
patch/minor updates have separate groups; the production group is ready if
runtime packages are added (the manifest currently has only devDependencies).
Docker and Actions patch/minor updates are grouped when Dependabot can classify
their versions. Major updates remain individual PRs. Inspect the actual version
behind image digests and action SHAs; a group label does not establish low risk.
Security-update settings are unchanged; the version-update schedule, cooldown
and five-PR limit do not delay security PRs. See the
[GitHub options reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference).

Review every dependency PR's release notes, manifest/lockfile diff and immutable
image/action pins. Require `test-and-deploy` on the current revision: typecheck,
unit tests, Docker build and `scripts/smoke-image.py`. The smoke check exercises
readiness/revision, static assets, unauthenticated API behavior and graceful
shutdown without making a paid model call. Reproduce failures before merging;
major, authentication, session and other sensitive changes need a separate
compatibility assessment. Obtain Codex clearance for the revision being merged
and the maintainer's lifecycle authorization. No auto-merge is configured here.

The current `Protect main` ruleset requires an up-to-date PR branch, the
`test-and-deploy` status, resolved review threads and squash merging, with no
bypass actors. Those repository settings are separate from this configuration.
PR runs do not deploy or publish images. A successful push to main can publish
the smoke-tested image when `DOKPLOY_PUBLISH=true`; the existing production
release puller handles delivery. After a dependency release, verify the running
revision and public readiness, retaining the previous release for recovery.

The workflow also retains a legacy Coolify step gated on a non-empty
`COOLIFY_APP_UUID`. A read-only repository-variable check on 2026-11-17 found that
variable absent and `DOKPLOY_PUBLISH=true`, so the Coolify step is currently
inactive. Recheck those variables before changing deployment ownership.

## Benchmark your own model

The [leaderboard](https://jevman.chadda.se/leaderboard) has two parts:

- **Our runs.** We play the System One models Opper serves ourselves. If your model is on Opper (or another API we
  can call), open an issue or a pull request adding it to [`shared/models.ts`](shared/models.ts), and we'll run it.
- **Self-reported.** Any other model, private or local included: you run the benchmark yourself and send the games
  in a pull request. CI replays every game and checks its score, and the leaderboard lists your model as
  **self-reported**.

### 1. Put your model behind an HTTP endpoint

At every junction the bench POSTs the same JSON that jevman sends System One:

```json
{
  "state": { "maze": ["…"], "pacman": { "x": 13, "y": 23, "dir": "left" }, "ghosts": { "…": "…" }, "…": "…" },
  "questions": {
    "pacman": {
      "type": "choice",
      "instructions": "You are Pac-Man. …",
      "criteria": { "up": "Go up: nearest pellet 1 step away; …", "left": "Go left: …", "right": "Go right: …" }
    }
  }
}
```

Answer each question with one of its `criteria` keys:

```json
{ "answers": { "pacman": { "type": "choice", "choice": "left", "probabilities": { "left": 0.7, "up": 0.3 } } } }
```

`probabilities` and `confidence` are optional, and so are `usage` (`{ "input_tokens": 812, "output_tokens": 4 }`) and
`costUsd` (what the call cost; the leaderboard shows it per game). Pac-Man can also get a `pacman_escape` question
mid-corridor, with the same shape.

[`scripts/example-endpoint.ts`](scripts/example-endpoint.ts) is a complete endpoint in 34 lines, to copy and put
your model behind. If yours needs a key, set `BENCH_ENDPOINT_TOKEN`: the bench sends it as a bearer token.

The game runs in real time, as on the leaderboard. An answer that takes over 2 seconds is replaced by a simple rule
(a fallback), and Pac-Man waits at the junction until one or the other decides.

### 2. Try it

```bash
npm ci
node --import tsx scripts/example-endpoint.ts   # or start your own endpoint
npm run bench -- --endpoint http://localhost:8787 --games 2
```

### 3. Record the submission

```bash
npm run bench -- --endpoint http://localhost:8787 --submit submissions/my-model --name "My Model" --by your-github-handle --url https://example.com/my-model
```

This plays the leaderboard's games: 24 games, each to game over or 300 seconds, against the scripted ghosts, 4 at a
time (change that with `--parallel`). It writes `submissions/my-model/`, holding `submission.json` and one
`game-NN.json.gz` per game. The folder name is your model's id: lowercase letters, digits and dashes.

Check it the way CI will:

```bash
npm run submissions
```

### 4. Open a pull request

Commit the folder and open a pull request. CI replays every game and refuses the submission if any game breaks a
rule or doesn't replay to its recorded result. Once it's merged, your model shows up on the leaderboard.

### What "self-reported" means

The game is deterministic, so CI replays your recorded moves against the scripted ghosts and recomputes every score,
survival time, pellet and death itself. A submission can't claim more than its moves earned.

What a replay can't check: that your model made those moves, how fast it really answered, how often it fell back,
what it cost, and that you didn't play more games and keep the best ones. (It does check that the moves are ones the
bench could have made: each answer in time, each escape question answered once, and no game sent twice.) Those are as you report them, which is why the leaderboard
marks these entries. Please submit every game of the run.

When the game or the question changes, `BENCH_VERSION` in [`shared/leaderboard.ts`](shared/leaderboard.ts) goes
up. Older submissions then drop off the leaderboard until they're re-run.
