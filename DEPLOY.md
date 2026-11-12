# Team Planner — Deployment & Operations Guide

How production runs, how to **update** it and **roll back**, how to keep it
**running**, and how to **back up / restore** it safely. The old offline (USB
bundle) procedure is kept at the end for reference.

All commands are **Windows PowerShell 5.1**: chain with `;`, not `&&`. Run them
from `C:\TeamPlanner` unless a step says otherwise.

> **Never write a database dump with PowerShell `>` or pipe one through
> `Get-Content`.** PowerShell 5.1 re-encodes the bytes as text and the
> `pg_dump -Fc` file is silently corrupted — you only find out when a restore
> fails. Every dump command in this guide writes the file **inside a
> container** to the mounted `backups` folder (or uses `docker compose cp`).

---

## 1. Production host (current)

| | |
|---|---|
| **PC** | `10.210.6.233` — Windows + Docker Desktop, **has internet** |
| **In production since** | 2026-11-06 (moved from the old SCADA PC, see section 6) |
| **URL** | `https://10.210.6.233:8443` (self-signed `tls internal` cert — click through the warning) |
| **Folder** | `C:\TeamPlanner` = a **git clone of `main`** (running **v0.0.10**) |
| **Compose file** | `docker-compose.offline.yml` (uses locally built / pulled images, `pull_policy: never`) |
| **Images** | `team-planner-app:latest` + `team-planner-app-migrator:latest`, **built on this PC** from the clone; Caddy / Postgres (and Ollama, only for AI) pulled with `docker pull` |
| **`.env`** | `DB_PASSWORD`, `APP_URL=https://10.210.6.233:8443`, `HTTPS_PORT=8443`, `LAN_IP=10.210.6.233`, `BACKUP_KEEP_DAYS=14` — not in git; keep a copy somewhere safe (it holds the DB password). An old `MAX_UPLOAD_MB` / `SESSION_SECRET` line is ignored |
| **Caddyfile** | v0.0.10 (running now): **edited locally** to `10.210.6.233`. From the next update on, the Caddyfile reads `LAN_IP` from `.env` and is no longer edited — one-time switch in 1.3 |
| **Email ingest / AI** | off (`EMAIL_INGEST_ENABLED` unset); the `ollama` containers only run with `--profile ai` (section 5) |
| **Data** | Docker volumes `teamplanner_db_data` (database) and `teamplanner_uploads` (attachments); dumps in `C:\TeamPlanner\backups` |

The **dev PC** is `10.210.4.130` (`https://planner.localhost`, `docker-compose.yml`).
On dev, the same commands work without `-f docker-compose.offline.yml`.

The **old SCADA PC** (`10.210.4.65`) is **stopped but kept as a fallback**. Do
not start its stack while the new PC is in use — two copies would drift apart
and changes made on one would be lost.

How the data was moved (for the record): an in-container `pg_dump` on SCADA,
copied out with `docker compose cp`, then on the new PC
`pg_restore --clean --if-exists --no-owner /backups/move.dump`.

### 1.1 Updating production

Plan ~10–15 minutes of downtime (the images are built while the site is down,
so nobody writes data after the backup). Do it outside working hours.

**1. Go to the folder and note what is running now** — write the commit hash
down; it is what you roll back to.

```powershell
cd C:\TeamPlanner
```

```powershell
git log -1 --oneline
```

**2. Stop the proxy** (users can no longer reach the app, and Caddy lets go of
the Caddyfile so git can rewrite it):

```powershell
docker compose -f docker-compose.offline.yml stop proxy
```

**3. Back up first — the safe way** (the `backup` container writes the file;
the last line shows its size, which should be well over 10 KB):

```powershell
docker compose -f docker-compose.offline.yml exec -T backup sh -c 'f=/backups/pre-update-$(date +%Y%m%d-%H%M%S).dump; pg_dump -Fc -h db -U planner -f $f planner && ls -l $f'
```

Optional, if people attach files to tasks — copy the uploads out too:

```powershell
docker compose -f docker-compose.offline.yml cp app:/app/uploads "backups\uploads-$(Get-Date -Format yyyyMMdd-HHmmss)"
```

**4. Pull the new code.** The **first** update after v0.0.10 still has the
locally edited Caddyfile — do the one-time switch in 1.3 first (add `LAN_IP`
to `.env`, discard the edit). After that the clone has no local changes:

```powershell
git status --short
```

(expect no output, or only untracked files), then:

```powershell
git pull
```

**If `git pull` prints an error, STOP** — start the proxy again and fix the
cause before continuing (the next steps would otherwise rebuild the OLD
version without any warning):

```powershell
docker compose -f docker-compose.offline.yml start proxy
```

