# BoxHead gameplay overview

BoxHead `3.0.0-playtest.1` is a real-time, top-down PvE extraction shooter. Success means banking loot and bounty, not clearing an endless wave counter. This overview covers the implemented rules as of November 15, 2026; [ROADMAP.md](ROADMAP.md) describes future gameplay work.

## Core decisions

Each raid asks the player to balance five things: loadout value, route safety, combat resources, pack contents and remaining time. A good route can avoid combat; a profitable fight can still be a bad choice when extraction is far away. Sealed loot creates a reason to stay longer, while loss risk creates a reason to leave early.

The server simulates the world at 60 Hz and sends each client nearby state at 30 Hz. Movement prediction smooths local controls, but the server decides damage, pickups, extraction and settlement. Raids persist independently of any single player's timer. Late arrivals can encounter a world where other players have already opened crates or drawn enemies.

## Controls and combat

| Input | Action |
| --- | --- |
| WASD and mouse | Move and aim |
| Left click | Fire the selected weapon |
| Space or right click | Katana cleave |
| Shift or double-tap direction | Dash with brief invulnerability |
| 1 / 2 | Select equipped primary / secondary |
| E / Q / F or 5 / 6 / 7 | Place barrel / barricade / claymore |
| G | Drop the last pack item |
| I / M | Open pack / full map; neither pauses the world |
| P | Pause while alone; another player joining resumes the raid |
| Esc | Controls and leave-raid menu |

Bindings can be changed from Controls. Players have three dash charges, with a 2.5-second recharge interval. Dash movement lasts 0.15 seconds at 3× speed, with a brief additional invulnerability grace period.

| Weapon | Base damage | Shot interval | Main tradeoff |
| --- | ---: | ---: | --- |
| Pistol | 18 | 0.20 s | Infinite ammunition, steady fallback |
| Uzi | 15 | 0.08 s | Sustained fire spends ammunition quickly |
| Shotgun | 80 across five pellets | 0.50 s | Needs close range to land the full spread |
| Rocket launcher | 150 | 1.00 s | Area damage, two shared-ammo rounds per shot |
| Katana | 45 before gear-score scaling | 0.38 s | 120-degree cleave and knockback, but requires close contact |

Gun power, account damage bonuses and critical hits modify damage. Base critical chance is 20% and critical damage is 1.75×. Non-pistol guns share one ammo reserve. Katana kills restore 4% of maximum health; health drops restore 25%. Kills chained within four seconds build combo bounty up to 3×. Every fifth combo kill resupplies the player, and a ten-kill combo triggers Overdrive.

Barrels and claymores provide area damage and chain reactions; barricades delay enemies and damage them on contact. Barrel and mine damage scales with the map's enemy health multiplier. Explosions deal full damage at their center and 40% at their edge. Tactical supplies are finite, so using them for a revive or extraction has a different value from using them to accelerate a routine fight.

## Maps and encounters

| Map | World size in units | Enemy health / damage / speed | Elite chance | Encounter progression |
| --- | --- | --- | ---: | --- |
| Outskirts | 4640 × 4000 | 1× / 1× / 1× | 0% | Walkers, crawlers and occasional devils |
| Rust Yard | 5280 × 4000 | 1.5× / 1.35× / 1.12× | 3% | More devils and the first brutes |
| Quarantine Zone | 5920 × 4000 | 2.1× / 1.8× / 1.3× | 6% | Brutes, vampires and more elites |
| Black Site | 6560 × 4640 | 2.8× / 2.3× / 1.42× | 11% | The strongest mix and highest rewards |

Layouts use fixed seeds with city blocks, doorways, streets and cover. Crates favor interiors and central areas. Extractions occupy corners, with additional long-edge points on higher tiers; insertion points sit near the perimeter. Outskirts has eight nests across seven by six blocks, leaving space to route around encounters. The HUD interprets 32 world units as roughly one meter.

Walkers apply basic contact pressure; crawlers close distance quickly; devils apply faster pursuit; brutes absorb more damage; vampires add late-map pressure. Elites increase threat and drop loot more often. Every enemy currently attacks in melee. The Abomination is a separate anti-camping threat with 1,400 base HP before map scaling and the ability to pass through walls.

### Detection, pursuit and navigation

Nests are indestructible. They activate within 1,500 units of a living player and maintain a local cap of `5 + 2 × map tier` monsters, subject to raid-wide population limits. Ordinary monsters patrol locally and acquire visible players within 480 units. Walls block initial detection and melee attacks.

