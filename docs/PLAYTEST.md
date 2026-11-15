# Running a playtest

This is the runbook for putting BoxHead in front of invited testers: what to check before, what to tell them, what to watch while they play and what to collect afterwards. Getting the server online is covered in [HOSTING.md](HOSTING.md).

The complete experience and current rules are covered in [USER_EXPERIENCE.md](USER_EXPERIENCE.md), [PROGRESSION.md](PROGRESSION.md) and [GAMEPLAY.md](GAMEPLAY.md). Use [ROADMAP.md](ROADMAP.md) to turn observations into sequenced work; planned features there are not part of the current playtest.

## What is in this build

Version `3.0.0-playtest.1`: the first build of BoxHead as an extraction shooter.

- **In:** four maps gated by gear score; hideout with stash, trader and insurance; sealed loot and uplinks; nests, camping punishment and the Abomination; co-op raids with revives; operators, Homefront, Operations, seasons and Legacy; sign-in with email, Steam and Bluesky (and Google, if the host sets it up); friends; matchmaking pools with opt-in cross-platform play.
- **Not in:** player-versus-player raids and base raiding. `BOXHEAD_PVP` stays unset, so every operator is Safe and Homefront stops at tier 3.
- **First guesses:** every progression and economy number (Homefront and facility prices, Operations XP, Legacy rewards, entry fees, loot bands). Tuning them is the point of the playtest.

## Before the playtest

### 1. Check the build

On the commit you are going to deploy:

```sh
npm run release:check -- --docker
```

It takes a few minutes, longer the first time while everything compiles, and must end with `All … checks passed`. What each step protects against:

| Step | Catches |
|---|---|
| Versions agree | A half-finished version bump: manifests and lockfiles that disagree, which also breaks the Docker build (`--locked`) |
| Settings are documented | A new environment variable nobody told the host about, or one missing from `.env.example` |
| Documentation links resolve | Renamed or deleted docs |
| Generated types match the schema | A client built against stale WebSocket message types |
| Typecheck and unit tests | Rule regressions: loot, maps, raids, stash, progression, accounts, rate limits |
| Release builds with `--locked` | A lockfile that is out of date, or code that only compiles in debug |
| End-to-end tests against the release binaries | The real server and dashboard, optimized, driven over HTTP and WebSocket like a browser does |
| Docker image (`--docker`) | An image that doesn't build, doesn't start, or doesn't serve the website |

Without Docker on the machine, run it without `--docker` and build the image on the host instead.

### 2. Settings that matter for a playtest

Set these in `.env` on the host before starting (see [HOSTING.md](HOSTING.md) for the rest):

| Setting | For a playtest |
|---|---|
| `BASE_URL` | The address testers will type. Email links and Steam sign-in break without it. |
| `BOXHEAD_NOTICE` | Tell testers what they are playing, for example `Playtest build. Progress may be wiped.` |
| `BOXHEAD_FEEDBACK_URL` | Where **Report a bug** leads: a form, a Discord channel invite or an issue tracker. Without it there is no link. |
| `SMTP_HOST` and the other mail settings | Needed for email sign-ups. Without them, tell testers to sign in with Steam or Bluesky, which need no email. |
| `BOXHEAD_PVP` | Leave unset. |

Build with `BOXHEAD_BUILD=$(git rev-parse --short HEAD)` (see [HOSTING.md](HOSTING.md)) so the game shows which build testers are on.

### 3. Smoke-test the deployed server

Ten minutes, on the public address, with two browsers (or one normal and one private window). Tick each one:

