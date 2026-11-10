# Hosting BoxHead on your own machine

Everything runs from `compose.yaml`: the game server (which also serves the website), the ops dashboard and a backup job. One image holds all three.

## What you need

- A machine that stays on, with [Docker Engine](https://docs.docker.com/engine/install/) and its compose plugin. Linux is the simplest. Building the image needs about 3 GB of free memory and takes a few minutes the first time.
- A domain name.
- An SMTP provider for email (see [Email](#email)).

## 1. First start

```sh
git clone <this repo> boxhead && cd boxhead
cp .env.example .env
```

Fill in the three required values in `.env`:

| Setting | Value |
|---|---|
| `BASE_URL` | The public address, for example `https://play.example.com`. No trailing slash. |
| `BOXHEAD_OPS_TOKEN` | A random secret: `openssl rand -hex 24` |
| `DASHBOARD_PASSWORD` | A password for the ops dashboard |

Then build and start:

```sh
docker compose up -d --build
curl http://127.0.0.1:3001/healthz     # prints "ok"
docker compose logs -f game            # startup log: public address, email mode, PvP
```

The game now answers on `http://127.0.0.1:3001` on that machine only. To try it from another device on your network, set `GAME_BIND=0.0.0.0` in `.env` and run `docker compose up -d` again.

## 2. Let players in

Browsers need HTTPS, and the server must be reachable from the internet. Pick one.

### Option A: Cloudflare Tunnel (recommended at home)

No ports are opened on your router, and your home IP address stays private. The domain must use Cloudflare for DNS (the free plan is enough).

1. In the Cloudflare dashboard open **Zero Trust → Networks → Tunnels** and create a tunnel of type **Cloudflared**.
2. Copy the tunnel token into `.env` as `TUNNEL_TOKEN`.
3. Add a **public hostname** to the tunnel: your domain (for example `play.example.com`), service type **HTTP**, URL `game:3001`.
4. Start it: `docker compose --profile tunnel up -d --build`

### Option B: Caddy and port forwarding

Caddy fetches and renews the HTTPS certificate by itself. Your home IP address is public with this option.

1. Point the domain's DNS at your home address. If your ISP changes it, use a dynamic DNS updater.
2. Forward ports 80 and 443 (TCP, plus 443 UDP) from the router to this machine.
3. Set `DOMAIN=play.example.com` in `.env`.
4. Start it: `docker compose --profile caddy up -d --build`

Keep using the same `--profile` flag in every later `docker compose` command.

## Email

Email sign-ups must click a confirmation link before they can deploy, and password resets are emailed. Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD` and `MAIL_FROM` in `.env`. Any SMTP provider works (Postmark, Amazon SES, Resend, Mailgun, Brevo). Port 587 uses STARTTLS and 465 uses TLS. Most home connections block port 25, so don't run your own mail server.

Without `SMTP_HOST` the links are only printed in `docker compose logs game`. That is enough for testing, and Steam, Bluesky and Google sign-ins never need a confirmation email.

## Sign-in providers

- **Steam** works once `BASE_URL` is right. `STEAM_API_KEY` is optional.
- **Bluesky** needs nothing.
- **Google** needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, with `<BASE_URL>/api/auth/google/callback` listed as an authorized redirect URI in the Google Cloud console.

## Ops dashboard

Open `http://127.0.0.1:3900` on the host and sign in with any user name and `DASHBOARD_PASSWORD`. It shows per-thread load, each raid's tick health and player counts, and can restart raids. To reach it from your LAN set `DASHBOARD_BIND=0.0.0.0`. Don't publish it to the internet.

## Backups

The `backup` service writes a checked, compressed copy of the database every 6 hours and keeps 14 days (`BACKUP_EVERY_HOURS`, `BACKUP_KEEP_DAYS`).

By default the copies go to a Docker volume **on the same disk as the game**, which does not protect against losing that disk. Set `BACKUP_DIR` to a folder on another disk or a NAS share and make it writable by user id 10001:

```sh
sudo mkdir -p /mnt/nas/boxhead-backups && sudo chown 10001:10001 /mnt/nas/boxhead-backups
```

Take a backup right now, or list them:

```sh
docker compose exec backup boxhead-backup once
docker compose exec backup ls -lh /backups
```

Restore one (this replaces the live database):

```sh
docker compose stop game
docker compose run --rm --no-deps backup sh -c \
  'gunzip -c /backups/boxhead-YYYYMMDD-HHMMSS.db.gz > /data/boxhead.db && rm -f /data/boxhead.db-wal /data/boxhead.db-shm'
docker compose start game
```

## Updating

```sh
git pull
docker compose up -d --build
```

The server restarts in a few seconds. Raids in progress are cancelled: every operator in one gets their gear, entry fee and insurance premium back. The database is upgraded in place on start. Take a backup first if the update is a big one.

Containers restart on their own after a crash or a reboot (`restart: unless-stopped`), as long as Docker itself starts at boot (`sudo systemctl enable docker`).

## How many players

- **CPU:** about 60 players per CPU core was measured on 2026-11-05. The maps have grown since and this has not been measured again, so treat it as an upper bound.
- **Upload bandwidth is usually the limit at home.** Each player in a raid receives about 150 KB/s (1.2 Mbit/s), and up to 300 KB/s in the worst fights. A 20 Mbit/s upload carries roughly 15 players in raids at once; 100 Mbit/s carries about 80.
- `BOXHEAD_SIM_THREADS` sets how many cores simulate raids (default: all of them). `BOXHEAD_MAX_ROOMS` caps raids running at once.

## Before you invite the public

- [ ] `BASE_URL` is the real HTTPS address, and the startup log prints it as "Public address".
- [ ] Sign up with a real email address and receive the confirmation email.
- [ ] `BACKUP_DIR` points at another disk, and one restore has been tried.
- [ ] A privacy policy and terms are linked from the site (not written yet).
- [ ] An uptime check watches `https://<your domain>/healthz` (for example UptimeRobot or Uptime Kuma on another machine).
- [ ] `BOXHEAD_PVP` is unset. PvP is not built; turning it on only lets players create Raidable operators.

## Troubleshooting

| Symptom | Check |
|---|---|
| `Set BASE_URL in .env` when starting | A required value in `.env` is empty. |
| Site loads but raids won't connect | The proxy must pass WebSockets to `/ws`. Cloudflare Tunnel and Caddy do by default. |
| Steam sign-in returns to the wrong address | `BASE_URL` doesn't match the address in the browser. |
| "Too many attempts" for everyone at once | The server isn't seeing real client addresses. Players must come in through the tunnel or Caddy, not a second proxy in front of them. |
| Dashboard shows the server as unreachable | `BOXHEAD_OPS_TOKEN` changed without restarting both: `docker compose up -d`. |
