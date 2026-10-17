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