- [ ] Before signing in, the sign-in screen shows the notice and, at the bottom, `Build 3.0.0-playtest.1 · <commit>`. **Report a bug** next to it opens your feedback page.
- [ ] `https://<your domain>/healthz` prints `ok`.
- [ ] Sign up with a real email address. The confirmation email arrives, and its link returns you to the home screen with "Email confirmed. You can deploy now."
- [ ] **Play** opens the hideout and asks you to create an operator. It starts with a pistol, a vest, a satchel and $400.
- [ ] **Trader**: buy something, then sell it back in **Stash**.
- [ ] **Deploy** to Outskirts. You spawn at the map edge, enemies appear near nests, and the raid clock counts down.
- [ ] **Monster AI:** on Outskirts, use **M** to see the eight nest territories on the larger 4640 × 4000 map. Approach a nest: monsters patrol locally, then pursue when they see you. Break sight around a building for 2.5 seconds, leave the territory, or kite for 12 seconds: they return home without immediately chasing again. Crawlers and brutes must use doorways.
- [ ] **Hunter limit:** camp until warned and hunted. Survive for 30 seconds: the hunter returns home and the hunted indicator clears.
- [ ] Open a crate, pick up loot, press **I** to see your pack.
- [ ] Stand in a green extraction ring for 6 seconds. The results screen lists what you kept and the cash you banked, and the loot is in your stash.
- [ ] In the second browser, sign up again and join the same raid. You see each other. Let one go down and revive them.
- [ ] **Identity and friends:** the deploy screen shows the selected operator name without an editable callsign. In **Friends**, share IDs and add the second browser as both an account friend and an operator friend. Both appear online in the hideout. Switch the second account to another operator: the account friend shows the new operator, while the original operator friend goes offline without revealing the new character. Close one of two signed-in tabs: the other keeps the account online. Sign out of the last tab: both entries go offline.
- [ ] Die on purpose without insurance: the loadout is gone and the stash is not. Deploy again with nothing equipped: you get the loaner pistol.
- [ ] Rust Yard shows as locked with the gear score it needs.
- [ ] The ops dashboard (on the host, port 3900) shows the server, its version and build, and the raid you are in.
- [ ] Mid-raid, run `docker compose restart game`. Reload the page: you are still signed in, and the operator has its gear, entry fee and insurance premium back.
- [ ] `docker compose exec backup boxhead-backup once` writes a backup.

### 4. Know your limits

- **Upload bandwidth.** Each player in a raid takes about 150 KB/s of the host's upload, and up to 300 KB/s in the heaviest fights. A 20 Mbit/s upload carries roughly 15 players in raids at once. Invite fewer testers than that for the first session.
- **CPU.** About 60 players per core was measured before the maps grew, so treat it as an upper bound. The dashboard shows the real load while people play.
- **Sign-ups from one place.** One address may create 10 accounts at once, then 20 an hour. Testers sitting on the same network (an office, a LAN party) share that limit.
- **Wipes.** Decide now whether progress carries over to the next playtest, and say so in the notice. Take a backup before the session either way.

## What to tell testers

Copy this, fill in the blanks and send it with the invitation.

> **BoxHead playtest**
>
> **Play at:** `https://<your domain>` on a desktop browser with a keyboard and mouse. Chrome, Edge or Firefox.
>
> **Sign in** with Steam or Bluesky, or sign up with an email address and a password (you will get a confirmation link by email and must click it before you can deploy). Then press **Play** and create an operator.
>
> **The game in one line:** take gear into a raid, fill your pack, and stand in a green extraction ring for 6 seconds before your clock runs out. Get out and you keep everything. Die and you lose what you carried in. The full guide is under **Learn to play** on the home screen.
>
> **Controls:** WASD to move, mouse to aim, left click to shoot, Space or right click for the katana, Shift to dash, **I** for your pack, **M** for the map, **G** to drop your last pickup. Esc shows all of them.
>
> **Things we would like you to try**
> 1. Extract from Outskirts a few times and work your way to gear score 20 for Rust Yard.
> 2. Find a sealed item and decrypt it at an uplink (the cyan diamonds on the map).
> 3. Play a raid with someone else, and revive each other.
> 4. Stay in one spot for over a minute and see what happens.
> 5. Upgrade your Homefront and one facility.
>
> **Reporting a problem:** use **Report a bug** at the bottom of the home screen or the sign-in screen, or on the pause menu. Please include the build line next to it (it looks like `Build 3.0.0-playtest.1 · abc1234`), what you were doing, what you expected and what happened instead. A screenshot helps.
>
> **We also want to hear:** when you were confused, when a death felt unfair, when you ran out of things to do, and how long it took you to reach each new map.
>
> **Good to know:** this is a test build. Progress <will / will not> be kept afterwards. We store your sign-in (an email address, or your Steam or Bluesky id), a password hash if you signed up by email, and your game progress. You can delete your account and everything in it from the home screen under **Account & linked sign-ins**.

## While they play

- **Dashboard** (`http://127.0.0.1:3900` on the host). Watch each raid's tick time against the 16.7 ms budget. A raid that overruns steadily is overloaded: note how many players and enemies it had. Per-thread load near 100% means the CPU is the limit; dropped updates mean a client or the network can't keep up.
- **Logs.** `docker compose logs -f game` shows sign-in and email problems. `docker compose logs -f tunnel` (or `caddy`) shows connection problems.
- **A raid in a bad state** can be restarted from the dashboard. It clears and restocks that raid's world; the players in it stay in.
- **Restarting the game server** (`docker compose restart game`) ends every raid in progress. Everyone gets their gear, entry fee and insurance premium back, and has to deploy again. Warn people first.
- **Don't rebuild mid-session.** `docker compose up -d --build` restarts the server too.

