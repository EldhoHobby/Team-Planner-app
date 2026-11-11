# Moving development to a new PC

How to move Team Planner development from the old dev PC to a new one and carry
on where you left off. Commands are **Windows PowerShell** (chain with `;`, not `&&`).

Read this alongside:

| File | What it covers |
|---|---|
| `README.md` | What the app is, setup, features |
| `CLAUDE.md` | Quick technical brief + conventions + gotchas (Claude Code reads it automatically) |
| `docs/PROJECT-HISTORY.md` | Release history, what's live where, open issues, WIP branches, ideas, working habits |
| `DEPLOY.md` | Production (PC `10.210.6.233`): update, roll back, keep running, backups/restore; legacy USB-bundle deploy at the end |
| `HOW_IT_WORKS.md` | Plain-English tour of the app + the Excel round-trip |
| `PLANNING.md`, `ARCHITECTURE-UPDATE.md` | Original architecture rationale (historical) |

---

## 1. What GitHub has, and what it does NOT

GitHub (`github.com/EldhoHobby/Team-Planner-app`, **public repository**) holds all
source code, the Prisma schema + migrations, Docker/Caddy config, docs, the
timesheet template (`timesheet-template/Time_Sheet_Template.xlsm`), the release
tags, and a copy of Claude's memory notes (`docs/claude-memory/`, with staff and
customer names left out).

These live **only on the old PC** and must be carried over by hand (USB, network
share or OneDrive — NOT GitHub, the repo is public):

