# BoxHead bases and base raids

Every operator has a base: a tower-defense map they build in the hideout's **Base** tab. Raidable operators can send three waves of soldiers at another player's base to take cash; the fight is simulated deterministically on the server and both sides can watch it afterward. This describes the implemented rules as of November 28, 2026.

Base raids only run on servers started with `BOXHEAD_PVP=1`. With it off (the default), everyone can still build a base and run free practice raids on it, but nobody can raid or be raided.

## The map

A base is a 17 × 17 grid. The owner picks where the HQ sits: one of the four sides or four corners. The three entrances (A, B and C) are fixed on the far edges for that position. Nothing can be placed on the HQ or on an entrance.

Soldiers walk one square at a time, never diagonally, always along a shortest open route to a square touching the HQ. Walls, gun turrets and sniper towers block movement; mines and garrison soldiers don't. A layout can only be saved while **every** entrance still has a walkable route to the HQ, so a base can never be sealed. The editor draws those routes as you build and supports both pointer painting and keyboard grid navigation (arrow keys + Space/Enter + 1–8/0 tool hotkeys). When a turret or tower is destroyed, its square opens and routes are recalculated.

**Walls block line of sight** for both defenders and attackers: turrets, sniper towers and soldiers need an unobstructed sightline across walls to fire.

## What you place

| Piece | Price | Tier 1 / 2 / 3 / 4 limit | What it does |
| --- | ---: | --- | --- |
| Wall | $25 | 32 / 44 / 56 / 68 | Blocks movement and line of sight. Indestructible. |
| Gun turret | $450 | 2 / 3 / 4 / 5 | 300 health, reach 3.5 squares, about 18 damage a second. Blocks until destroyed. |
| Sniper tower | $800 | 0 / 1 / 2 / 3 | 200 health, reach 6 squares, 45 damage every 2.5 seconds down open lanes. Blocks until destroyed. |
| Mine | $140 | 2 / 4 / 6 / 8 | Hidden. 130 damage to every soldier within 1.5 squares of the first non-Scout to step on it. Scouts disarm nearby mines harmlessly. |
| Garrison soldier | Soldier's price | 2 / 3 / 4 / 5 in total | Any soldier type, posted on a square. Stands still, fights with 25% more health. |

Limits follow the operator's Homefront tier. The HQ has `1,500 + 500 × tier` health and no weapon. Guns shoot the visible soldier in reach that is closest to the HQ.

## Soldiers and waves

| Soldier | Price | Supply | Health | Speed | Reach | Role |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Rifleman | $60 | 1 | 120 | 1.6 | 3.0 | All-rounder. Deals **1.5× damage** to garrison soldiers. |
| Scout | $45 | 1 | 70 | 2.8 | 2.0 | Fast, clears fog two squares out (spotting defenses for allies) and **disarms nearby mines**. |
| Heavy | $150 | 2 | 420 | 1.2 | 1.6 | Leads the wave and soaks up turret and sniper fire. |
| Grenadier | $170 | 2 | 110 | 1.4 | 2.8 | **Prioritizes structures** over garrison infantry and deals **2.5× damage** to turrets, towers and the HQ. |

An attack is three waves. Each wave holds `3 + 3 × tier` supply (6, 9, 12 or 15) and sets out 8 seconds after the one before, soldiers stepping through the entrance half a second apart with heavies first. Soldiers shoot on the move at revealed defenses in reach with clear line of sight, or the HQ when none is. A raid ends when the HQ is destroyed, the last soldier dies, or after 150 seconds.

## Buying, selling and refilling

- **Seamless buy on Save.** There is no separate shop: **Save** buys whatever the layout and the three waves need that the operator doesn't own yet, in one payment. Pieces taken off the map and soldiers taken out of a wave stay owned, so rearranging is free. Garrison soldiers and wave soldiers share one owned pool.
- **Sell spares (50%).** Spare owned equipment and reserve soldiers (not placed on the saved map or assigned to saved waves) can be sold back for 50% of their purchase price.
- **1-click Refill.** After a raid, lost troops are deducted from waves, and a **Refill lost troops** button lets you restore your pre-raid wave template in one click.
- **Retirement value.** Owned base structures (`Wall`, `Turret`, `Sniper`, `Mine`) count toward an operator's seasonal retirement valuation alongside cash, items and Homefront investments.

## Raiding

1. **Scout.** The server offers another account's Raidable operator within **±1 Homefront tier** that has at least `$500` exposed cash (liquid cash plus uncollected Workshop income), no active shield, and has not been raided by your account within the last **24 hours**. The first scout after a raid is free; consecutive re-scouts before raiding cost `$50`, `$150`, then `$400`. You see only name, tier, HQ site, entrances and the defender's loot pool.
2. **Pick an entrance** (A, B or C) for each wave. All three may use the same entrance.
3. **Launch & Watch.** The fight settles immediately on the server; the client holds back the outcome card and cash refresh until the replay ends, skips, or closes so nothing is spoiled.

| Result | Effect |
| --- | --- |
| Exposed pool | 20% of defender's liquid cash + uncollected Workshop cash, capped at $15,000 |
| HQ destroyed | Defender loses 100% of the pool; attacker nets **85%** (15% fencing burn) plus a **System Contract Bonus** of 25% of the defender's placed defense value (up to `$600 × tier`; `$0` for undefended bases) |
| HQ damaged (survives) | Defender loses half the pool × the share of HQ health removed; attacker nets 85% of that loss |
| Defender salvage | Whenever the HQ survives, the defender salvages **30%** of the purchase value of dead attacking soldiers as cash |
| Attacker's soldiers | Dead soldiers are removed from the roster and their wave. Survivors and unspawned soldiers return home |
| Defender's base | Every piece and garrison soldier is restored for free after the raid |
| Shields & pair cooldown | The defender gets an **8-hour shield** (dropping your own shield when you raid does **not** clear the **24-hour per-account-pair cooldown** between the same two accounts) |

Only cash (including uncollected Workshop cash) is at risk. Stash items, equipped gear, Homefront and Legacy are never at risk. Safe operators can't raid or be raided, and can opt into **Raidable** permanently (one-way) from the Operators tab when `BOXHEAD_PVP=1`, unlocking Homefront tier 4, base raids and a **+15% Workshop production rate**.

## Fog of war

The attacker starts knowing only the HQ and the entrances. A square is revealed when a soldier comes within one square of it (two for Scouts) and stays revealed for the rest of that raid. **Attacking soldiers can only fire at revealed defenses**, so Scouts provide real tactical value by spotting turrets early and disarming mines ahead of the column. Mines stay hidden until detonated or disarmed. Unrevealed turrets with clear line of sight still fire: the attacker sees hits from an unknown source.

Fog is enforced on the server: the attacker's replay omits every unrevealed wall, defense and untouched mine from the JSON payload.

## Watching and notifications

- **Practice raid.** Runs your waves (or auto-loaded sample waves) against your own base, using unsaved, unpaid drafts on screen, plus a 1-click **Starter blueprint** for quick testing. Nothing is bought, lost or logged. Toggle **Attacker's view** to inspect your base through fog.
- **Raid log & unread badge.** Each operator keeps its last 30 attacks and 30 defenses. Unread incoming raids display a badge on both the Hideout **Base** tab and the **Log** tab until opened.

The simulation uses no random numbers, so a replay reproduces the exact battle from the stored snapshot and plan.

Rules: [siege.rs](../backend/src/siege.rs). Storage and settlement: [siege_store.rs](../backend/src/db/siege_store.rs). API: [base_api.rs](../backend/src/base_api.rs). Screen: [base.ts](../frontend/src/base.ts).
