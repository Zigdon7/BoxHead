# BoxHead development roadmap

BoxHead has an implemented co-op extraction loop, four-map gear ladder and account progression. The next priority is to prove that players understand the loop, can recover from losses and want to attempt another raid. Expand objectives and social play after that baseline is reliable; treat PvP and base raiding as separate later milestones.

This roadmap is sequenced as of November 15, 2026 against `3.0.0-playtest.1`. **Implemented** means present in code, not validated with a public player population. **Next** is proposed near-term work; **Later** depends on earlier exit criteria; **Explore** needs a design decision before implementation. These are development priorities, not release dates or completed features.

## Current baseline

| Area | Implemented | Still to establish |
| --- | --- | --- |
| User experience | Account recovery, operator selection, hideout, deployment, HUD, pack, map, results and field guide | First-session comprehension, accessibility and reliable recovery messaging |
| Progression | Four gear gates, trader, insurance, Homefront, Operations, optional retirement and Legacy | Sustainable pacing, economy balance and meaningful late-game choices |
| Gameplay | Guns, melee, dash, deployables, nests, bounded pursuits, loot, uplinks, revives and extraction | Fairness in real sessions, route diversity and target-host performance |
| Social | Account/operator friendship tiers, independent operator IDs, menu and raid presence, shared raids and crossplay pools | Consent controls, invitations, party readiness and coordination |
| Operations | Release checks, end-to-end tests, dashboard, Docker hosting and backup tooling | Public-host capacity, recovery drills and public-launch readiness |

The detailed current behavior is in [USER_EXPERIENCE.md](USER_EXPERIENCE.md), [PROGRESSION.md](PROGRESSION.md) and [GAMEPLAY.md](GAMEPLAY.md).

## Approved mechanics review — batches 1–3

Implemented: wall checks for melee and revives; bounded local defense during enemy returns; permanent hunter reward classification; activity-based XP and extraction bonuses; per-deployment crate claims and reserved crate drops; contribution-based bounty/assist credit; origin-aware decryption; protected items; confirmed overflow selection; targeted Armory requisitions; investment-aware retirement; automatic Workshop banking with a 48-hour cap; and paid Legacy respecs. Regression, migration and API checks cover these changes. Balance values remain playtest hypotheses, not measured retention improvements.

Batch 4 remains future work: variable objectives, nest suppression, distinct enemy roles, optional reward bosses and encounter pacing. Party invitations, reconnect protection, insurance repricing and seasonal timing changes also remain separate proposals.

## Milestone 1 — Reliable and understandable playtest

**Next.** Make the existing loop trustworthy before adding another progression system.

| Track | Work | Completion criteria |
| --- | --- | --- |
| User experience | Explain equipped pack versus contents, insurance, valuables needed for upgrades, map locks and connection losses; add contextual first-raid guidance | A fresh tester creates an operator, prepares a kit and identifies an extraction without coaching; can explain a loss afterward |
| Progression | Record map entry, outcome, gear score, cash changes, first unlock and upgrade events; establish a baseline before changing prices | A cohort report can distinguish a gear bottleneck, cash bottleneck and misunderstanding; metrics have explicit denominators |
| Gameplay | Validate walls, doorways, pursuit expiry, hunter expiry, revive and extraction under solo and co-op conditions | No reproducible wall hits, endless hunts or missing settlements in the regression scenarios |
| Reliability | Exercise restart recovery, multi-tab presence, operator switching and account/operator privacy; test representative raids on the intended host | Release checks pass, persistence recovery is demonstrated, and measured load supports the planned invite count |

Use [PLAYTEST.md](PLAYTEST.md) for execution. Start with small invited sessions and record the build and cohort. Collect a baseline before selecting numerical success targets; passing automated tests alone does not establish usability or balance.

## Milestone 2 — Clear goals and a sustainable economy

**Later; depends on Milestone 1 measurements.** Give players an understandable next step after both a win and a loss.

| Track | Work | Completion criteria |
| --- | --- | --- |
| User experience | Show the loadout contribution to the next gear gate; validate the implemented protection controls, requisitions and overflow selection; improve post-raid guidance | Players identify an actionable upgrade and avoid accidental sales of reserved equipment or valuables |
| Progression | Tune loot bands, fees, premiums, facility prices and Workshop income as a connected economy; evaluate deterministic goals if random drops stall progress | Observed recovery remains viable, each map gate is reachable, and costs create choices without repeated empty recovery runs |
| Gameplay | Prototype a small optional objective set using existing raids, such as retrieving a marked cache or completing an uplink task | Objectives change routes and risk decisions; rewards settle once and cannot be duplicated by disconnecting |

Before shipping objectives, decide whether they are per operator, per account or shared within a raid, and what happens on failure. Do not assume that Operations XP already represents a mission or quest system.

## Milestone 3 — Stronger co-op and encounter variety

