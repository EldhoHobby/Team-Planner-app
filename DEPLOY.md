# Team Planner — Offline Deployment Guide

How the app is deployed to an **offline Windows host** by carrying prebuilt Docker
images on a USB stick, plus how to **update** it and **back up / restore** the
database. This is the procedure we used; the gotchas we hit are noted inline so
you don't rediscover them.

---

## The setup at a glance

- **Host:** Windows 11 with **Docker Desktop** (installed per-user under
  `C:\Users\SCADA\AppData\Local\Programs\DockerDesktop`). Docker Desktop runs Linux
  containers via its built-in VM.
- **No internet on the host**, so images are built on a dev PC and carried over as a
  file — nothing is pulled from a registry.
- **Run folder on the host:** `C:\TeamPlanner`, containing `docker-compose.offline.yml`,
  `Caddyfile`, `.env`, and (temporarily) the image bundle.
- **Published port:** `8443` on the host → `443` in the container (host port 80/443
  were taken by Windows' IIS/HTTP.sys, so we moved the published port to 8443).
- **URL:** `https://<host-IP>:8443` on the LAN, `https://planner.localhost:8443` on the
  host itself. TLS is a self-signed "internal" cert, so browsers show a warning you
  click through.
- **Data** lives in Docker named volumes (`teamplanner_db_data`, `teamplanner_uploads`),
  not in `C:\TeamPlanner`.
- **Email → task ingest needs outbound internet.** The app can poll a Gmail inbox
  (IMAP) and turn "@username" emails into dashboard tasks, but that requires the
  host to reach `imap.gmail.com:993`. On this offline host leave
  `EMAIL_INGEST_ENABLED=false` (the default) — everything else works without it.
  If the host ever gets outbound access, set `EMAIL_INGEST_ENABLED=true`,
  `IMAP_USER`, `IMAP_PASSWORD` (a Google App Password) in `.env` and recreate the
  app container.

---

## Part A — Build the images (dev PC, has internet)

Run in PowerShell from the project folder:

```powershell
cd "C:\Users\eldho\Claude\Projects\Team Planner app"

# Build the two app images from the Dockerfile
docker build --target runner   -t team-planner-app:latest .
docker build --target migrator -t team-planner-app-migrator:latest .

# Make sure the base images are present locally
docker pull caddy:2-alpine
docker pull postgres:16-alpine
```

Bundle **all four** images into one file (the host can't pull Caddy/Postgres either,
so they must travel too):

```powershell
docker save -o team-planner-bundle.tar `
  team-planner-app:latest `
  team-planner-app-migrator:latest `
  caddy:2-alpine `
  postgres:16-alpine
```

> If the host's `docker load` ever complains about platform/manifest, rebuild the two
> app images with `--provenance=false` (e.g. `docker build --provenance=false --target runner -t team-planner-app:latest .`) and re-save.

Copy these to a USB stick:

- `team-planner-bundle.tar`
- `docker-compose.offline.yml`
- `Caddyfile`
- the `timesheet-template/` folder (contains `Time_Sheet_Template.xlsm`) — the compose
  bind-mounts `./timesheet-template` so the timesheet generator can read it on the host.
  You can update this .xlsm on the host anytime without rebuilding the image.

Do **not** copy `.env` — create it fresh on the host (secrets shouldn't ride on the USB).

---

## Part B — Set up on the host (offline)

1. **Make sure Docker Desktop is running.** It starts in the logged-in user's session —
   press the Windows key, type "Docker Desktop", open it, wait for **"Engine running."**
   Confirm with `docker version` (you want a **Server** section, no pipe error).

2. **Put the three files in `C:\TeamPlanner`** and load the images:

   ```powershell
   cd C:\TeamPlanner
   docker load -i team-planner-bundle.tar
   docker images   # expect team-planner-app, team-planner-app-migrator, caddy, postgres
   ```

3. **Create `.env`** in `C:\TeamPlanner` (generates strong secrets automatically):

   ```powershell
   $dbpw   = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 24 | ForEach-Object {[char]$_})
   $secret = [Convert]::ToBase64String((1..32 | ForEach-Object {Get-Random -Maximum 256}))
   @"
   DB_PASSWORD=$dbpw
   SESSION_SECRET=$secret
   APP_URL=https://planner.localhost:8443
   HTTPS_PORT=8443
   MAX_UPLOAD_MB=10
   BACKUP_KEEP_DAYS=14
   "@ | Set-Content -Path .\.env -Encoding ascii
   ```

   > `HTTPS_PORT` is the published host port (default 8443 — Windows often
   > reserves 443 for IIS/HTTP.sys). Email ingest and the AI summarizer need
   > internet, so leave them unset on this host — they're off by default.

   > Keep this `.env` safe — it holds the DB password and session secret. If you ever
   > recreate it with a different `DB_PASSWORD`, the existing database volume won't match
   > and the app won't connect.

4. **Set the Caddyfile** for your host's IP. Find it with `ipconfig` (ours was
   `10.210.4.65`). The key bits: `default_sni` (so browsing by raw IP works — browsers
   don't send a server name for IPs) and `tls internal` (self-signed, no internet needed):

   ```
   {
     default_sni planner.localhost
   }

   planner.localhost, 10.210.4.65 {
     encode gzip
     reverse_proxy app:3000
     tls internal
   }
   ```

   > **Editing the Caddyfile gotcha:** while the proxy container is running it holds the
   > file open ("user-mapped section" error on save). Run
   > `docker compose -f docker-compose.offline.yml stop proxy` first, edit, then
   > `up -d`. Also close Notepad++ if open — it memory-maps files and locks them too.

5. **Start the stack:**

   ```powershell
   docker compose -f docker-compose.offline.yml up -d
   docker compose -f docker-compose.offline.yml ps
   ```

   You want `app`, `proxy`, `db`, `backup` **running** (db "healthy") and `migrate`
   **exited (0)** — `migrate` is a one-shot that applies the versioned migrations
   and stops; on a fresh database its log shows `database state = fresh` then
   applies `0_init`. The `backup` sidecar dumps the database to
   `C:\TeamPlanner\backups` at startup and every 24 h (create the folder first:
   `mkdir backups`).

   > **Starting fresh on a host that already ran the app:** wipe the old data
   > volumes FIRST (this permanently deletes the previous database + uploads):
   > `docker compose -f docker-compose.offline.yml down -v`, then `up -d`.

6. **Open the firewall** for the published port (Administrator PowerShell):

   ```powershell
   New-NetFirewallRule -DisplayName "TeamPlanner HTTPS 8443" -Direction Inbound -Protocol TCP -LocalPort 8443 -Action Allow -Profile Any
   ```

   Also make sure the active network is **Private**, not Public (`Get-NetConnectionProfile`).

7. **Access it.** On the host: `https://planner.localhost:8443`. From other devices on the
   same LAN: `https://<host-IP>:8443`. Accept the certificate warning (Advanced → Proceed).
   First visit is the setup wizard to create your owner account.

---

## Keeping it running 24/7

- Docker Desktop runs in the **SCADA** user's session. The machine must stay **logged in
  as SCADA** — a lock screen is fine, but a full sign-out stops Docker and the app.
- In Docker Desktop → **Settings → General**, enable **"Start Docker Desktop when you sign
  in."** Containers use `restart: unless-stopped`, so they return automatically once the
  engine is up.
- The host IP (`10.210.4.65`) is likely DHCP. Ask for a **static IP / DHCP reservation**,
  otherwise it can change and you'll have to update the `Caddyfile` IP again.

---

## Updating the app later (offline)

On the dev PC, rebuild and re-bundle (you usually only need the two app images; Caddy and
Postgres rarely change):

```powershell
docker build --target runner   -t team-planner-app:latest .
docker build --target migrator -t team-planner-app-migrator:latest .
docker save -o team-planner-app-update.tar team-planner-app:latest team-planner-app-migrator:latest
```

Carry `team-planner-app-update.tar` to the host, then:

```powershell
cd C:\TeamPlanner
docker load -i team-planner-app-update.tar
docker compose -f docker-compose.offline.yml up -d
```

The `migrate` container syncs any schema changes and the `app` restarts on the new image
(a few seconds of downtime; the data volumes are untouched).

> **Back up the database before every update** (see below).

---

## Database — archive (backup) and restore

The database lives in the `teamplanner_db_data` Docker volume. Don't copy that volume's
files directly; use Postgres' own tools, which produce a clean, portable archive.

### Archive (back up)

Plain SQL dump (human-readable, easy):

```powershell
cd C:\TeamPlanner
mkdir backups -ErrorAction SilentlyContinue
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
docker compose -f docker-compose.offline.yml exec -T db pg_dump -U planner planner > "backups\planner-$stamp.sql"
```

Compressed/custom format (smaller, and restores more cleanly — recommended for archives):

```powershell
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
docker compose -f docker-compose.offline.yml exec -T db pg_dump -U planner -Fc planner > "backups\planner-$stamp.dump"
```

Each file is a complete snapshot of the database at that moment. Store copies off the
machine (USB, network share). Run one before any app update.

### Restore

Restoring replaces the current data, so do it deliberately. Stop the app so nothing is
writing, recreate an empty database, then load the archive.

**From a `.sql` file:**

```powershell
cd C:\TeamPlanner
docker compose -f docker-compose.offline.yml stop app migrate

# Drop and recreate an empty database
docker compose -f docker-compose.offline.yml exec -T db psql -U planner -d postgres -c "DROP DATABASE IF EXISTS planner WITH (FORCE);"
docker compose -f docker-compose.offline.yml exec -T db psql -U planner -d postgres -c "CREATE DATABASE planner OWNER planner;"

# Load the dump
Get-Content "backups\planner-YYYYMMDD-HHMMSS.sql" | docker compose -f docker-compose.offline.yml exec -T db psql -U planner -d planner

docker compose -f docker-compose.offline.yml up -d
```

**From a `.dump` (custom format) file** — `pg_restore --clean` handles the wipe for you:

```powershell
cd C:\TeamPlanner
docker compose -f docker-compose.offline.yml stop app migrate
Get-Content "backups\planner-YYYYMMDD-HHMMSS.dump" -Raw -Encoding Byte | `
  docker compose -f docker-compose.offline.yml exec -T db pg_restore -U planner -d planner --clean --if-exists
docker compose -f docker-compose.offline.yml up -d
```

> Restore onto the **same or newer** Postgres major version (we use 16). The named
> volume survives `docker compose down`; it's only deleted by `docker compose down -v`
> or removing the volume explicitly — so avoid `-v` unless you intend to wipe.

### Optional: scheduled daily backup (legacy — usually unnecessary now)

> The stack now includes a `backup` sidecar that dumps to `C:\TeamPlanner\backups`
> automatically every 24 h and prunes old dumps. The scheduled task below is only
> useful if you want a second, independent schedule.

Save this as `C:\TeamPlanner\backup-db.ps1`:

```powershell
$ErrorActionPreference = "Stop"
Set-Location C:\TeamPlanner
New-Item -ItemType Directory -Force -Path .\backups | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
docker compose -f docker-compose.offline.yml exec -T db pg_dump -U planner -Fc planner > "backups\planner-$stamp.dump"
# Keep only the 14 most recent
Get-ChildItem .\backups\planner-*.dump | Sort-Object LastWriteTime -Descending |
  Select-Object -Skip 14 | Remove-Item -Force
```

Then schedule it (run once, as Administrator) to fire every day at 1am:

```powershell
$action  = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\TeamPlanner\backup-db.ps1"
$trigger = New-ScheduledTaskTrigger -Daily -At 1am
Register-ScheduledTask -TaskName "TeamPlanner DB Backup" -Action $action -Trigger $trigger -RunLevel Highest -User "SCADA"
```

---

## Quick reference

| Task | Command (from `C:\TeamPlanner`) |
|------|------|
| Start / apply changes | `docker compose -f docker-compose.offline.yml up -d` |
| Status | `docker compose -f docker-compose.offline.yml ps` |
| Logs (app / proxy) | `docker compose -f docker-compose.offline.yml logs --tail=40 app` |
| Stop everything | `docker compose -f docker-compose.offline.yml stop` |
| Restart proxy only | `docker compose -f docker-compose.offline.yml restart proxy` |
| Back up DB | `docker compose -f docker-compose.offline.yml exec -T db pg_dump -U planner -Fc planner > backups\planner.dump` |
| SQL prompt | `docker compose -f docker-compose.offline.yml exec db psql -U planner -d planner` |

**Troubleshooting we hit, and the fix:**

- `bind: ...forbidden by its access permissions` on port 80 → port was held by Windows
  IIS/HTTP.sys. Solution: publish on `8443` instead (already done), or disable IIS
  (`Stop-Service W3SVC; Set-Service W3SVC -StartupType Disabled`).
- `ERR_SSL_PROTOCOL_ERROR` by IP → Caddyfile missing that IP / no `default_sni`. Add both.
- `user-mapped section open` saving the Caddyfile → stop the proxy (and close Notepad++) first.
- `cannot find ... dockerDesktopLinuxEngine` → Docker Desktop isn't running; start it and wait.