A monster commits to one target, remembers the last visible position for 2.5 seconds, and pursues for at most 12 seconds. A target outside its 800-unit home territory ends ordinary pursuit. Returning monsters ignore new targets until they are back in the patrol area and the four-second recovery period has elapsed. Crawlers and brutes navigate doorways rather than walking through walls. Distant monsters are culled without loot or credit.

The full map's nest circles describe the 800-unit territory, not the wider activation radius. Entering a circle does not itself guarantee immediate detection, and leaving one nest's territory can still bring the player near another.

### Camping and hunters

Camping considers movement over a rolling 30-second window within a 450-unit radius; small movements on the spot do not clear it. The warning starts at 45 seconds of accumulated camping and hunters arrive at 75. Meaningful travel drains the meter.

The first hunt sends an Abomination; later camping sends packs of three elites. A hunt lasts at most 30 seconds, after which hunters return home. Killing hunters or extracting also resolves the threat. A downed target does not erase the remaining hunt. The camp meter stays empty during an active hunt, and hunter elites pay only base bounty even after returning, limiting bounty farming.

## Loot and decryption

Walking into supply crates opens them for one to three items, sometimes with ammo. Crates restock after four minutes. Ammo caches grant 20 ammo and refill after 45 seconds. Ordinary supply drops last 20 seconds; gear drops last two minutes. Loot becomes persistent only after extraction.

A full pack automatically compares like categories: new gear replaces the lowest-power carried gear only if stronger; valuables and sealed items compete by sale value or estimated opened value. This comparison does not inspect which loadout slot the player needs next. Use the pack's Drop buttons to make deliberate space. Looted equipment cannot be equipped during a raid.

Sealing probability starts at 25% on Outskirts and rises eight percentage points per map tier, with extra probability for rarity and a 90% cap. The visible signal reveals rarity and power, not the final item kind. Each map has `tier + 1` uplinks. Standing inside one decrypts the first sealed item in the pack:

| Signal rarity | Time per item |
| --- | ---: |
| Common | 4 s |
| Uncommon | 6 s |
| Rare | 8 s |
| Epic | 11 s |
| Legendary | 15 s |

Leaving the ring or going down resets progress. The outcome is gear 60% of the time and a valuable otherwise, with a 20% chance to improve one rarity grade, capped at legendary. Decryption alerts monsters within 1,300 units subject to their territory rules, and makes nests within 1,500 units spawn 1.8× faster. A squad can cover the operator decrypting; a solo player must decide whether the expected reward warrants the exposure.

## Co-op, extraction and loss

Players who deploy into the same raid within 30 seconds share an insertion point. This supports meeting up, but is not a persistent party system. Downed players have 25 seconds before bleeding out, shortened to three seconds when nobody else in the raid remains alive. Standing within revive range for three seconds restores a teammate to half maximum health.

Extraction takes six seconds inside a green ring. Leaving the ring resets progress; being downed prevents completion. Enemies do not pause for extraction. Every operator has a separate timer, so one player's extraction does not end the raid for everyone else.

| Outcome | Equipment | Pack contents and bounty | Progression |
| --- | --- | --- | --- |
| Extracted | Kept | Banked; excess stash loot is sold | Extraction Operations XP |
| Death, timeout or abandonment | Lost unless insured | Lost | Loss Operations XP |
| Disconnect before any input | Kept; premium refunded | Staged items restored, no raid earnings | No raid XP; entry fee remains spent |
| Server restart during raid | Kept; fee and premium refunded | Staged items restored, no unbanked earnings | Raid voided without XP |

## Gameplay development priorities

The immediate task is proving the existing loop: readable pursuit, reliable doorways, clear losses, sustainable recovery and worthwhile extraction choices. After that, optional objectives and encounter variety can create reasons to choose different routes. Party tools, pings and clearer revive coordination can strengthen co-op. PvP and base raids require their own rules for fairness, consent, rewards and recovery; the existing operator flag is only preparation.

The detailed sequence and acceptance gates are in [ROADMAP.md](ROADMAP.md). Implemented numbers come from [game.rs](../backend/src/game.rs), [map.rs](../backend/src/map.rs), [navigation.rs](../backend/src/navigation.rs), [gear.rs](../backend/src/gear.rs) and [raid settlement](../backend/src/db.rs).
