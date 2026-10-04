# Login with Opper for jevman

Date: 2026-10-04

## Goal

Let anyone try jevman without an Opper API key of their own in `.env`: visitors
sign in with **Login with Opper** and jev calls are billed to **their own Opper
wallet**. Before signing in, visitors watch a **recorded demo** of a jev game.
The design must deploy easily later (no database, server logic in plain
handlers that a standalone Node server can mount).

### Decisions (from the user)

- Each player pays for their own jev calls via Login with Opper; the deployed
  site never pays for players.
- Logged-out visitors see a recorded jev game (no live calls).
- The user registers the OAuth app and puts its credentials in `.env`.
- The player's key is kept in an **encrypted httpOnly cookie** (stateless
  server; page JavaScript never sees the key).

### Assumptions (stated, not asked)

- Local development keeps working with the existing `.env` `OPPER_API_KEY`, but
  only through the Vite dev server ("dev key" mode). `npm run bench` and
  `npm run smoke` keep using `.env` unchanged.
- Hosting is out of scope here; this spec only keeps the server code portable.
- Login with Opper keys must be accepted by `POST /v3/compat/v1/systemone` for
  `typesafe/jev-1.13.0`. The endpoint requires a *project-scoped* key and
  enforces provider entitlements; Login with Opper issues project-scoped keys,
  but entitlement for arbitrary users is **unverified** and is checked first
  (see Verification spike). If it fails, the work stops and the user decides.

### Non-goals

- Hosting/deployment, custom domain, HTTPS setup.
- Server-side rate limiting or spend caps (players spend their own wallet).
- Device flow, popup flow, React components from `@opperai/login`.

## Login with Opper (facts)

From `@opperai/login` 0.4.1 (README and source):

- Authorize: browser goes to `https://api.opper.ai/oauth/authorize?client_id&redirect_uri&response_type=code&state`.
- Token: server POSTs `application/x-www-form-urlencoded` `grant_type=authorization_code, code, client_id, client_secret, redirect_uri` to `https://api.opper.ai/oauth/token`. `OpperLogin.exchangeCode(code)` does this and returns `{ apiKey, user, credentialId?, orgId?, projectId?, projectUuid?, projectName?, expiresAt? }`.
- The key is a Bearer API key, project-scoped, billed to the user's Opper wallet.
- Wallet (balance, auto-recharge, connected apps): `https://platform.opper.ai/wallet` (`getPortalUrl()`).
- `clientSecret` is server-side only.

## Configuration

New `.env` variables (documented in `.env.example`):

| Variable | Purpose | Default |
|---|---|---|
| `OPPER_CLIENT_ID` | OAuth app client id (`opper_app_…`) | none → login disabled |
| `OPPER_CLIENT_SECRET` | OAuth app secret (server only) | none → login disabled |
| `OPPER_REDIRECT_URI` | Must match the registered redirect | `http://localhost:5173/auth/callback` |
| `SESSION_SECRET` | ≥ 32 chars; key for cookie encryption | dev: random per process + warning (sessions reset on restart) |
| `OPPER_API_KEY` | Existing dev key (dev server only) | none |
| `OPPER_BASE_URL` | Existing | `https://api.opper.ai` |

If client id/secret are missing, `/auth/login` returns a clear error page and
`/api/me` reports `loginAvailable: false`.

## Architecture

### Server: plain handlers + one Vite plugin

All new server logic lives in framework-agnostic modules taking a small request
shape and returning `{ status, headers, body }`, so a future standalone server
can mount them. The Vite plugin (`jevPlugin`) mounts them for local dev.

