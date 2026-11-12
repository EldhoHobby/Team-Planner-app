<#
.SYNOPSIS
  Updates Team Planner on the production PC to the newest code on main.

.DESCRIPTION
  The same steps as DEPLOY.md section 1.1, with a check after each one:
    1. stop the proxy (nobody can write while the update runs)
    2. back up the database (pre-update-*.dump in the backups folder)
    3. git pull
    4. build the app image (the build runs the unit tests)
    5. build the migrate image
    6. start everything and wait for the health check
  If the backup, the pull or a build fails, the proxy is started again so the
  version that was running keeps serving, and the script stops.

  NOT covered here (see DEPLOY.md):
    - pulling new base images, when a release changes the pinned tags (1.1 step 5)
    - rolling back (1.2)

  Windows PowerShell 5.1 compatible. Keep this file plain ASCII.

.PARAMETER Folder
  The git clone the stack runs from.

.PARAMETER HealthUrl
  The health endpoint to wait for after the start.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\TeamPlanner\scripts\update-production.ps1
#>
param(
  [string]$Folder = "C:\TeamPlanner",

  [string]$HealthUrl = "https://10.210.6.233:8443/api/health"
)

Set-Location $Folder
$compose = "docker-compose.offline.yml"

function Stop-Update([string]$message) {
  Write-Host ""
  Write-Host "STOPPED: $message" -ForegroundColor Red
  Write-Host "Starting the proxy again so the current version keeps running..."
  docker compose -f $compose start proxy
  throw $message
}

$before = git log -1 --oneline
Write-Host "Running now: $before" -ForegroundColor Cyan

Write-Host "`n[1/6] Stopping the proxy..." -ForegroundColor Cyan
docker compose -f $compose stop proxy
if ($LASTEXITCODE -ne 0) { throw "Could not stop the proxy." }

Write-Host "`n[2/6] Backing up the database..." -ForegroundColor Cyan
# Written INSIDE the backup container: PowerShell 5.1 would corrupt a dump sent through '>'.
docker compose -f $compose exec -T backup sh -c 'f=/backups/pre-update-$(date +%Y%m%d-%H%M%S).dump; pg_dump -Fc -h db -U planner -f $f planner && ls -l $f'
if ($LASTEXITCODE -ne 0) { Stop-Update "The backup failed. Nothing was changed." }

Write-Host "`n[3/6] Pulling the new code..." -ForegroundColor Cyan
$dirty = git status --porcelain --untracked-files=no
if ($dirty) { Stop-Update "The folder has local changes (see DEPLOY.md 1.3):`n$dirty" }
git pull --ff-only
if ($LASTEXITCODE -ne 0) { Stop-Update "git pull failed. Nothing was rebuilt." }

Write-Host "`n[4/6] Building the app image (runs the tests)..." -ForegroundColor Cyan
docker build --target runner -t team-planner-app:latest .
if ($LASTEXITCODE -ne 0) { Stop-Update "The app image build failed. The old images are still in use." }

Write-Host "`n[5/6] Building the migrate image..." -ForegroundColor Cyan
docker build --target migrator -t team-planner-app-migrator:latest .
if ($LASTEXITCODE -ne 0) { Stop-Update "The migrate image build failed. The app image is already new - fix this and run the script again before starting." }

Write-Host "`n[6/6] Starting the new version..." -ForegroundColor Cyan
docker compose -f $compose up -d
if ($LASTEXITCODE -ne 0) {
  throw "docker compose up failed. Check: docker compose -f $compose logs --tail=40 migrate app   (rollback: DEPLOY.md 1.2)"
}

Write-Host "`nWaiting for the app to answer..." -ForegroundColor Cyan
$ok = $false
foreach ($i in 1..36) {
  $reply = curl.exe -sk $HealthUrl
  if ($reply -match '"status":"ok"') { $ok = $true; break }
  Start-Sleep -Seconds 5
}

docker compose -f $compose ps
Write-Host ""
Write-Host "Was running: $before"
Write-Host "Now running: $(git log -1 --oneline)"
if ($ok) {
  Write-Host "Health check OK. Open the site and check the version in the sidebar footer." -ForegroundColor Green
  exit 0
}
Write-Host "The app did not answer within 3 minutes. Check:" -ForegroundColor Red
Write-Host "  docker compose -f $compose logs --tail=40 migrate"
Write-Host "  docker compose -f $compose logs --tail=40 app"
Write-Host "Rollback: DEPLOY.md section 1.2 (go back to: $before)"
exit 1
