# BoxHead progression overview

Progression has three scopes: loot at risk during a raid, persistent investment in one operator, and Legacy shared across an account. This is the implemented `3.0.0-playtest.1` ruleset as of November 15, 2026. All economy values remain playtest tuning values. Proposed changes appear in [ROADMAP.md](ROADMAP.md).

## What persists and where

| Scope | State | When it is lost or reset |
| --- | --- | --- |
| Raid | Pack contents, bounty, combo, timer and combat supplies | Unbanked loot and bounty are lost on death, timeout or abandonment; combat state ends with the raid |
| Operator | Cash, stash, equipped gear, Homefront, facilities and per-map Operations XP | Equipment is exposed when deployed; deletion or retirement removes the operator's remaining state |
| Account | Up to three operators, account friendships, Legacy perks, retirement stash bonus and badges | Survives operator loss or retirement; removed by account deletion |
| Seasonal boost | Bonus bounty and Operations XP from retirement | Applies in the following season; permanent perks and stash rewards remain |

Safe operators are PvE-only and have a Homefront tier cap of 3. That does not cap their map progression: they can reach Black Site. Raidable operator support and tier 4 rules exist behind `BOXHEAD_PVP`, but switching it on does not implement PvP or base raids.

## Gear and map progression

Gear score is `floor((primary + secondary + armor + pack power) / 4)`, with empty slots worth zero. The starter kit's powers are 6, 0, 4 and 4, producing score 3. For example, powers 24, 24, 16 and 16 produce score 20 and unlock Rust Yard; one power 80 gun with three empty slots also yields 20, but leaves major survival weaknesses.

| Map | Required score | Base entry fee | Personal timer | Base loot power | Bounty multiplier |
| --- | ---: | ---: | ---: | --- | ---: |
| Outskirts | 0 | Free | 10 min | 2–16 | 1× |
| Rust Yard | 20 | $150 | 11 min | 14–34 | 1.6× |
| Quarantine Zone | 40 | $600 | 12 min | 32–59 | 2.4× |
| Black Site | 65 | $2,000 | 13 min | 55–88 | 3.4× |

Rarity adds power to the base roll: common +0, uncommon +3, rare +6, epic +10 and legendary +15, with item power capped at 100. Higher-tier maps improve rarity odds as well as base power. Rolls favor the lower end of their band, so reaching a gate takes more than finding one theoretical maximum item.

The base trader sells common gear through power 24, enough to assemble a Rust Yard kit. Armory upgrades extend that stock, but even power 38 in every slot cannot reach Quarantine's score 40 gate. Higher progression therefore needs extracted gear. New equipment goes into the raid pack and can only be equipped after returning to the hideout.

### How power changes the kit

| Item or system | Effect before account perks |
| --- | --- |
| Gun | Base weapon damage × `(1 + power / 50)` |
| Armor | `100 + 2 × power` maximum health |
| Equipped pack | `4 + floor(power / 12)` loot slots; `60 + 2 × power` shared ammo |
| Pack deployables | `1 + floor(power / 35)` barrels and barricades; `floor(power / 45)` claymores |
| Katana | Base damage × `(1 + gear score / 90)` |
| No equipped weapon | Power 0 loaner pistol with a 0.8× damage multiplier |
| No equipped pack | Two loot slots, 40 ammo and one barricade |

## Loot and cash decisions

Extraction banks bounty and carried loot. Gear can be equipped, retained as a replacement kit or sold. Valuables sell for more than equivalent gear and are also consumed by Homefront tier upgrades. Sealed items sell for scrap until decrypted; they can be extracted, staged in the stash and carried into a later raid. Their estimated opened value is not guaranteed cash.

The base stash has 40 unequipped-item slots. Equipped items do not consume that allowance. Extraction overflow is sold automatically, so free space matters when hunting specific upgrades. Stash capacity is `40 + 10 × Storage level + 5 × Packrat rank + retirement stash bonus`. The maximum under the current Safe rules is 105 slots; tier 4 would raise it to 115.

Cash enters through extracted bounty, sales, overflow sales and Workshop collections. It leaves through trader purchases, entry fees, insurance and Homefront upgrades. A lost raid does not bank its bounty. Entry fees are paid upfront even if the attempt fails.

Insurance starts at 35% of the equipped loadout's sale value, rounded up to a whole dollar. Its rate is `max(15%, 35% - 4 percentage points × Office level - 3 percentage points × Broker rank)`. It protects all four equipped slots, including the pack item; it does not protect pack contents, bounty, entry fees or the premium. A pre-input disconnect refunds the premium and restores staged loot, but not the entry fee. Server-restart recovery refunds both charges and restores gear and staged loot without granting raid XP.

## Homefront investment

