# Progression & World Map — first iteration

## Player-facing rules

- The world map groups wave checkpoints into sectors of ten connected nodes. Select any unlocked checkpoint from the main menu or game-over screen.
- **Reached** is a statistic. **Cleared** means the squad completed the kill target with at least one survivor. These are not interchangeable.
- Earn a clear by joining before the wave’s first kill and remaining connected through completion. Downed teammates share squad credit; mid-wave joiners qualify starting with the next wave. A total squad wipe grants no clear.
- Clearing the available route checkpoint unlocks its successor. Clearing a higher wave with another squad is recorded, but does not leapfrog unfinished checkpoints.
- A fresh checkpoint attempt uses the normal starting loadout. Existing shop upgrades, weapons and credits remain round-scoped.
- Each checkpoint saves clear count, best **score earned during that wave**, and best personal kills. Scores are not accumulated across replays; multiple tabs for one profile count as one clear.
- Existing checkpoint access is preserved during migration, without marking unverified old waves as cleared.

## Persistence and authority

The backend tracks eligible participants and starting score/kill baselines. On clear it emits per-player results; the server stores them in SQLite and sends an individual `progress` update. Clients cannot award their own clears or unlocks.

`wave_progress` retains `highest_wave` and adds `highest_cleared` and `unlocked_wave`. `level_progress` stores per-wave records keyed by browser profile. `/api/progress` returns the full summary. Join and replay requests are capped against `unlocked_wave`, never a client-supplied record.

The stable browser ID remains in local storage. This iteration does **not** bind guest progress to login accounts or sync it across devices. The map visualizes existing wave checkpoints, not separate handcrafted arenas or bosses.

## Isolated preview build

Keep the stable main build untouched:

```sh
cd frontend
npm run build -- --outDir ../dist-worldmap
cd ..
cargo +stable build --locked --manifest-path backend/Cargo.toml --target-dir backend/target-worldmap
```

Run the preview binary with its own working directory (SQLite save) and set `STATIC_DIR` to the absolute `frontend/dist-worldmap` path and `PORT` to an unused port. Never point the main service at preview assets or preview saves.

## Verification

Backend coverage includes legacy migration, sequential unlocks, replay records, mid-wave joins, downed teammates, total wipes, duplicate profiles, and end-to-end tick → persistence → private progress messages. Existing combat, pause and networking regression tests remain in the suite.

Browser checks cover node state, locked-level inspection, selection → actual starting wave, high-wave joins, cached-client record manipulation, sector browsing, mobile selection, save reload and keyboard dismissal.

## Next design decisions

- Account-linked saves and explicit guest-progress transfer.
- Distinct arena layouts and authored encounter sets per node.
- Optional challenge branches and completion medals, kept separate from baseline route access.