**Later; depends on stable settlement and economy rules.** Make cooperating more useful and repeat raids less predictable.

| Track | Work | Completion criteria |
| --- | --- | --- |
| User experience | Party invitations, common-pool checks, ready state, map pings and clearer teammate/revive cues; friend request and removal controls | A new group can assemble and enter the same raid without external instructions; operator-only relationships keep their identity boundary |
| Progression | Balance solo and squad rewards; evaluate optional shared objectives without forcing group-only progression | Solo players retain a viable route through all four maps and rewards are not multiplied accidentally |
| Gameplay | Prototype distinct points of interest, encounter variants and extraction pressure; add enemy types only when they introduce a readable counterplay choice | Players can describe different route strategies; new threats have recognizable cues and a tested response |
| Reliability | Design a bounded reconnect grace period with explicit loadout locks, timeout and settlement behavior | Rejoining cannot duplicate loot, occupy multiple raid bodies or avoid a valid loss |

Reconnect protection is proposed here. The current disconnect rule remains abandonment until that feature is implemented and verified.

## Milestone 4 — Complete the PvE endgame and public release experience

**Later; depends on repeated cohort results from the earlier milestones.** Make progression satisfying beyond the first unlocks and support a broader audience.

| Track | Work | Completion criteria |
| --- | --- | --- |
| User experience | Full keyboard navigation of menus, focus visibility, readable scaling, non-color-only cues, motion/audio options and complete device controls for any advertised platforms | Representative accessibility and input-device checks cover the full preparation–raid–results loop |
| Progression | Review rank caps, the implemented investment valuation and perk respecs, and veteran advantages; add long-term goals only where observed behavior supports them | Keeping an operator and retiring one are both understandable choices; previewed rewards match settlement at season boundaries |
| Gameplay | Add tested late-map objectives and loadout variety; assess whether new maps offer more than higher multipliers | Endgame tasks change decisions, and performance remains within the measured host budget |
| Operations | Publish the data-handling information, establish moderation and abuse response, rehearse restore procedures and measure capacity | Public-release checklist is completed on the actual deployment and support responsibilities are assigned |

Complete touch controls and controller support are separate deliverables, not consequences of making menus responsive. Keep the supported-platform statement aligned with what has been tested.

## Milestone 5 — Optional PvP and Homefront raiding

**Explore; depends on reliable PvE, social consent and economy protections.** Raidable operators and tier 4 costs are foundations, not playable PvP.

Before implementation, resolve the following rules in a separate design proposal:

- Matchmaking and fair combat: gear/Legacy disparities, team size, damage rules, spawn safety and anti-cheat validation.
- Risk consent: who opts into PvP, what can be stolen, how Safe operators remain isolated, and whether account-wide rewards cross modes.
- Base attacks: online/offline availability, defense limits, attack windows, protected resources and recovery after loss.
- Rewards and abuse: win trading, repeated victim farming, alternate-account transfers and disconnect outcomes.
- Player communication: an explicit preview of exposed items and consequences before entering the mode.

Implement and validate a small opt-in PvP raid mode before attempting persistent base raids. Base raiding is a further gate, not automatically bundled with PvP. Neither feature should be advertised as playable solely because `BOXHEAD_PVP=1` permits Raidable creation.

## Measurement and delivery rules

| Signal | Definition or collection method | Decision it informs |
| --- | --- | --- |
| First-session funnel | Count sign-in, confirmation, operator creation, deployment and first settlement events by cohort | Where onboarding needs attention |
| First extraction | Attempts and active play time until the first extraction | Whether the opening loop is understandable and survivable |
| Gate progression | Raids and active play time to first qualifying kit and first deployment on each map | Loot and fee tuning |
| Loss recovery | Attempts and cash spent to regain a viable kit after a loss | Loaner, trader and insurance tuning |
| Economy | Cash earned/spent by source, kit replacement value and unused item stock | Whether sinks and rewards remain meaningful |
| Fairness | Reported deaths grouped by map, threat, solo/squad and relevant replay/log context | Combat, navigation and cue changes |
| Social reliability | Successful group deployments, presence transitions and identity-boundary regressions | Party and privacy readiness |
| Performance | Tick-time distribution against the 16.7 ms simulation budget, bandwidth and failures at representative concurrency | Host capacity and optimization |

Current database aggregates and the dashboard provide only part of this picture. Historical funnels, time to unlock and loss-recovery sequences need instrumentation; until then, use observed playtests and clearly labeled manual records. Assign a responsible owner and numerical targets when a milestone is scheduled, using the baseline rather than invented benchmarks.

For each delivered change, update the relevant overview, player guide and smoke checklist; run the release check; record the tested build and remaining gaps. Move work to **Implemented** only after the behavior exists and its completion criteria have been checked. Do not quietly turn roadmap proposals into claims about the current game.