| Module | Responsibility |
|---|---|
| `server/session.ts` | `sealSession(data, secret)` / `openSession(cookie, secret)`: AES-256-GCM with a key derived from `SESSION_SECRET` (HKDF-SHA256), base64url `iv.ciphertext.tag`, payload `{ v: 1, apiKey, user: { name, email }, projectName, expiresAt, issuedAt }`. `openSession` returns null for tampered, malformed, wrong-secret or expired cookies. Cookie helpers: `parseCookies(header)`, `serializeCookie(name, value, opts)`. |
| `server/auth.ts` | `handleLogin`, `handleCallback`, `handleLogout`, `handleMe` (below). Token exchange through an injectable `exchangeCode(code)` (production: `new OpperLogin({ clientId, clientSecret, redirectUri, opperUrl }).exchangeCode`). |
| `server/decide.ts` | Existing `handleDecide` unchanged in contract; new `resolveKey(req, deps)` picks the key: session key → `{ apiKey, mode: 'player' }`; else dev key if the plugin passed one → `{ mode: 'dev' }`; else none. |
| `server/plugin.ts` | `jevPlugin(env)` moved here from `decide.ts`; mounts `/auth/login`, `/auth/callback`, `/auth/logout`, `/api/me`, `/api/decide`; passes the dev key. |

### Routes

- `GET /auth/login` — 404-style error page if login is not configured.
  Otherwise: generate a 32-byte random `state`, set cookie `jevman_oauth_state`
  (httpOnly, SameSite=Lax, Path=/auth, Max-Age 600, Secure if the redirect URI
  is https), 302 to the authorize URL.
- `GET /auth/callback?code&state` — require `state` to equal the state cookie
  (constant-time compare) else 302 `/?auth_error=state`. Call
  `exchangeCode(code)`; on failure 302 `/?auth_error=exchange`. On success set
  `jevman_session` = sealed session (httpOnly, SameSite=Lax, Path=/, Secure if
  https, Max-Age = seconds until `expiresAt`, capped at 30 days, default 30
  days), clear the state cookie, 302 `/`. The API key never appears in a URL,
  log line or response body.
- `POST /auth/logout` — require `Content-Type: application/json` (same CSRF
  guard as `/api/decide`); clear `jevman_session`; 200 `{ ok: true }`.
- `GET /api/me` — `{ mode: 'player' | 'dev' | 'none', user?: { name, email },
  projectName?, walletUrl: 'https://platform.opper.ai/wallet', loginAvailable }`.
  Never includes the key.
- `POST /api/decide` — existing guards (POST, JSON content type). Key from
  `resolveKey`. No key → 401 `{ error: 'Sign in with Opper to let jev play', signedOut: true }`.
  Upstream mapping when the key is a player key:
  - 401 → clear `jevman_session`, 401 `{ error: 'Your Opper sign-in has expired — sign in again', signedOut: true }`.
  - 402 → 402 `{ error: 'Your Opper wallet is empty — top up to keep playing', walletUrl }`.
  - 403 → 403 `{ error: 'jev is not enabled for your Opper account', … }`.
  - others unchanged (502/504 as today).
  Dev-key behaviour is unchanged.

CSRF: session cookie is SameSite=Lax (not sent on cross-site POSTs) and
`/api/decide` + `/auth/logout` require JSON (forces a CORS preflight that the
server never answers). State cookie protects the OAuth callback.

### Client

- `src/auth.ts`: `fetchMe()`, `signIn()` (navigate to `/auth/login`),
  `signOut()` (POST `/auth/logout`, reload).
- On load `main.ts` calls `fetchMe()`:
  - `player` or `dev` → live game exactly as today. A new account bar above the
    HUD shows "Signed in as {name} · {projectName} · My Opper wallet ↗ · Sign out"
    (player) or "Local dev key" (dev).
  - `none` → **demo mode** (below) with a bar "Recorded demo — Sign in with
    Opper to let jev play live" and a **Sign in with Opper** button (disabled
    with a tooltip if `loginAvailable` is false).
  - `?auth_error=…` → banner explaining the failure with a retry button; the
    query is removed from the URL with `history.replaceState`.
- Live-game errors with `signedOut: true` switch the account bar to the
  signed-out state and show the Sign in button; 402 shows the wallet link.
  The game keeps running on visible fallbacks as today.

