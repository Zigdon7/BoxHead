# BoxHead — Zombie Extraction

A co-op zombie **extraction shooter** built from the classic BoxHead, with a 60 Hz server-authoritative **Rust (Axum/Tokio)** backend and a **TypeScript + HTML5 Canvas (Vite)** frontend.

**Status:** version `3.0.0-playtest.1`, the first playtest build. Raids are co-op against the infected (PvE). Player-versus-player raids and base raiding are not built yet.

| If you want to… | Read |
| --- | --- |
| Run it on your own machine for development | [Quick start](#quick-start-local-development) |
| Host it for players | [docs/HOSTING.md](docs/HOSTING.md) |
| Run a playtest: checks before, what to tell testers, what to collect after | [docs/PLAYTEST.md](docs/PLAYTEST.md) |
| Check a build before it ships | [Release check](#release-check) |
| Learn the game as a player | `/learn.html` on a running server |

## The loop

1. **Hideout.** Your stash holds every item you own. Equip a primary and a secondary gun, armor and a pack. Sell loot to the trader and buy common gear up to power 24 (enough for Rust Yard).
2. **Raid.** Pick a map your **gear score** unlocks and drop in. Loot supply crates, kill monsters for loot and a cash bounty, and keep moving.
3. **Extract.** Stand in a green extraction ring for 6 seconds before your raid clock runs out. You keep your loadout, your pack and your bounty. If you're killed, run out of time or leave, everything you carried in is lost.

## Gear, gear score and maps

- Every item has a **power** from 1 to 100 and a **rarity** (common → legendary). Rarer drops roll extra power and sell for much more.
- **Gear score** is the average power of the four loadout slots (an empty slot counts as 0).
- Gun power multiplies damage (×1 + power/50). Armor sets max health (100 + 2 × power). The pack sets loot slots (4 + power/12), ammo reserve (60 + 2 × power) and starting deployables. Katana damage scales with gear score (×1 + score/90).
- Harder maps charge an **entry fee** (Outskirts free, Rust Yard $150, Quarantine $600, Black Site $2,000), paid even if you die, so bounty and loot sales always matter. Combos multiply kill bounty up to 3×.
- **Insurance:** before deploying you can insure your loadout for 35% of its sale value. If the raid is lost, the equipped gear comes back (the pack, bounty, fee and premium don't).
- With nothing equipped you deploy with a **loaner pistol** (20% weaker than any real gun, never lost) and a 2-slot pouch, so nobody can get stuck, but going in naked is never better than the starter kit.
- A new operator starts with a Service Pistol, a Padded Vest, a Canvas Satchel and $400. The stash holds 40 items besides the equipped gear; loot that doesn't fit when you extract is sold for you.

| Map | Gear score | Size | Enemies | Loot power |
| --- | --- | --- | --- | --- |
| Outskirts (10 min) | 0+ | 4640 × 3360 | ×1 health and damage. Walkers, crawlers, a few devils | 2–16 |
| Rust Yard (11 min) | 20+ | 5280 × 4000 | ×1.5 health, ×1.35 damage, ×1.12 speed, brutes, 3% elites | 14–34 |
| Quarantine Zone (12 min) | 40+ | 5920 × 4000 | ×2.1 health, ×1.8 damage, ×1.3 speed, vampires, 6% elites | 32–59 |
| Black Site (13 min) | 65+ | 6560 × 4640 | ×2.8 health, ×2.3 damage, ×1.42 speed, 11% elites | 55–88 |

Rarity adds 0–15 power. Each map's common loot tops out just below the next gate, so it takes a rare-or-better find (and usually several extractions) to move up. Bounty per kill scales with the map too. Maps are generated from a fixed seed: city blocks of buildings with doorways, streets with cover, crates mostly indoors (more toward the centre), extraction points on the corners (and long edges on tiers 3–4), and insertion points along the edges.

## Encrypted loot and uplinks

- **A lot of loot comes sealed.** Crate and enemy drops are sealed 25% of the time on Outskirts, rising by 8% per tier, and more often for rarer items (up to 90%). The Abomination always drops one sealed prize. You can see a sealed item's rarity (its signal) and power, but not what it is. Sealed, it's worth only scrap.
- **Uplinks decrypt it.** Every map has tier + 1 uplinks on inner street crossings (cyan diamonds on the radar and the full map). Stand in an uplink's ring and the first sealed item in your pack decrypts: 4, 6, 8, 11 or 15 seconds by rarity. It becomes gear (60%) or a valuable, of the same rarity and power, with a one-in-five chance of one grade better. Leaving the ring, or going down, restarts the timer.
- **Decrypting is loud.** While you decrypt, monsters within 1,300 units come for you and nests within 1,500 units spawn 1.8× faster.
- **Bring it back later.** Sealed items you extract with go to your stash. Select one in the hideout's Stash tab and choose **Pack for next raid**, and it starts your next raid in your pack (as many as the pack fits), ready to decrypt. Like anything in your pack, they're lost if you die. If you drop out before playing, they go back to the stash.
- Full-pack swaps: gear only replaces weaker gear. Valuables and sealed items replace each other, ranked by sale value (a sealed item by what it should open into).

## Stash and pack

- **Hideout → Stash** shows your loadout and everything in the stash. Filter it by kind and sort it by upgrades first, power, rarity or name. Click an item to compare it with what you have equipped, double-click to equip it, tick items to bulk-sell them, and pack sealed items for the next raid. The other hideout tabs are **Trader**, **Homefront** and **Operators**.
- **In a raid, I** opens your pack: every item, its worth and decryption time, with a Drop button for each. The raid keeps running while it's open. **G** still drops your last pickup.

## Operators, Homefront, Operations and seasons

The rules live in `backend/src/progression.rs`. Every number below is a first guess that playtests are meant to tune.

- **Operators.** An account holds up to 3 operators. Each has its own cash, stash, loadout, Homefront and Operations ranks. Deleting one frees its slot and earns nothing. An operator is created **Safe** (PvE only, Homefront capped at tier 3) or **Raidable** (may reach tier 4 and join PvP). Until PvP exists every new operator is Safe; `BOXHEAD_PVP=1` allows Raidable ones.
- **Homefront.** An operator's base has a tier from 1 to 4. Raising it costs cash and valuables taken from the stash, cheapest first:

  | Tier | Cash | Valuables |
  | --- | --- | --- |
  | 2 | $1,500 | 2 uncommon or better |
  | 3 | $6,000 | 3 rare or better |
  | 4 (Raidable only) | $20,000 | 3 epic or better |

  Four facilities can each be built up to the tier's level. A level costs the base price × level²:

  | Facility | Base price | Each level gives |
  | --- | --- | --- |
  | Storage | $400 | +10 stash slots |
  | Armory | $600 | The trader also sells power 28, then 32, 35 and 38 (never enough to skip raiding for Quarantine Zone) |
  | Insurance Office | $500 | Insurance 4% of gear value cheaper |
  | Workshop | $800 | $60 an hour, collected in the hideout, holding up to 12 hours |

- **Operations.** Every raid earns Operations XP on its map: 100 for extracting or 25 for a lost raid, plus 1 per kill (at most 100). Ranks come at 150, 500, 1,200, 2,500 and 5,000 XP. Each rank cuts that map's entry fee by 10% and adds 4% to the bounty banked there.
- **Seasons.** A season is a calendar quarter (UTC). In its last 28 days an account may **retire** one operator whose Homefront is tier 3 or higher, once per season. (The code, the API action `relocate` and the database call this relocation; players see "Retire".) The operator and everything it owns are deleted, and the account earns **Legacy**:
  - 0 to 3 Legacy points by what the operator was worth (cash plus the sale value of everything it owns): 1 from $5,000, 2 from $20,000, 3 from $50,000. An account can earn 12 in all.
  - 5 more stash slots for every operator (20 at most), and a season badge.
  - A head start next season: +5% bounty and +10% Operations XP, one level higher (up to 3) for retiring in back-to-back seasons.

  Retiring is optional and skipping a season costs nothing.
- **Perks.** A Legacy point buys one level of a perk (3 levels each), and perks apply to every operator on the account: Vitality (+6 max health), Firepower (+3% weapon damage), Scavenger (+5% bounty), Packrat (+5 stash slots), Broker (insurance 3% cheaper). Insurance never drops below 15% of gear value.

## Nests and the Abomination

- Monsters come from **nests**: unbreakable mounds on inner street crossings, never next to an insertion or extraction point. A nest only spawns while a living player is within 1,500 units, keeps a capped number of monsters out (5 + 2 × tier) and its monsters roam near it until they spot someone. Monsters far from everyone are culled.
- **Camping is punished.** If you haven't strayed more than 450 units (14 m) from where you are at any point in the last 30 seconds, a camp meter fills; travelling drains it, and shuffling on the spot doesn't count. After 75 seconds of camping the nest nearest you sends hunters that track you anywhere on the map: first an **Abomination** (1,400 HP × the map's health multiplier, nearly as fast as you, smashes through walls, drops a lucky gear roll and a valuable), and for any later camping in the same raid, packs of three elites (hunters pay only base bounty, so farming them doesn't pay). Hunters stay on a downed target until they leave the raid. The HUD warns from 45 seconds with a countdown, and the meter stays empty while you're being hunted.

## Raids

- Every raid is hosted and simulated by the server. Raids are persistent: you can drop into one already running, and each operator has their own raid clock. Squadmates who deploy within 30 seconds share an insertion point.
- A downed operator bleeds out after 25 seconds (3 seconds if nobody else in the raid is alive). Stand next to them for 3 seconds to revive them at half health.
- Health drops heal 25% of max health and katana kills 4%. Barrel and claymore damage scales with the map's enemy health. Explosions deal full damage at the centre and 40% at the edge; rockets cost 2 rounds.
- With a full pack, gear you walk over replaces your weakest gear (by power) and valuables your cheapest valuable. **G** drops the last item you picked up.
- Leaving or disconnecting mid-raid counts as abandoning it (gear lost). Dropping before you've sent any input voids the raid (gear kept, insurance premium refunded, entry fee not refunded); a server restart voids raids and returns the gear, the entry fee and the premium.
- You can pause (`P`) only while you are alone in a raid. It freezes everything, raid clock included, and anyone joining resumes it.
- **Networking:** each client gets its own 30 Hz delta stream with only the enemies, bullets, drops and deployables within 1,500 units of its player. Worst case on Black Site (220 enemies on screen, 6 players firing) measures about 300 KB/s per player: `cargo test --release bandwidth -- --ignored --nocapture`.

## Controls

- **WASD**: move · **Mouse**: aim · **Left click**: shoot
- **Space** or **right click**: katana cleave
- **Shift** (or double-tap a direction): i-frame dash
- **1 / 2**: primary / secondary gun
- **E / Q / F** (or **5 / 6 / 7**): barrel / barricade / claymore · **G**: drop the last loot picked up
- **I**: pack (inventory) · **M**: full map · **P**: pause (solo raids) · **Esc**: controls and Leave raid

Keys can be rebound under **Controls** on the home screen. The in-game guides are `/learn.html` (Learn to Play) and `/about.html`.

## Quick start (local development)

You need [Node.js](https://nodejs.org) 24 and [Rust](https://rustup.rs) (the toolchain is pinned by `rust-toolchain.toml`). On Windows, read the [Windows toolchain](#windows-toolchain) note first.

1. **Backend (port 3001):**
   ```sh
   cd backend
   cargo run
   ```
   It creates `boxhead.db` in the folder it is started from.

2. **Frontend (port 5173):**
   ```sh
   cd frontend
   npm ci
   npm run dev
   ```
   The dev server proxies `/api` and `/ws` to the backend.

3. Open **`http://localhost:5173`** and sign up with an email address. No email is sent in development: the confirmation link is printed in the backend's log. Open it, then go back to `http://localhost:5173`: the account can now deploy.

4. **Ops dashboard (optional, port 3900):** start the backend with an ops token, then run the dashboard with the same token.
   ```sh
   export BOXHEAD_OPS_TOKEN=dev-ops-token   # PowerShell: $env:BOXHEAD_OPS_TOKEN = "dev-ops-token"
   cd dashboard
   cargo run
   ```
   Open **`http://localhost:3900`**.

To serve the built site from the backend instead of the dev server, run `npm run build` in `frontend/` and open `http://localhost:3001`.

## Project layout

| Path | What it is |
| --- | --- |
| `backend/` | The game server (`boxhead-server`): raid simulation, accounts, hideout and progression, SQLite storage |
| `frontend/` | The web client: the game, the hideout and the guides |
| `dashboard/` | The ops dashboard (`boxhead-dashboard`), a separate service |
| `schema/types.json` | The WebSocket message schema. `npm run generate:types` writes `frontend/src/generated/types.ts` from it |
| `tests/e2e/` | End-to-end tests that drive the real binaries |
| `scripts/release-check.mjs` | The release check |
| `Dockerfile`, `compose.yaml`, `deploy/`, `.env.example` | Hosting (see [docs/HOSTING.md](docs/HOSTING.md)) |
| `docs/` | Hosting and playtest guides |

## Accounts and sign-in

- **There is no guest play.** You need a signed-in account to open the hideout, host a lobby or drop into a raid. The server checks the session token on every join and hideout request.
- **One account id, many identities.** A BoxHead account (`users.id`) can have Steam, Bluesky, Google and email identities linked to it (`linked_accounts`). Signing in with any of them opens the same account and stash. Once signed in, the home screen shows **Link Steam** and **Link Bluesky**. An identity can belong to only one account.
- **Steam** uses OpenID 2.0: `GET /api/auth/steam/start[?link=<session token>]` redirects to Steam, and `/api/auth/steam/callback` checks the one-time nonce and return address, confirms the assertion with Steam (`check_authentication`), then signs in or links. No API key is needed. If `STEAM_API_KEY` is set, the persona name comes from the Web API; otherwise it comes from the public profile. Set `BASE_URL` when the server sits behind a proxy, so the return address matches.
- **Bluesky** signs in with a handle and app password. `POST /api/auth/login {handle, password, token?}`: with a session token it links Bluesky to that account instead.
- **Email** accounts use `POST /api/auth/email/register {email, password}` and `POST /api/auth/email/login {email, password}`. Passwords need at least 8 characters.
- `GET /api/auth/me?token=` returns the account and its `linked` identities.
- **Email accounts confirm by link.** Sign-up emails a confirmation link (valid 3 days). Until it is followed the account can use the hideout but can't deploy or host. Accounts that also sign in through Steam, Bluesky or Google skip this. Accounts created before confirmation existed count as confirmed. `POST /api/auth/email/resend {token}` sends a new link.
- **Password reset.** `POST /api/auth/password/forgot {email}` emails a one-hour link to `/?reset=<token>` and answers the same way whether or not the account exists. `POST /api/auth/password/reset {token, password}` sets the password, signs out every session and signs this one in. Link tokens are stored only as SHA-256 hashes.
- **Account deletion.** `POST /api/account/delete {token, confirm: "DELETE"}` removes the account and everything it owns (operators, stash, Homefront, Legacy, friends, linked sign-ins). It is refused while an operator is in a raid.
- **Matchmaking pools.** Players are matched by the platform they signed in with this session (Steam, Bluesky, or email/Google). Turning on cross-platform play (`POST /api/matchmaking/crossplay {token, enabled}`) moves the account into one shared pool.
- **Friends.** `GET /api/friends?token=` lists friends and whether each is in a raid; `POST /api/friends/add {token, handle}` and `/api/friends/remove` change the list.

## Hosting

`Dockerfile` and `compose.yaml` run the game server, the ops dashboard and scheduled database backups on one machine, with a Cloudflare Tunnel or Caddy in front for HTTPS. The walkthrough is in [docs/HOSTING.md](docs/HOSTING.md). `GET /healthz` answers `ok` while the server and its database are up.

## Server settings

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3001` | Public HTTP/WebSocket port. |
| `BOXHEAD_DB` | `boxhead.db` | Path of the SQLite database file. |
| `STATIC_DIR` | `../frontend/dist` | Folder with the built website. |
| `BASE_URL` | request host | Public origin (e.g. `https://play.example.com`), used in Steam return addresses and email links. **Set it in production.** |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `MAIL_FROM` | unset | Outgoing email. Port 587 uses STARTTLS, 465 uses TLS. Without `SMTP_HOST`, links are printed to the server log. |
| `BOXHEAD_MAIL_OUTBOX` | unset | Write emails as JSON files to this folder instead of sending (tests, local development). |
| `BOXHEAD_TRUST_PROXY` | off | Behind one reverse proxy, read the client IP from the last `X-Forwarded-For` entry (for rate limits). Only enable when the proxy sets that header. |
| `BOXHEAD_RATE_LIMIT` | on | `off` disables per-IP rate limits (load tests only). |
| `BOXHEAD_PVP` | off | `1` allows Raidable operators. Off until PvP raids exist. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | unset | Google sign-in. Without them the sign-in screen doesn't offer Google. |
| `STEAM_API_KEY` | unset | Optional: Steam persona names from the Web API. |
| `BOXHEAD_BUILD` | unset | A short label for this build, usually the git commit. Shown next to the version at the foot of the home and sign-in screens, in the startup log and on the dashboard. Letters, digits and `. _ - +`, at most 40 characters. |
| `BOXHEAD_FEEDBACK_URL` | unset | An `http(s)` link shown as **Report a bug** on the home screen, the sign-in screen and the pause menu. Anything else is ignored. |
| `BOXHEAD_NOTICE` | unset | One line (at most 200 characters) shown on the home and sign-in screens, for example `Playtest build. Progress may be wiped.` |
| `BOXHEAD_SIM_THREADS` | one per CPU core | Threads that simulate raids. |
| `BOXHEAD_PUBLISH_THREADS` | half the CPU cores, at least 2 | Threads that build and send each raid's state updates. |
| `BOXHEAD_MAX_ROOMS` | `256` | The most raids running at once. |
| `BOXHEAD_EMPTY_ROOM_TTL_SECS` | `90` | How long a player-hosted raid stays open with nobody in it. |
| `BOXHEAD_OPS_TOKEN`, `BOXHEAD_OPS_ADDR`, `BOXHEAD_SERVER_ID` | unset, `127.0.0.1:3901`, `game-<port>` | The internal ops API (see [Ops dashboard](#ops-dashboard)). |

`GET /api/config` tells the client what it needs from these: the Google client id, whether PvP is on, the minimum password length, and the `version`, `build`, `feedbackUrl` and `notice` shown on the home screen.

Rate limits (per client IP, token buckets): sign-ups 10 then 20/hour, sign-ins 10 then 120/hour (plus 10 then 40/hour per email), reset and confirmation emails 5 then 10/hour, password resets 10 then 30/hour, hosting 10 then 120/hour, adding friends 20 then 60/hour, game joins 30 then 600/hour, hideout calls 60 then 10/second, other API calls 120 then 20/second. Over the limit the server answers `429` with `Retry-After`.

The database runs in WAL mode (`synchronous=NORMAL`): commits don't wait on a disk flush, and a crash of the process loses nothing; a power cut can lose the last moments. Back up `boxhead.db` with SQLite's online backup (`sqlite3 boxhead.db ".backup backup.db"`), not a file copy, while the server runs. The schema is created and upgraded in place when the server starts.

## Servers

- Every server (room) is hosted and simulated by the backend. Each room runs its own 60 Hz authoritative game loop, and clients never host.
- Room loops run in parallel on a dedicated simulation thread pool (`room-sim-0..N`), separate from the threads serving HTTP and WebSockets, so a busy round never delays networking. Building and sending each room's state runs on a second pool (`room-pub-0..N`), so network work never lands on a game thread.
- **Play** opens the hideout. **Choose a raid** opens the deploy screen: pick a map, then a raid on it (double-click to deploy immediately), or host your own.
- Every map has one permanent raid per matchmaking pool (id = `<map>-<pool>`; a bare map id resolves to the player's own pool). Any signed-in player can host more. A raid a player created shuts down after it has been empty for 90 seconds.
- **Stashes** belong to the account, on any device.
- API:
  - `GET /api/rooms?token=` lists raids with their map and `canJoin`. `POST /api/rooms {token, name, map}` creates one in the host's pool.
  - `GET /api/hideout?token=` returns the account (operators, season, Legacy) and the active operator: stash, loadout, cash, gear score, trader offers, maps, Homefront, Operations and which sealed items are packed for the next raid. `POST /api/hideout/{equip|unequip|sell|sellMany|buy|carry} {token, itemId?, itemIds?, slot?, offerId?, carry?}` changes them and returns the new state. Account actions use the same route: `createOperator {name, raidable}`, `switchOperator {operatorId}`, `deleteOperator {operatorId, confirm: true}` (frees the slot, earns nothing, refused mid-raid), `upgradeTier`, `upgradeFacility {facility}`, `collectWorkshop`, `relocate {confirm: true}` and `buyPerk {perk}`. Gear is locked while you're in a raid.
  - `GET /api/maps` lists the maps.
- The WebSocket `join` message takes `roomId`, `token`, `name` (the callsign) and `insure`. The server checks verification and gear score, charges the entry fee, then locks the loadout into the raid. When a raid ends the server sends `raidEnd` (outcome + stash settlement) and closes the socket.

## Ops dashboard

Monitoring and admin actions live in a **separate service** (`dashboard/`). The game server has no public admin endpoints.

- **Game server ops API.** It is enabled only when `BOXHEAD_OPS_TOKEN` is set. It listens on `BOXHEAD_OPS_ADDR` (default `127.0.0.1:3901`), never the public game port, and every call needs `Authorization: Bearer <token>`. It provides `GET /ops/v1/status`, `POST /ops/v1/rooms/{id}/restart` and `POST /ops/v1/restart-all`. A restart clears and restocks the world. Players stay in their raids. `BOXHEAD_SERVER_ID` names the server on the dashboard.
- **Dashboard.** It polls every server listed in `GAME_SERVERS` (comma-separated ops URLs, so one dashboard can watch a whole fleet). It shows:
  - each server's version and build, and how long it has been up
  - per-thread load: the share of time each sim thread spends ticking rooms, and room ticks per second
  - per-room tick health: average and worst tick against the 16.7 ms budget, overruns, dropped updates, and the thread the room last ran on
  - players, map and zombies
  - unreachable servers

  Operators can restart one room or every room on a server.
- **Dashboard access.** By default it listens on `127.0.0.1:3900` (`DASHBOARD_ADDR`). It refuses to listen on a non-loopback address unless `DASHBOARD_PASSWORD` is set, which turns on HTTP Basic auth. Restart actions require an `X-Dashboard-Action` header, so other websites can't trigger them. `DASHBOARD_POLL_MS` sets the poll interval (default 1000).

## Testing

Run everything with `npm test` from the repo root, or one layer at a time:

| Command | What it covers |
| --- | --- |
| `npm run test:backend` | Rust unit tests: gear and loot rules, map generation (reachability), nests, camping and the Abomination, extraction, death, bleed-out, backpacks, stash transactions, operators, Homefront, Operations, seasons and Legacy, accounts and email links, rate limits, join rules, room registry, raid settlement, tick metrics, sim thread pool, ops auth, build info |
| `npm run test:dashboard` | Rust unit tests: thread utilization maths, room health, fleet aggregation, outage tracking, exposure and anti-CSRF guards |
| `npm run test:frontend` | Vitest: gear score and upgrade previews, map gates, raid HUD helpers, results text, raid browser partitioning, friends sorting, safe callsigns, the build label and feedback link |
| `npm run typecheck` | TypeScript, strict, over the whole client |
| `npm run test:e2e` | Builds everything, boots the real game server (4 sim threads) on a throwaway database plus the dashboard, and drives them over HTTP and WebSocket (accounts and email links, raid browser, hideout, operators and Homefront, gear-score gates, abandoning a raid, rate limits, ops and dashboard), including a 24-room parallel load test (`tests/e2e/server.test.mjs`) |

The end-to-end suite sets `BOXHEAD_EMPTY_ROOM_TTL_SECS=2` so lobby expiry can be observed quickly. Set `BOXHEAD_SERVER_BIN` or `BOXHEAD_DASHBOARD_BIN` to test different binaries.

### Release check

```sh
npm run release:check              # static checks, unit tests, release builds, end-to-end tests
npm run release:check -- --quick   # static checks and unit tests only
npm run release:check -- --docker  # also build the Docker image and smoke-test it
```

`scripts/release-check.mjs` runs, in order: the version is the same in every manifest and lockfile; every setting the servers read is described in this README or the hosting guide, and everything `compose.yaml` takes from `.env` is in `.env.example`; relative links in the docs resolve; the generated types match the schema; the typecheck and all unit tests; optimized builds of the website, the game server and the dashboard with `--locked`; then the end-to-end suite against those optimized binaries. With `--docker` it also validates `compose.yaml`, builds the image, starts it on a throwaway volume and checks it serves the website and reports the right version. It changes nothing in the repository and exits with 0 only if every step passed.

To cut a new version, change `version` in `backend/Cargo.toml`, `dashboard/Cargo.toml`, `package.json` and `frontend/package.json`, update the lockfiles (`cargo build` in `backend/` and `dashboard/`, `npm install --package-lock-only` in `frontend/`), and run the release check: its first step fails until they all agree.

### Windows toolchain

The backend compiles bundled SQLite, so it needs a MinGW GCC that targets MSVCRT on `PATH` (for example `winget install BrechtSanders.WinLibs.POSIX.MSVCRT`). Three things can break a Windows build, all fixed by setting the environment before running `cargo`:

1. **An old `cargo` ahead of rustup's on `PATH`** (Chocolatey installs one). It ignores `rust-toolchain.toml`. Put `%USERPROFILE%\.cargo\bin` first.
2. **A clang-based `gcc` ahead of the MinGW one** (LLVM-MinGW). Linking fails with `unable to find library -lgcc_eh`. Put the WinLibs `mingw64\bin` folder first.
3. **Linking with a recent system GCC** (seen with GCC 16 and binutils 2.47) produces a `--release` server that crashes before `main` with an access violation. Link with the MinGW that ships with Rust instead:
   ```powershell
   $env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = "$env:USERPROFILE\.rustup\toolchains\stable-x86_64-pc-windows-gnu\lib\rustlib\x86_64-pc-windows-gnu\bin\self-contained\x86_64-w64-mingw32-gcc.exe"
   ```

`npm run release:check` applies all three by itself when it finds those tools. If a server or test binary crashes at startup with `STATUS_ACCESS_VIOLATION` after changing toolchains, the `target/` folder holds artifacts from the old one: run `cargo clean` and rebuild. None of this applies to the Docker image, which builds on Linux.