**5. Pull the base images the compose file pins** (needs internet; a no-op when
they are already present). This reads the exact tags from the compose file
(it also pulls the Ollama image, which is only used with `--profile ai` —
harmless; the Node base image for the build is pulled by `docker build`):

```powershell
Select-String -Path .\docker-compose.offline.yml -Pattern '^\s*image:\s*(\S+)' | ForEach-Object { $_.Matches[0].Groups[1].Value } | Where-Object { $_ -notlike 'team-planner-*' } | Sort-Object -Unique | ForEach-Object { docker pull $_ }
```

**6. Rebuild both app images** (the build also runs the unit tests — a failing
test stops the build, and the old images keep working):

```powershell
docker build --target runner -t team-planner-app:latest .
```

```powershell
docker build --target migrator -t team-planner-app-migrator:latest .
```

**7. Start it.** `migrate` applies any new database migrations, then `app`
starts on the new images, and `proxy` once the app's healthcheck passes
(so nobody sees a 502 while it starts):

```powershell
docker compose -f docker-compose.offline.yml up -d
```

(Add `--profile ai` after `-f docker-compose.offline.yml` only if
`EMAIL_AI_ENABLED=true` — section 5.)

**8. Check it.**

```powershell
docker compose -f docker-compose.offline.yml ps
```

You want `app` (healthy), `proxy`, `db` (healthy), `backup` running and
`migrate` **exited (0)** (`ollama` only with the AI profile). If `proxy` is not
up, the app is not healthy yet — wait a minute, or read the `app` log. If
`migrate` exited with an error, read its log and go to 1.2:

```powershell
docker compose -f docker-compose.offline.yml logs --tail=40 migrate
```

```powershell
curl.exe -k https://10.210.6.233:8443/api/health
```

Expect `{"status":"ok","db":"up",...}`. Then open `https://10.210.6.233:8443`
and check the **sidebar footer** shows the new version and git hash, sign in,
and open the Schedule and Dashboard.

#### First update after v0.0.10 (one-time notes)

Production is on v0.0.10; the next release is **v0.1.0** (everything from
v0.0.11 to v0.0.54, merged to `main`). Things to know before that update:

- **Do the one-time Caddyfile switch (1.3) in step 4**, before `git pull`.
- `ollama` / `ollama-init` now only start with `--profile ai`. After the update
  the old `ollama` container from v0.0.10 keeps running until you remove it
  (AI is off on production):

  ```powershell
  docker compose -f docker-compose.offline.yml --profile ai rm -sf ollama ollama-init
  ```

  The `ollama_models` volume is kept; nothing else is affected.
- The app now has a healthcheck and `proxy` waits for it; all services rotate
  their Docker logs (10 MB × 5).
- The build's Node base image is pinned (`node:22.23-alpine`); `docker build`
  pulls it on the first build.

- **Rehearse the migrations on a copy of production first** (below). The jump
  adds eight migrations (change history + task version column, the whole
  service-agreements schema, agreement settings / redesign, data fixes, soft
  delete + job version) on top of the three v0.0.10 already has.
- The compose files now **pin** `caddy:2.11.8-alpine`, `postgres:16.15-alpine`
  and `ollama/ollama:0.40.14`. Step 5 pulls them; without it `up -d` fails
  with "pull access denied / no such image" because of `pull_policy: never`.
  Same Postgres major version (16), so the data volume is unaffected.
- **Keep the old images** (`caddy:2-alpine`, `postgres:16-alpine`,
  `ollama/ollama`) until the new version has run for a while — the v0.0.10
  compose file uses them, so a rollback needs them. Don't `docker image prune -a`.
- The `backup` container now also keeps monthly copies and writes
  `backups\last-backup.txt` (section 2.1).
- **Agreement data exists only on the dev PC.** Updating the code does not
  move it. Bring it over with **Restore agreements only** — it replaces just
  the service-agreement data and leaves production's people, jobs and tasks
  alone:
  1. Upgrade production (1.1) and check it.
  2. On production, Settings → Data → **Download full backup** (a safety copy
     of production as it is now).
  3. On the dev PC, Settings → Data → **Download full backup**.
  4. On production, Settings → Data → **Restore agreements only…** with the
     dev file. The dialog shows production's current agreement counts next to
     the file's; a file with no agreement customers is refused. Dev people that
     don't exist on production keep their names in the agreement history (the
     link to a user is left empty).

  Do it **before** people start entering agreements on production — the
  restore replaces all agreement data there.
- **Full backup download, full restore and Settings → Data → Reset are
  Owner-only** (the file holds every password hash). Other admins can still
  use Restore agreements only and the Agreements reset.