### Recorded demo

The simulation is deterministic given each frame's `dt` and the directions
`Controls.decide` returns, so a game replays exactly from a recording.

- **Recording** (`npm run bench -- --games 1 --ghosts jev --record public/demo/jev-demo.json --max 90`):
  the bench wraps its `Controls` and logs every non-null `decide` return as
  `[frame, key, choice]` (after the scheduler's escape translation), every
  frame's `dt` (rounded to 0.1 ms), and every `SchedulerEvent` as
  `[frame, event]`. Written as
  `{ version: 1, recordedAt, model, frames: number[], decisions: [frame, key, choice][], events: [frame, SchedulerEvent][], final: { score, lives, level, frames } }`.
  Expected size ≈ 100–150 KB. Committed under `public/demo/`.
- **Replay** (`src/replay.ts`): `createReplay(recording)` → `{ state, step(): boolean, eventsUntil(frame) }`.
  A fresh `createGame()` is advanced one recorded frame at a time with the
  recorded `dt` and a `Controls` that returns the recorded choice for
  `(frame, key)` (null otherwise). In the page, recorded frames are consumed in
  real time (accumulate wall-clock time against recorded `dt`s); recorded
  `SchedulerEvent`s are fed to the existing `Panel` when their frame is
  reached. At the end it pauses 3 s on the final screen and loops. Controls
  (J, speed, pause, restart) are disabled in demo mode except pause.
- **Determinism guard**: a unit test replays the committed recording headlessly
  and asserts the final score, lives, level and frame count equal
  `recording.final`. Any sim change that breaks replay fails this test; the fix
  is to re-record.

## Verification spike (first, before building)

Once the user has registered the OAuth app and put `OPPER_CLIENT_ID` /
`OPPER_CLIENT_SECRET` in `.env`:

1. Build only `/auth/login` + `/auth/callback` (key kept in server memory for
   the spike, logged as `[redacted]`).
2. The user completes the sign-in in the built-in browser (Claude never types
   credentials).
3. The server makes one `systemone` call with the issued key.
4. Pass → continue with the plan. 401/403 (entitlement) → stop and report to
   the user with the exact error.

## Error handling summary

| Situation | Behaviour |
|---|---|
| Login not configured | `/api/me.loginAvailable=false`; demo bar shows a disabled button + tooltip; `/auth/login` explains which env vars are missing |
| State mismatch / exchange failure | redirect `/?auth_error=state|exchange`; banner with retry |
| Cookie tampered / wrong secret / expired | treated as signed out |
| Upstream 401 with player key | cookie cleared; signed-out bar; fallbacks continue |
| Wallet empty (402) | banner with "My Opper wallet ↗" |
| jev not enabled (403) | banner with the message |
| Missing `SESSION_SECRET` in dev | random per-process secret + one warning line |

## Testing

TDD with Vitest:

- `session`: seal/open round trip; tampered ciphertext, wrong secret,
  malformed input and expired payload → null; cookie parse/serialize
  (attributes, Max-Age, Secure).
- `auth`: login redirect URL params + state cookie; login not configured;
  callback happy path (fake `exchangeCode`, session cookie set, state cookie
  cleared, redirect `/`); state missing/mismatch; exchange failure; logout
  clears cookie and requires JSON; `/api/me` for player/dev/none never contains
  the key.
- `decide` key resolution: session beats dev key; dev key when no session; no
  key → 401 signedOut; upstream 401 with player key clears cookie; 402/403
  mapping; key redaction still covers the player key.
- `replay`: determinism guard on the committed recording; a tiny synthetic
  recording replays decisions at the right frames.
- Live (manual, built-in browser): sign in through Opper (user enters their
  own credentials), play a live game billed to the signed-in account, confirm
  `/api/decide` uses the player key (server log line says `player`), sign out →
  demo mode, sign in again, tamper with the cookie → signed out. Dev-key mode
  still works with no session.
