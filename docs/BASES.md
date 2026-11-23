# BoxHead bases and base raids

Every operator has a base: a tower-defense map they build in the hideout's **Base** tab. Raidable operators can send three waves of soldiers at another player's base to take cash; the fight is simulated on the server and both sides can watch it afterward. This describes the implemented rules as of November 16, 2026. Every number is a first-pass value that no player has tested yet.

Base raids only run on servers started with `BOXHEAD_PVP=1`. With it off (the default), everyone can still build a base and run practice raids on it, but nobody can raid or be raided.

## The map

A base is a 17 × 17 grid. The owner picks where the HQ sits: one of the four sides or four corners. The three entrances (A, B and C) are fixed on the far edges for that position. Nothing can be placed on the HQ or on an entrance.

Soldiers walk one square at a time, never diagonally, always along a shortest open route to a square touching the HQ. Walls, gun turrets and sniper towers block the way; mines and garrison soldiers don't. A layout can only be saved while **every** entrance still has a walkable route to the HQ, so a base can never be sealed. The editor draws those routes as you build. When a turret or tower is destroyed, its square opens and routes are recalculated.

## What you place

| Piece | Price | Tier 1 / 2 / 3 / 4 limit | What it does |
| --- | ---: | --- | --- |
| Wall | $25 | 32 / 44 / 56 / 68 | Blocks movement. Indestructible. |
| Gun turret | $450 | 2 / 3 / 4 / 5 | 300 health, reach 3.5 squares, about 18 damage a second. Blocks until destroyed. |
| Sniper tower | $800 | 0 / 1 / 2 / 3 | 200 health, reach 6 squares, 45 damage every 2.5 seconds. Blocks until destroyed. |
| Mine | $140 | 2 / 4 / 6 / 8 | Hidden. 130 damage to every soldier within 1.5 squares of the first one to step on it. One use per raid. |
| Garrison soldier | Soldier's price | 2 / 3 / 4 / 5 in total | Any soldier type, posted on a square. Stands still, fights with 50% more health. |

Limits follow the operator's Homefront tier. The HQ has `1,500 + 500 × tier` health and no weapon. Guns shoot the soldier in reach that is closest to the HQ, and have no line-of-sight rule: walls block movement, not bullets.

## Soldiers and waves

| Soldier | Price | Supply | Health | Speed | Reach | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Rifleman | $60 | 1 | 120 | 1.6 | 3 | About 17 damage a second. |
| Scout | $45 | 1 | 70 | 2.8 | 2 | Weak, fast, clears fog two squares out instead of one. |
| Heavy | $150 | 2 | 420 | 1.2 | 1.6 | Leads the wave and soaks up fire. |
| Grenadier | $170 | 2 | 110 | 1.4 | 2.8 | 2.5× damage to turrets, towers and the HQ. |

An attack is three waves. Each wave holds `3 + 3 × tier` supply (6, 9, 12 or 15) and sets out 8 seconds after the one before, soldiers stepping through the entrance half a second apart with heavies first. Soldiers shoot on the move: the nearest gun or garrison soldier in reach, or the HQ when none is. A raid ends when the HQ is destroyed, the last soldier dies, or after 150 seconds.

## Buying

There is no separate shop. **Save** buys whatever the layout and the three waves need that the operator doesn't own yet, in one payment, or refuses if cash is short. Pieces taken off the map and soldiers taken out of a wave stay owned, so putting them back is free. Garrison soldiers and wave soldiers come from the same owned pool.

## Raiding

1. **Scout.** The server offers another account's Raidable operator that has at least $500, no shield, and (when possible) a Homefront within one tier. The attacker sees its name, tier, HQ position, entrances and the most the raid could take. Scouting again offers someone else when there is anyone else.
2. **Pick an entrance** for each wave. All three may use the same one.
3. **Launch.** The fight is settled immediately on the server; closing the browser changes nothing.

| Result | Effect |
| --- | --- |
| Loot pool | 20% of the defender's cash, at most $15,000 |
| HQ destroyed | Attacker takes the whole pool |
| HQ damaged | Attacker takes half the pool × the share of HQ health removed |
| Attacker's soldiers | The dead are gone from the roster and their wave. Survivors, and soldiers still waiting to set out when the HQ fell, come home |
| Defender's base | Nothing is lost but the cash: every piece and garrison soldier is back for the next raid |
| Shields | The defender can't be raided for 8 hours. Launching a raid ends the attacker's own shield |

Only cash moves. Stash items, equipped gear, Homefront and Legacy are never at risk. Safe operators can't raid and are never offered as targets.

## Fog of war

The attacker starts knowing only the HQ and the entrances. A square is revealed when a soldier comes within one square of it (two for scouts) and stays revealed for the rest of that raid; nothing carries over to the next raid. Mines stay hidden until they go off, even on a revealed square. A gun that was never revealed still shoots: the attacker sees the hits but not where they came from.

The fog is enforced on the server. The attacker's replay contains only what was revealed, so the rest of the base can't be read from network traffic.

## Watching

- **Practice raid.** Runs your waves against your own base, using the layout and waves on screen even if they aren't saved or paid for. Nothing is bought, lost or logged. The whole base is visible, with an "Attacker's view" switch to see the fog an attacker would have.
- **Raid log.** Each operator keeps its last 30 raids made and last 30 raids received. The attacker replays through their fog; the defender replays with the whole base visible. Raids fought under an older version of the simulation stay in the log but can't be replayed.

The simulation uses no random numbers, so a replay is the same raid run again from the stored base and plan.

## Known gaps

- Balance is untested by players. In the simulation's own test, a full base at any tier costs a massed mixed army over half its soldiers, and a scout rush fails; a clever maze has not been measured.
- Raids are profitable only against defenders holding real cash. A full tier 1 army costs about $1,100 and a $500 defender yields at most $100.
- Two accounts can pass cash to each other through raids, limited to 20% per raid and one raid per 8 hours per defender.
- There is no notification when your base is raided; the Log tab shows it next time you look.
- The map editor needs a pointer; it can't be driven from the keyboard.

Rules: [siege.rs](../backend/src/siege.rs). Storage and settlement: [siege_store.rs](../backend/src/db/siege_store.rs). API: [base_api.rs](../backend/src/base_api.rs). Screen: [base.ts](../frontend/src/base.ts).