## Questions this playtest should answer

Write down what you see for each; they are the open tuning and design questions.

- **Pace of the ladder.** How many raids does it take to reach Rust Yard, Quarantine Zone and Black Site? Does anyone stall at a gate?
- **Economy.** Do entry fees and insurance feel like real decisions? Does anyone go broke, or run out of things to buy?
- **Raid length.** A map can be crossed in well under a minute, and raids last 10 to 13 minutes. Do testers extract early, or use the clock?
- **Camping.** Is the 75-second limit too harsh, too soft, or never noticed? Did anyone meet the Abomination without understanding why?
- **Sealed loot.** Do testers find and use uplinks, and is the noise worth it?
- **Full packs.** Is the automatic swap (gear replaces weaker gear, valuables replace cheaper valuables) understood, or do testers want to choose?
- **Homefront and Operations.** Does anyone upgrade? Do the Homefront and Operators tabs make sense without the guide?
- **Difficulty.** Where do deaths cluster: which map, which enemy, solo or squad?

## After the playtest

### Numbers from the database

These read the live database without stopping the server. Take a backup first if you want a frozen copy.

```sh
# Raids played, and how many ended in an extraction
docker compose exec backup sqlite3 -readonly -header -column /data/boxhead.db \
  "SELECT count(*) AS operators, sum(raids) AS raids, sum(extracts) AS extracted, sum(deaths) AS lost,
          round(100.0 * sum(extracts) / max(sum(raids), 1)) AS extract_pct FROM operators;"

# Each operator: Homefront tier, cash, raids and current gear score
docker compose exec backup sqlite3 -readonly -header -column /data/boxhead.db \
  "SELECT o.name, o.tier, o.cash, o.raids, o.extracts, o.deaths, coalesce(sum(i.power), 0) / 4 AS gear_score
   FROM operators o LEFT JOIN items i ON i.profile = o.profile AND i.slot IS NOT NULL
   GROUP BY o.profile ORDER BY o.raids DESC;"

# Which maps were played (Operations XP earned on each)
docker compose exec backup sqlite3 -readonly -header -column /data/boxhead.db \
  "SELECT map, count(*) AS operators, sum(xp) AS xp FROM operations GROUP BY map ORDER BY xp DESC;"

# How testers signed in, and email sign-ups that never confirmed
docker compose exec backup sqlite3 -readonly -header -column /data/boxhead.db \
  "SELECT provider, count(*) AS accounts FROM linked_accounts GROUP BY provider;"
docker compose exec backup sqlite3 -readonly -header -column /data/boxhead.db \
  "SELECT count(*) AS unconfirmed FROM email_credentials WHERE confirmed = 0;"

# Facilities built
docker compose exec backup sqlite3 -readonly -header -column /data/boxhead.db \
  "SELECT facility, level, count(*) AS operators FROM facilities GROUP BY facility, level ORDER BY facility, level;"
```

Gear score against the gates (20, 40, 65) tells you how far up the ladder each tester got.

### Keep or wipe

Keep a copy of the playtest database either way:

```sh
docker compose exec backup boxhead-backup once
```

To start the next playtest from nothing, delete the database while the server is stopped. **This removes every account and cannot be undone** except by restoring a backup:

```sh
docker compose stop game
docker compose run --rm --no-deps backup sh -c 'rm -f /data/boxhead.db /data/boxhead.db-wal /data/boxhead.db-shm'
docker compose start game
```

Testers will have to sign up again. To keep accounts and progress, do nothing: the database upgrades in place when a new build starts.

## Known gaps

- **No privacy policy or terms.** Fine for invited testers who have been told what is stored (the paragraph above); needed before the public is let in.
- **No load test on the real host yet.** The numbers under "Know your limits" come from a development machine and smaller maps.
- **No PvP.** Raidable operators and Homefront tier 4 are switched off.
- **Tuning is untested by players.** See the questions above.
- **Built for a keyboard and mouse.** On a touch screen there is a move stick, touch-to-aim shooting, a katana button and a weapon-switch button, but no control for deployables, the pack or the full map, and no radar. Touch play was not tested for this build, so ask testers to use a desktop browser.
