# BoxHead Remake — Tactical Horde Survival

A modern multiplayer rebuild of the classic game **BoxHead**, featuring a 60 Hz server-authoritative **Rust (Axum/Tokio)** backend and a **TypeScript + HTML5 Canvas (Vite)** frontend.

## Features
- **Tactical HUD & Visuals:** Live Wave Progress header, Combo Multiplier HUD, Kill/Event feed, floating damage & crit numbers, persistent blood decals, muzzle flashes, shockwaves, and screen shake.
- **Classic BoxHead Combo System:** Chain kills within 4s to build up to a `5.0x` score multiplier, unlock weapons, earn free ammo/tactical gear at combo milestones, and trigger **Overdrive** (`10x+` combo for +15% speed & 25% faster fire rate).
- **Placeable Tactical Items:** Deploy **Explosive Barrels** (`E`), **Reinforced Barricades** (`Q`), and **Proximity Claymore Mines** (`F`) with full chain-reaction explosions.
- **Combat & Mobility Upgrades:** Critical hits (`1.75x` damage), bullet & explosion knockback physics, **i-Frame Dash** (`Shift` or double-tap direction) with dash shockwaves, Wave Breaks, and an in-game **Tactical Armory** (`B`) to upgrade weapon power, armor, ammo capacity, and tactical supplies.

## Quick Start (Local Development)

1. **Backend (Port 3001):**
   ```powershell
   cd backend
   $env:PATH = "C:\msys64\ucrt64\bin;$env:PATH"
   cargo run
   ```

2. **Frontend (Port 5173):**
   ```powershell
   cd frontend
   npm run dev
   ```

3. Open **`http://localhost:5173`** in your browser.

## Controls
- **WASD** — Move
- **Mouse** — Aim
- **Left Click** — Shoot
- **Space** — Melee Attack (cone cleave + knockback)
- **Shift** (or double-tap move) — i-Frame Dash + Shockwave
- **1 - 4** — Select Weapon (Pistol, Uzi, Shotgun, Rocket Launcher)
- **E / Q / F** (or **5 / 6 / 7**) — Place Explosive Barrel / Barricade / Claymore Mine
- **B** — Open/Close Tactical Armory (Spend Score on upgrades)

## Host Pause & Field Guide

- The first connected player is host. Use **P** or **Pause / Resume** to freeze or resume the entire round. Only the host can do this.
- If the host disconnects, the round resumes automatically and the longest-connected remaining player becomes host. Restarts retain that order.
- **About:** `/about.html` · **Learn to Play:** `/learn.html`. Both are linked from the main menu; the in-game **Field Guide** opens in a new tab without leaving the squad.
- The illustrated guide covers all five enemy types, weapons, deployables, pickups and armory upgrades, with a wave-based enemy stat preview. Enemy, firearm, pickup and deployable illustrations share rendering code with the game.
- Reading a guide or opening the armory does not automatically pause the round. Ask the host to pause first if needed.

## Servers & Verified Accounts

- Every server (room) is hosted and simulated by the backend. Each room runs its own 60 Hz authoritative game loop, and clients never host.
- Every **signed-in** account (email, Google or Bluesky) is **verified**. Guests are **unverified**. Email confirmation is planned before launch: once it exists, gate unconfirmed email accounts in `Database::is_verified`.
- Verified players can join any server. Unverified players can only join **Open** servers. The server checks this from the session token on join, so a modified client cannot bypass it.
- The home screen has **Play** and **Sign In**. **Play** opens the server browser, which lists **Verified Lobbies** and **Open Lobbies** separately. Pick one (double-click to deploy immediately) or host your own lobby for anyone to join.
- Two permanent servers always exist: **Open Arena** and **Verified Arena**. Anyone can host an open lobby. Only verified accounts can create verified-only servers. A server a player created shuts down after it has been empty for 90 seconds.
- API: `GET /api/rooms?token=` lists servers with `canJoin` for the caller. `POST /api/rooms {token, name, verifiedOnly}` creates one. The WebSocket `join` message takes a `roomId`.

## Testing

Run everything with `npm test` from the repo root, or one layer at a time:

| Command | What it covers |
| --- | --- |
| `npm run test:backend` | Rust unit tests: join rules, verification, room registry, empty-lobby reaping, room limit, per-room simulation, pause, restart, wave unlocks |
| `npm run test:frontend` | Vitest: server-browser partitioning, selection fallback, status text, friends sorting, safe callsigns |
| `npm run test:e2e` | Builds both apps, then boots the real server on a throwaway database and drives it over HTTP and WebSocket (`tests/e2e/server.test.mjs`) |

The end-to-end suite sets `BOXHEAD_EMPTY_ROOM_TTL_SECS=2` so lobby expiry can be observed quickly. Set `BOXHEAD_SERVER_BIN` to test a different binary.

**Windows toolchain note:** the backend compiles bundled SQLite, so it needs a MinGW GCC that targets MSVCRT (for example `winget install BrechtSanders.WinLibs.POSIX.MSVCRT`) on `PATH`. If the server or tests crash at startup with `STATUS_ACCESS_VIOLATION`, the `target/` folder holds artifacts from an older toolchain. Run `cargo clean` and rebuild.