| Item | Where on the old PC | Needed? |
|---|---|---|
| `.env` (DB password, LAN IP, IMAP app password) | project folder | **Yes** — or make a new one from `.env.example` |
| Database data | Docker volume `teamplannerapp_db_data` → export as a `.dump` (step 2) | **Yes**, to keep your dev data |
| Nightly DB dumps | `backups\*.dump` | Optional (the newest one is enough) |
| Uploaded attachments | Docker volume `teamplannerapp_uploads` | Currently empty on dev — skip unless that changes |
| Claude Code memory — full version (notes Claude keeps between sessions) | `C:\Users\eldho\.claude\projects\C--Users-eldho-Claude-Projects-Team-Planner-app\memory\` | Recommended (step 4) — the repo copy is trimmed |
| Claude Code local permissions | `.claude\settings.local.json` | Optional |
| Offline deploy bundles `*.tar`, `ollama-models.tar.gz` | project folder | No — rebuild them when you next deploy (they're several GB) |
| `node_modules`, `.next`, `tsconfig.tsbuildinfo`, `process.txt` | project folder | No |

---

## 2. On the OLD PC — before you switch

```powershell
cd "C:\Users\eldho\Claude\Projects\Team Planner app"
```

**a. Push everything to GitHub** (main, the release tag, and the two paused WIP branches):

```powershell
git status
```
```powershell
git push origin main
```
```powershell
git tag v0.0.10
```
```powershell
git push origin v0.0.10
```
```powershell
git push origin wip/sales-orders wip/excel-live-data
```

> The WIP branches are paused features (see `docs/PROJECT-HISTORY.md`). They were
> git stashes, which never leave the PC, so they were turned into branches. The
> Sales Orders branch's unit tests contain real customer abbreviations — skip that
> push and copy the folder by hand instead if you'd rather not publish them.

**b. Take a fresh database dump** (the app keeps running):

The dump is written INSIDE the container (never redirect a dump with
PowerShell `>` — it corrupts the file), then copied out:

```powershell
docker compose exec -T db sh -c "pg_dump -U planner -Fc -f /tmp/move.dump planner"
```

```powershell
docker compose cp db:/tmp/move.dump "backups\planner-move-$(Get-Date -Format yyyyMMdd-HHmmss).dump"
```

```powershell
dir backups
```

(Alternative: Settings → Data → **Download full backup** gives a `.json` snapshot you
restore from the same page — useful when moving between app versions.)

**c. Copy to a USB stick / share:**

- `.env`
- `backups\planner-move-<stamp>.dump`
- the Claude memory folder from the table above
- optionally `.claude\settings.local.json`

---

## 3. On the NEW PC — set up and run

**a. Install**

- **Git for Windows** — https://git-scm.com (includes Git Bash)
- **Docker Desktop** (WSL 2 backend) — start it and wait for "Engine running"
- **Claude Code / Claude desktop app** if you want to keep working with Claude
- Node.js/npm are NOT needed — everything builds inside Docker.

**b. Clone into the same folder path** (keeps Claude's memory folder name identical):

```powershell
mkdir "C:\Users\eldho\Claude\Projects" -ErrorAction SilentlyContinue; cd "C:\Users\eldho\Claude\Projects"
```
```powershell
git clone https://github.com/EldhoHobby/Team-Planner-app.git "Team Planner app"
```
```powershell
cd "C:\Users\eldho\Claude\Projects\Team Planner app"; git config user.name "Your Name"; git config user.email "you@example.com"
```

To get the WIP branches locally later: `git checkout wip/sales-orders` (then back with `git checkout main`).

**c. Put the `.env` file back** into the project folder (or `copy .env.example .env`
and fill in `DB_PASSWORD` with a long random string). Set `LAN_IP=` to the NEW
PC's IP (`ipconfig`) — the Caddyfile reads it, so the Caddyfile itself needs no
edit.

**d. Create the backups folder and copy the dump into it** (the `db` container
mounts `./backups` read-only at `/backups`):

```powershell
mkdir backups -ErrorAction SilentlyContinue
```

**e. Build and start** (first build takes several minutes; the unit tests run inside it):

```powershell
docker compose up -d --build
```
```powershell
docker compose ps
```

Expect `proxy`, `app` (healthy), `db` (healthy), `backup` running and `migrate`
exited (0). The `ollama` containers only start with `--profile ai` (needed only
when `EMAIL_AI_ENABLED=true`).

**f. Load your data** (replaces the empty database the first start created):

```powershell
docker compose stop proxy app backup
```

```powershell
docker compose exec -T db pg_restore -U planner -d planner --clean --if-exists --no-owner /backups/planner-move-YYYYMMDD-HHMMSS.dump
```

```powershell
docker compose up -d
```

(If you used the `.json` full backup instead: open the app, complete the first-run
setup with a throwaway owner, then Settings → Data → Restore — full restore is
Owner-only and asks for that owner's password.)

**g. Check it**

- Open https://planner.localhost — click through the self-signed certificate warning.
- Sign in with your usual login (passwords come across with the data).
- The sidebar footer should show the `package.json` version and the current git hash.
- Health check: https://planner.localhost/api/health

If the browser says the certificate date is invalid: `docker compose restart proxy`.

---

## 4. Continue with Claude Code on the new PC

1. Open the cloned project folder in Claude Code once (it creates its project folder),
   then install the memory notes from the repo — the one-line PowerShell command
   is in `docs/claude-memory/README.md`.
2. If you brought the **full** memory folder by USB, copy its `.md` files over the
   top into the same place (they replace the trimmed repo copies).
3. Optionally copy `.claude\settings.local.json` into the project's `.claude\` folder
   (saved tool permissions, so fewer approval prompts).
4. Start a new Claude session. It reads `CLAUDE.md` automatically plus the memory
   notes; `docs/PROJECT-HISTORY.md` has the full history.

The repo copy of the memory is a snapshot — before moving machines again, ask
Claude to refresh `docs/claude-memory/` and commit it.

---

## 5. Things that refer to the old PC

- The LAN IP served comes from `LAN_IP` in `.env` (step 3c). If it changes
  later, edit `.env` and run `docker compose up -d proxy`.
- **Production (`10.210.6.233`) is not affected** by a dev-PC move — it builds
  its own images from its git clone. To deploy, follow `DEPLOY.md` section 1.1
  ("Updating production").
- Email ingest: only ONE machine may poll the inbox. Keep
  `EMAIL_INGEST_ENABLED=false` on the dev PC if production polls it.
- When done, you can wipe the old PC's Docker data with `docker compose down -v`
  (**deletes the volumes** — only after the new PC is verified).