Each operator starts at tier 1. Higher tiers unlock higher facility levels, with each facility capped by that operator's tier. Raising the tier consumes the cheapest eligible valuables from the stash.

| New tier | Cash | Additional material cost | Availability |
| --- | ---: | --- | --- |
| 2 | $1,500 | 2 uncommon-or-better valuables | Safe and Raidable |
| 3 | $6,000 | 3 rare-or-better valuables | Safe and Raidable |
| 4 | $20,000 | 3 epic-or-better valuables | Raidable only; outside normal playtest configuration |

| Facility | Cost to buy level L | Benefit at level L |
| --- | --- | --- |
| Storage | `$400 × L²` | `10 × L` additional stash slots |
| Armory | `$600 × L²` | Adds trader power 28, 32, 35, then 38 at successive levels |
| Insurance Office | `$500 × L²` | Reduces the premium rate by `4 × L` percentage points |
| Workshop | `$800 × L²` | `$60 × L` per hour, collected manually, capped at 12 hours of production |

Costs are per purchase, not cumulative. For example, Storage levels 1, 2 and 3 cost $400, $1,600 and $3,600, or $5,600 in total. A level 3 Workshop holds at most $2,160. Homefront tier spending does not automatically build facilities.

## Operations ranks

Every settled raid awards XP on that map: `100 + min(kills, 100)` for extraction or `25 + min(kills, 100)` for loss. The next-season boost multiplies this by `1 + 0.10 × boost level`, rounded to the nearest whole XP. A voided raid earns none.

| Rank | Total XP | Fee reduction | Banked bounty bonus |
| --- | ---: | ---: | ---: |
| 0 | 0 | 0% | 0% |
| 1 | 150 | 10% | 4% |
| 2 | 500 | 20% | 8% |
| 3 | 1,200 | 30% | 12% |
| 4 | 2,500 | 40% | 16% |
| 5 | 5,000 | 50% | 20% |

Operations rank never substitutes for gear score. Rank 5 Black Site costs $1,000 per entry instead of $2,000. Settlement uses the pre-raid rank for that raid's bounty bonus; a newly earned rank benefits the following raid. Operations, Scavenger and seasonal bounty bonuses add together when banked.

## Seasons and account Legacy

Seasons are calendar quarters in UTC. In the last 28 days, an account can retire one operator with Homefront tier 3 or higher, once per season. The player-facing action is **Retire**; code and API names use `relocate`. Retirement deletes the operator, cash, items, facilities, Operations and operator friendships. It is optional: season rollover does not automatically wipe operators.

The retirement preview values an operator as cash plus the sale value of all owned items. Money already spent on facilities is not added back to that valuation.

| Operator value | Legacy points earned before the lifetime cap |
| --- | ---: |
| Below $5,000 | 0 |
| $5,000–$19,999 | 1 |
| $20,000–$49,999 | 2 |
| $50,000 or more | 3 |

An account can earn 12 Legacy points in total. Each retirement also adds five stash slots to every operator, up to 20, and a season badge. It grants a boost for the following season: +5% bounty and +10% Operations XP per level. Consecutive seasonal retirements raise that boost to at most level 3. Missing a retirement season removes no permanent rewards; a later nonconsecutive retirement starts a new boost at level 1.

Each perk rank costs one Legacy point and applies to all operators on the account. Every perk has three ranks: Vitality gives +6 maximum health per rank; Firepower +3% weapon damage; Scavenger +5% banked bounty; Packrat +5 stash slots; Broker reduces the insurance rate by three percentage points. Twelve lifetime points cannot buy all fifteen ranks, so the current system requires tradeoffs.

## Player milestones and tuning questions

1. **First extraction:** learn the risk loop and return with usable loot.
2. **Stable recovery kit:** fill all four slots and retain replacements or enough cash to recover.
3. **Rust Yard access:** reach score 20 and afford repeated attempts.
4. **Homefront investment:** choose facilities and retain upgrade valuables while pursuing score 40.
5. **Quarantine to Black Site:** improve the whole loadout, learn harder encounters and maintain fee reserves.
6. **Mature operator:** build tier 3 facilities, pursue map ranks and decide whether to keep or retire the character.
7. **Account growth:** spend Legacy and try another operator with shared bonuses.

These milestones overlap; they are not mandatory quests or promised time budgets. Measure raids to each map, losses before recovery, cash before deployment, gear distribution across all four slots and time spent at blocked gates. Database totals cannot reconstruct historical unlock times or player confusion; the roadmap calls for event instrumentation and observed sessions before setting pacing targets.

Rules: [gear.rs](../backend/src/gear.rs), [progression.rs](../backend/src/progression.rs), and [database settlement and upgrades](../backend/src/db.rs). Player experience: [USER_EXPERIENCE.md](USER_EXPERIENCE.md).