**Rehearsal on the dev PC** (separate compose project `tp-rehearsal`, so dev's
own data is not touched). Check out the exact code you are about to deploy
(`migrate` is built from the working tree). Copy a production dump (e.g. last
night's `planner-…dump`, from the off-PC copy) into the dev repo's `backups`
folder with Explorer or `Copy-Item`, then in the dev repo folder:

```powershell
docker compose -p tp-rehearsal up -d db
```

```powershell
docker compose -p tp-rehearsal exec -T db pg_restore -U planner -d planner --no-owner /backups/<production-file>.dump
```

Build the rehearsal's `migrate` image from the working tree first —
`run` would otherwise reuse an image from an earlier rehearsal and silently
test the OLD migrations:

```powershell
docker compose -p tp-rehearsal build migrate
```

```powershell
docker compose -p tp-rehearsal run --rm migrate
```

The migrate output must end without errors (`All migrations have been
successfully applied` or similar). Then remove the rehearsal — **always with
`-p tp-rehearsal`**; without it these would hit dev's real stack:

```powershell
docker compose -p tp-rehearsal down
```

```powershell
docker volume rm tp-rehearsal_db_data
```

### 1.2 Rolling back

Use this when the update fails (migrate error, app won't start) or the new
version misbehaves. You go back to the code you noted in step 1 **and** the
database from the `pre-update-…dump` — anything entered after the update is
lost, so decide quickly.

**1. Dump the current state first** — while the `backup` container is still
running. If the rollback goes wrong, or you need something entered after the
update, this is the only copy of it:

```powershell
docker compose -f docker-compose.offline.yml exec -T backup sh -c 'f=/backups/before-rollback-$(date +%Y%m%d-%H%M%S).dump; pg_dump -Fc -h db -U planner -f $f planner && ls -l $f'
```

**2. Copy the monthly dumps out of the backups folder.** The v0.0.10
`backup` container deletes every `planner-*.dump` older than 14 days —
including the new `planner-monthly-*.dump` copies, and even in subfolders.
Keep them outside `C:\TeamPlanner\backups` (and outside the git clone):

```powershell
New-Item -ItemType Directory -Force C:\TeamPlanner-local\monthly-dumps
```

```powershell
Copy-Item C:\TeamPlanner\backups\planner-monthly-*.dump C:\TeamPlanner-local\monthly-dumps\
```

**3. Restore the pre-update dump with the side-database procedure in 2.5**
("Clean restore", steps A–E) using `backups\pre-update-YYYYMMDD-HHMMSS.dump`.
It stops `proxy`, `app` and `backup`, loads the dump into a NEW database and
swaps it in only when the load succeeded — the current database is kept as
`planner_old` until you have checked the result. Find the file name with:

```powershell
dir backups\pre-update-*.dump
```

Stop after step E of 2.5 (the swap — don't start the stack yet) and continue
here.

**4. Go back to the previous code** (use the hash you wrote down, or a tag such
as `v0.0.10`; run `git fetch --tags` first if the tag is missing):

```powershell
git checkout <previous-commit-or-tag>
```

**Only when going back to a version from before `LAN_IP`** (v0.0.43 or older,
v0.0.10 included): its Caddyfile names the dev PC's IP and ignores `LAN_IP`, so
put the production Caddyfile kept outside the repo (1.3) over it:

```powershell
Copy-Item C:\TeamPlanner-local\Caddyfile C:\TeamPlanner\Caddyfile -Force
```

**5. Rebuild both images from that code** (same commands as 1.1 step 6):

```powershell
docker build --target runner -t team-planner-app:latest .
```

```powershell
docker build --target migrator -t team-planner-app-migrator:latest .
```

**6. Start and check** — `migrate` finds the old migration history and has
nothing to do:

```powershell
docker compose -f docker-compose.offline.yml up -d
```

```powershell
curl.exe -k https://10.210.6.233:8443/api/health
```

**7. Later, once the app is confirmed working**, drop the swapped-out database
(2.5 step H). Until then it is your way back.

Notes: checking out v0.0.10 also removes the `scripts\` folder from the clone —
that is why the off-PC script lives in `C:\TeamPlanner-local` (2.3). When you go
forward again, copy the monthly dumps from `C:\TeamPlanner-local\monthly-dumps`
back into `C:\TeamPlanner\backups` if any were pruned.

The clone is now on a "detached HEAD". When the fix is ready, go forward again
(if you copied the old Caddyfile in, discard it first with
`git checkout -- Caddyfile`), then `git checkout main` and follow 1.1.

### 1.3 The Caddyfile and `LAN_IP`

The Caddyfile in git no longer names any IP: it serves `planner.localhost` plus
`{$LAN_IP}`, which the compose file passes from `.env`. Production sets
`LAN_IP=10.210.6.233` in `.env`, so the clone has **no local Caddyfile edit** and
`git pull` / `git checkout` run cleanly.

**One-time switch (first update after v0.0.10)** — production's running
Caddyfile is still the hand-edited one. During 1.1, after step 3 (proxy stopped,
backup taken) and before `git pull`:

**a. Keep a copy of the working production Caddyfile outside the repo** (needed
if you ever roll back to v0.0.10 — 1.2 step 4):

```powershell
New-Item -ItemType Directory -Force C:\TeamPlanner-local
```

```powershell
Copy-Item C:\TeamPlanner\Caddyfile C:\TeamPlanner-local\Caddyfile -Force
```

**b. Add `LAN_IP` to `.env`** (the leading line break guards against a last line
without one):

```powershell
Add-Content -Path C:\TeamPlanner\.env -Value "`r`nLAN_IP=10.210.6.233" -Encoding ascii
```

```powershell
Select-String -Path C:\TeamPlanner\.env -Pattern '^LAN_IP='
```

**c. Discard the local Caddyfile edit — only AFTER b** (until the new code is
pulled, the proxy stays stopped, so nothing serves the dev IP):

```powershell
git checkout -- Caddyfile
```

```powershell
git status --short
```

Then continue with `git pull` (1.1 step 4). The new Caddyfile + compose file
pick up `LAN_IP` when the proxy is created in step 7.

**If you still have a local Caddyfile edit** later (e.g. after a rollback to an
old version, or someone edited it), `git pull` refuses with "Your local changes
would be overwritten". Check that `.env` has the right `LAN_IP`, then discard
the edit with `git checkout -- Caddyfile` and pull again.

Notes:

- After changing `LAN_IP` in `.env`, recreate the proxy (a plain `restart`
  keeps the old value):

  ```powershell
  docker compose -f docker-compose.offline.yml up -d proxy
  ```

- After editing the Caddyfile itself (bind mount),
  `docker compose -f docker-compose.offline.yml restart proxy` is enough.
- While the proxy runs it holds the file open, so git (or an editor) can fail
  with a "user-mapped section" error — stop the proxy first (1.1 step 2).
- `LAN_IP` missing or wrong → browsers get `ERR_SSL_PROTOCOL_ERROR` on
  `https://10.210.6.233:8443` (the certificate only covers `127.0.0.1`).

#### Security headers

Every site block imports the `security_headers` snippet in the Caddyfile:

- `Strict-Transport-Security: max-age=31536000` (no `includeSubDomains` /
  `preload`; browsers ignore it for bare IPs and self-signed certificates).
- `X-Content-Type-Options: nosniff`.
- `X-Frame-Options: SAMEORIGIN` — not `DENY`: Agreements → Print / PDF loads
  the print page in an off-screen same-origin iframe (`print-frame.ts`).
- `Referrer-Policy: same-origin`; the `Server` and `X-Powered-By` headers are
  removed.
- `Content-Security-Policy-Report-Only` — **report-only for now**, so it
  cannot break anything: the browser only logs `[Report Only] Refused to …`
  lines in the DevTools console (there is no report endpoint). The policy:
  `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'
  'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:;
  connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri
  'self'; form-action 'self'; object-src 'none'`. `'unsafe-inline'` is needed
  because Next.js injects inline scripts (and the root layout's theme script),
  and React / the error page use inline styles; no nonces are used. Everything
  else the app loads (scripts, styles, the logo, fonts, `fetch` calls, the
  print iframe) is same-origin; Excel / backup downloads are `blob:` links.

  **To make it enforcing:** open the app with DevTools → Console, click through
  sign in, Schedule, Dashboard, Agreements (including Print / PDF), Settings →
  Data (export, backup download, restore preview) and Timesheet → Generate
  Excel. If no `[Report Only]` line appears, rename the header in the Caddyfile
  to `Content-Security-Policy` and run
  `docker compose -f docker-compose.offline.yml restart proxy` (dev:
  `docker compose restart proxy`). To undo, rename it back and restart again.

### 1.4 Keeping it running

Docker Desktop only runs while a user is **signed in**, so a reboot (power cut,
Windows Update) leaves the app down until someone signs in — unless:

- **Docker Desktop starts on sign-in:** Docker Desktop → Settings → General →
  "Start Docker Desktop when you sign in to your computer". All services use
  `restart: unless-stopped`, so they come back once the engine is up.
- **Automatic sign-in (planned):** Microsoft Sysinternals **Autologon** (from
  Microsoft's Sysinternals site) — run it as Administrator, enter the account
  Docker Desktop runs under, click Enable. It stores the password encrypted
  (LSA secret), not in plain text.
- **Lock the screen after auto sign-in**, so the console isn't left open. A
  logon task that locks the workstation a minute after sign-in (run as that
  user):

  ```powershell
  $lockAction = New-ScheduledTaskAction -Execute "rundll32.exe" -Argument "user32.dll,LockWorkStation"
  ```

  ```powershell
  $lockTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  ```

  ```powershell
  $lockTrigger.Delay = "PT1M"
  ```

  ```powershell
  Register-ScheduledTask -TaskName "TeamPlanner lock after sign-in" -Action $lockAction -Trigger $lockTrigger
  ```

  Locking is fine (Docker keeps running); **signing out stops the app**.
- **No sleep / hibernate on AC power:**

  ```powershell
  powercfg /change standby-timeout-ac 0
  ```

  ```powershell
  powercfg /change hibernate-timeout-ac 0
  ```

- **BIOS/UEFI: power on after a power cut** — the setting is called "Restore on
  AC Power Loss", "AC Recovery" or "After Power Failure" depending on the
  vendor; set it to **Power On**.
- **Windows Update:** Settings → Windows Update → Advanced options → **Active
  hours** set manually to cover the working day (e.g. 6:00–22:00), so update
  restarts happen at night. With the items above the app comes back on its own.
- **Static IP / DHCP reservation** for `10.210.6.233` — `LAN_IP` and `APP_URL`
  in `.env` depend on it.
- **Firewall** (Administrator PowerShell; already done at setup):

  ```powershell
  New-NetFirewallRule -DisplayName "TeamPlanner HTTPS 8443" -Direction Inbound -Protocol TCP -LocalPort 8443 -Action Allow -Profile Any
  ```

**Test once:** restart the PC and, without touching it, open
`https://10.210.6.233:8443` from another PC within ~5 minutes.

---

## 2. Backups and restore

### 2.1 What happens automatically

The `backup` container (in both compose files) writes to `C:\TeamPlanner\backups`
once at startup and then every 24 hours (after a failed dump it retries in 1 h):

| File | What | Kept |
|---|---|---|
| `planner-YYYYMMDD-HHMMSS.dump` | daily `pg_dump -Fc` | `BACKUP_KEEP_DAYS` (14) days |
| `planner-monthly-YYYYMM.dump` | copy of the **first** good dump of each month | `BACKUP_KEEP_MONTHLY_DAYS` (400) days |
| `last-backup.txt` | time + file name of the last **successful** dump | overwritten |
| `last-backup-error.txt` | time of the last **failed** dump | deleted on the next success |

Names and times are **UTC**. Dumps are written as `*.part` and renamed when
complete, so a `.dump` file is never half-written. Pruning runs **only after a
successful dump**, and the **newest 3 daily dumps are always kept** — a
`pg_dump` that keeps failing can never delete the last good ones. Other dumps
you put in the folder (`pre-update-…`, `before-rollback-…`, `move.dump`) are
**never pruned** — delete them by hand when no longer needed.

These dumps cover the **database only**. Attachments live in the `uploads`
volume (copy them with the `docker compose cp` line in 1.1 step 3). For a
second, app-level copy, Settings → Data → **Download full backup** gives a
`.json` snapshot of the whole org (Owner only — the file holds every login's
password hash; full restore and Settings → Data → Reset are Owner-only too).

### 2.2 Checking backup health

```powershell
Get-Content C:\TeamPlanner\backups\last-backup.txt
```

```powershell
Test-Path C:\TeamPlanner\backups\last-backup-error.txt
```

```powershell
Get-ChildItem C:\TeamPlanner\backups\*.dump | Sort-Object LastWriteTime | Select-Object -Last 5 Name, Length, LastWriteTime
```

```powershell
docker compose -f docker-compose.offline.yml logs --tail=20 backup
```

Healthy = `last-backup.txt` is less than a day old, no `last-backup-error.txt`,
and the dumps are a similar size from day to day. The off-PC script (2.3) runs
the same checks every day.

### 2.3 Off-PC copies (daily scheduled task)

Dumps that only exist on the production PC die with its disk. The script
`scripts\backup-offsite.ps1` copies every new `*.dump` (plus any `uploads-*`
attachment folders saved next to them) to a network share or USB drive with
robocopy (it never deletes anything at the destination), logs to
`C:\TeamPlanner\backups\backup-offsite.log`, and reports the newest **daily**
dump's name, size and age — it **warns if the newest `planner-YYYYMMDD-…dump`
is older than 26 hours or smaller than 10 KB** (manual `pre-update-…` dumps
don't count, so they can't hide a dead backup container). Exit code: `0` OK,
`1` copy failed, `2` copied but the backups need attention.

**The scheduled task runs a copy kept OUTSIDE the git clone**, in
`C:\TeamPlanner-local\`. Never copy files into `C:\TeamPlanner\scripts\` by
hand: the next `git pull` would abort ("untracked working tree files would be
overwritten"), and a rollback checkout to v0.0.10 removes `scripts\` entirely.

```powershell
New-Item -ItemType Directory -Force C:\TeamPlanner-local
```

Production runs v0.0.10, which doesn't have `scripts\` yet — before the update,
copy `scripts\backup-offsite.ps1` from the repo (dev PC / GitHub) to
`C:\TeamPlanner-local\backup-offsite.ps1` with Explorer. After an update that
changes the script, refresh the copy from the clone:

```powershell
Copy-Item C:\TeamPlanner\scripts\backup-offsite.ps1 C:\TeamPlanner-local\backup-offsite.ps1 -Force
```

Use a **UNC path** (`\\server\share\...`) for a network share — mapped drive
letters don't exist for a task that runs while nobody is signed in. Replace
`\\SERVER\SHARE\TeamPlanner-backups` below with the real destination.

**Run it once by hand first:**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\TeamPlanner-local\backup-offsite.ps1 -Destination "\\SERVER\SHARE\TeamPlanner-backups"
```

**Register it as a daily task** that runs whether anyone is signed in or not
(Administrator PowerShell; the account must be able to write to the share —
you are asked for its password, which Task Scheduler stores):

```powershell
$cred = Get-Credential -Message "Windows account the off-PC backup runs as"
```

```powershell
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\TeamPlanner-local\backup-offsite.ps1" -Destination "\\SERVER\SHARE\TeamPlanner-backups"'
```

```powershell
$trigger = New-ScheduledTaskTrigger -Daily -At 3am
```

```powershell
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
```

```powershell
Register-ScheduledTask -TaskName "TeamPlanner off-PC backup" -Action $action -Trigger $trigger -Settings $settings -User $cred.UserName -Password $cred.GetNetworkCredential().Password
```

**Test the task once:**

```powershell
Start-ScheduledTask -TaskName "TeamPlanner off-PC backup"
```

```powershell
Get-ScheduledTaskInfo -TaskName "TeamPlanner off-PC backup" | Select-Object LastRunTime, LastTaskResult
```

`LastTaskResult` `0` = OK, `1` = copy failed, `2` = look at the backups,
`267009` = still running. Details:

```powershell
Get-Content C:\TeamPlanner\backups\backup-offsite.log -Tail 20
```

Look at the destination now and then: the folder grows by one dump a day and is
not pruned by the script.

### 2.4 Manual backup (before an update or a risky change)

```powershell
docker compose -f docker-compose.offline.yml exec -T backup sh -c 'f=/backups/pre-update-$(date +%Y%m%d-%H%M%S).dump; pg_dump -Fc -h db -U planner -f $f planner && ls -l $f'
```

Check that a dump is readable (lists its contents; an error means it's broken):

```powershell
docker compose -f docker-compose.offline.yml exec -T db pg_restore -l /backups/<file>.dump | Select-Object -First 10
```

### 2.5 Restore

Restoring **replaces** the current data. The file must be in
`C:\TeamPlanner\backups` (the `db` container sees that folder read-only as
`/backups`); copy a dump from the share/USB there with Explorer or `Copy-Item`
(both are binary-safe).

**Clean restore (recommended)** — load the dump into a NEW side database and
swap it in only after the load succeeded. The current database is never
dropped before a good copy exists; it is kept as `planner_old` until you have
checked the app. (Needs free disk space for a second copy of the database.)

**A. Check that the dump is readable** (lists its contents; an error means the
file is broken — stop here and pick another dump):

```powershell
docker compose -f docker-compose.offline.yml exec -T db pg_restore -l /backups/<file>.dump | Select-Object -First 10
```

**B. Stop everything that uses the database:**

```powershell
docker compose -f docker-compose.offline.yml stop proxy app backup
```

**C. List the databases.** You should see `planner` (and `postgres`,
`template0/1`). If a `planner_new` is left over from an earlier failed attempt,
drop it (`DROP DATABASE planner_new;` the same way as step H). If a
`planner_old` from an earlier restore is still there, drop it only if you are
sure you no longer need it — step E needs the name.

```powershell
docker compose -f docker-compose.offline.yml exec -T db psql -U planner -d postgres -c "\l"
```

**D. Create the side database and load the dump into it:**

```powershell
docker compose -f docker-compose.offline.yml exec -T db psql -U planner -d postgres -c "CREATE DATABASE planner_new OWNER planner;"
```

```powershell
docker compose -f docker-compose.offline.yml exec -T db pg_restore -U planner -d planner_new --no-owner /backups/<file>.dump
```

If `pg_restore` printed **any error** (for example `errors ignored on restore:
N`), do NOT continue: the live `planner` database is untouched — drop
`planner_new`, start the stack again (`up -d`) and investigate.

**E. Swap** (the app is stopped, so nothing is connected to `planner`; if
Postgres says the database "is being accessed by other users", repeat step B):

```powershell
docker compose -f docker-compose.offline.yml exec -T db psql -U planner -d postgres -c "ALTER DATABASE planner RENAME TO planner_old;"
```

```powershell
docker compose -f docker-compose.offline.yml exec -T db psql -U planner -d postgres -c "ALTER DATABASE planner_new RENAME TO planner;"
```

**F. Start and check** (sign in, open the Schedule, Dashboard and Agreements):

```powershell
docker compose -f docker-compose.offline.yml up -d
```

```powershell
curl.exe -k https://10.210.6.233:8443/api/health
```

To undo the swap instead (the restored data is wrong): stop as in step B,
rename `planner` to `planner_bad` and `planner_old` back to `planner`, start.

**G. Take a fresh dump of the restored database** once it checks out — the
`backup` container did one at startup; confirm with
`Get-Content C:\TeamPlanner\backups\last-backup.txt`.

**H. Days later, when you are sure,** drop the swapped-out database:

```powershell
docker compose -f docker-compose.offline.yml exec -T db psql -U planner -d postgres -c "DROP DATABASE planner_old;"
```

**In-place restore** (what the machine move used) — fine when the dump comes
from the **same app version**; it overwrites the objects in the dump but leaves
any extra tables alone:

```powershell
docker compose -f docker-compose.offline.yml exec -T db pg_restore -U planner -d planner --clean --if-exists --no-owner /backups/<file>.dump
```

> Restore onto the **same or newer** Postgres major version (16). The volumes
> survive `docker compose down`; only `down -v` (or `docker volume rm`) deletes
> them — avoid `-v` unless you mean to wipe.

---

## 3. Quick reference (production, from `C:\TeamPlanner`)

| Task | Command |
|------|------|
| Start / apply changes | `docker compose -f docker-compose.offline.yml up -d` |
| Status | `docker compose -f docker-compose.offline.yml ps` |
| Logs (app / proxy / migrate / backup) | `docker compose -f docker-compose.offline.yml logs --tail=40 app` |
| Health | `curl.exe -k https://10.210.6.233:8443/api/health` |
| Stop everything | `docker compose -f docker-compose.offline.yml stop` |
| Restart proxy only | `docker compose -f docker-compose.offline.yml restart proxy` |
| Back up DB now | `docker compose -f docker-compose.offline.yml exec -T backup sh -c 'f=/backups/manual-$(date +%Y%m%d-%H%M%S).dump; pg_dump -Fc -h db -U planner -f $f planner && ls -l $f'` |
| Last good backup | `Get-Content backups\last-backup.txt` |
| SQL prompt | `docker compose -f docker-compose.offline.yml exec db psql -U planner -d planner` |

## 4. Troubleshooting (things we hit)

- `bind: ...forbidden by its access permissions` on port 80/443 → held by
  Windows IIS/HTTP.sys. Publish on `8443` (`HTTPS_PORT=8443`, already done), or
  disable IIS (`Stop-Service W3SVC; Set-Service W3SVC -StartupType Disabled`).
- `ERR_SSL_PROTOCOL_ERROR` by IP → `LAN_IP` in `.env` is missing or wrong
  (it feeds both the site address and `default_sni`). Fix it, then
  `docker compose -f docker-compose.offline.yml up -d proxy`.
- Site unreachable right after `up -d`, `proxy` not running → it waits for the
  `app` healthcheck. Check `ps` (app should become `healthy`) and
  `logs --tail=40 app`.
- `user-mapped section open` saving the Caddyfile (or during `git pull`) →
  stop the proxy (and close Notepad++, which locks files too) first.
- `cannot find ... dockerDesktopLinuxEngine` → Docker Desktop isn't running;
  start it and wait for "Engine running".
- `pull access denied` / `No such image` on `up -d` → an image the compose file
  pins isn't on the PC (`pull_policy: never`). Run 1.1 step 5.
- HTTPS certificate expired on the LAN address → Caddy's internal cert failed
  to renew; `docker compose -f docker-compose.offline.yml restart proxy`.

---

## 5. Email ingest (off on production)

The app can poll a Gmail inbox (IMAP) and turn "@username" emails into
dashboard tasks. It is **off** on production. The new PC has internet, so it
could be turned on: set `EMAIL_INGEST_ENABLED=true`, `IMAP_USER`,
`IMAP_PASSWORD` (a Google App Password) in `.env`, then `up -d`. Only **one**
install may poll an inbox — turn it off on dev first.

The optional local AI (target date / priority from the email) also needs
`EMAIL_AI_ENABLED=true` and the `ai` compose profile, which starts the
`ollama` containers (the first start downloads the ~2 GB model):

```powershell
docker compose -f docker-compose.offline.yml --profile ai up -d
```

Use `--profile ai` on every later `up -d` too while AI is on.

---

## 6. Offline host (USB bundle) — legacy

> **Legacy.** This is how the old **SCADA PC** (`10.210.4.65`, no internet) was
> deployed until 2026-11-06. That PC is retired (stopped, kept as a fallback).
> Use this only for a host without internet access.

### 6.1 At a glance

- Windows 11 + Docker Desktop (per-user install). No internet, so every image
  is built/pulled on the dev PC and carried over on USB as one `.tar` file.
- Run folder `C:\TeamPlanner` holding `docker-compose.offline.yml`, `Caddyfile`,
  `.env`, `timesheet-template\` and (temporarily) the image bundle.
- Published on host port `8443` → container `443`.

### 6.2 Build the bundle (dev PC, has internet)

From the project folder on the dev PC — commit and bump the version first so
the footer hash is right:

```powershell
docker build --provenance=false --target runner -t team-planner-app:latest .
```

```powershell
docker build --provenance=false --target migrator -t team-planner-app-migrator:latest .
```

Pull the **exact** base images `docker-compose.offline.yml` pins (check the
`image:` lines — on this branch `caddy:2.11.8-alpine`, `postgres:16.15-alpine`,
and `ollama/ollama:0.40.14`). Ollama is only needed when the host will run
`--profile ai`; without it, leave it out of the pull and the bundle.

```powershell
docker pull caddy:2.11.8-alpine
```

```powershell
docker pull postgres:16.15-alpine
```

```powershell
docker pull ollama/ollama:0.40.14
```

Bundle the images into one file (`docker save -o` writes the file itself — no
redirect involved; the Ollama image makes it several GB — drop it from the
list when AI stays off):

```powershell
docker save -o team-planner-bundle.tar team-planner-app:latest team-planner-app-migrator:latest caddy:2.11.8-alpine postgres:16.15-alpine ollama/ollama:0.40.14
```

Copy to the USB stick: `team-planner-bundle.tar`, `docker-compose.offline.yml`,
`Caddyfile`, and the `timesheet-template\` folder (bind-mounted by the compose
file; the `.xlsm` can be replaced on the host any time). Do **not** copy
`.env` — create it on the host.

For a code-only update, bundle just the two app images (unless the pinned
base images changed):

```powershell
docker save -o team-planner-app-update.tar team-planner-app:latest team-planner-app-migrator:latest
```

### 6.3 Set up / update on the offline host

1. Make sure Docker Desktop is running (`docker version` shows a **Server**
   section).
2. Back up first if the stack already runs (section 2.4 — same command).
3. Put the files in `C:\TeamPlanner`, then load the images:

   ```powershell
   cd C:\TeamPlanner
   ```

   ```powershell
   docker load -i team-planner-bundle.tar
   ```

4. **New host only — create `.env`** (random DB password):

   ```powershell
   $dbpw = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 24 | ForEach-Object {[char]$_})
   ```

   ```powershell
   "DB_PASSWORD=$dbpw`r`nAPP_URL=https://<host-IP>:8443`r`nHTTPS_PORT=8443`r`nLAN_IP=<host-IP>`r`nBACKUP_KEEP_DAYS=14" | Set-Content -Path .\.env -Encoding ascii
   ```

   Keep `.env` safe; recreating it with a different `DB_PASSWORD` locks the app
   out of the existing database volume.

5. **Caddyfile:** copy it unchanged — the host's IP (`ipconfig`) goes in
   `LAN_IP` in `.env` (step 4), never in the Caddyfile.

6. Create the backups folder and start:

   ```powershell
   mkdir backups -ErrorAction SilentlyContinue
   ```

   ```powershell
   docker compose -f docker-compose.offline.yml up -d
   ```

7. Check with `ps` (as in 1.1 step 8), open the firewall (1.4) and browse to
   `https://<host-IP>:8443`. A fresh database starts at the setup wizard.

> Starting fresh on a host that already ran the app: `down -v` wipes the old
> database and uploads **permanently** — back up first.

Keeping an offline host running is the same as 1.4 (Docker Desktop on sign-in,
stay signed in, static IP).
