<#
.SYNOPSIS
  Copies Team Planner database dumps off this PC (network share or USB drive)
  and reports whether the newest dump is fresh.

.DESCRIPTION
  The `backup` container writes pg_dump files to C:\TeamPlanner\backups every
  24 h. A disk failure or ransomware on this PC would take those with it, so
  this script copies every *.dump the destination does not have yet (robocopy;
  files already copied are skipped, nothing is deleted at the destination).
  It also copies the attachment-file folders saved next to the dumps as
  uploads-* (e.g. by the update steps in DEPLOY.md), if there are any. Nothing
  else in the backups folder is copied.

  It then prints the newest DAILY dump's (planner-YYYYMMDD-HHMMSS.dump) name,
  size and age. Manual dumps (pre-update-*.dump, ...) and the monthly copies
  are ignored for that check, so they cannot hide a dead backup container.
  Stale or tiny dumps mean the backup container is not working - fix that first.

  Windows PowerShell 5.1 compatible. Keep this file plain ASCII.

  Exit codes (shown as "Last Run Result" in Task Scheduler):
    0 = copied OK and the newest dump looks healthy
    1 = copy failed (destination missing / unreachable / robocopy error)
    2 = copy OK, but the newest dump is older than -MaxAgeHours, smaller than
        -MinSizeKB, there is no dump at all, or the container reported a failure

.PARAMETER Destination
  Folder to copy to, e.g. \\fileserver\IT\TeamPlanner-backups or
  E:\TeamPlanner-backups. Use a UNC path for network shares: mapped drive
  letters do not exist for a scheduled task that runs while nobody is signed in.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\TeamPlanner-local\backup-offsite.ps1 -Destination "\\fileserver\IT\TeamPlanner-backups"
  (Keep this script OUTSIDE the git clone - see DEPLOY.md: a git pull or a
  rollback checkout would otherwise overwrite or remove it.)
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$Destination,

  [string]$Source = "C:\TeamPlanner\backups",

  [string]$LogFile = "C:\TeamPlanner\backups\backup-offsite.log",

  [double]$MaxAgeHours = 26,

  [int]$MinSizeKB = 10
)

$ErrorActionPreference = "Stop"

# A quoted path that ends in a backslash ("E:\backups\") breaks robocopy's
# argument parsing (the \" is read as an escaped quote). Trim it; a bare drive
# root becomes "E:\." (plain "E:" would mean the current folder on that drive).
function Get-CleanDir([string]$Path) {
  $t = $Path.TrimEnd('\')
  if ($t -match '^[A-Za-z]:$') { return "$t\." }
  return $t
}
$Source = Get-CleanDir $Source
$Destination = Get-CleanDir $Destination

function Write-Log([string]$Message) {
  $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Write-Output $line
  try { Add-Content -Path $LogFile -Value $line } catch { Write-Warning "Could not write log ${LogFile}: $_" }
}

# Keep the log from growing forever: roll it over at 5 MB (one old copy kept).
try {
  if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 5MB)) {
    Move-Item -Path $LogFile -Destination "$LogFile.old" -Force
  }
} catch { }

Write-Log "---- off-PC backup copy: $Source -> $Destination"

if (-not (Test-Path -LiteralPath $Source)) {
  Write-Log "ERROR: source folder $Source does not exist."
  exit 1
}

# ---- 1. Copy new dumps -------------------------------------------------------
# *.dump does not match the container's in-progress *.dump.part files.
# /R:3 /W:30  retry a busy/unreachable file 3 times, 30 s apart
# /FFT        2-second timestamp tolerance (NAS / FAT / exFAT USB drives),
#             so files already copied are not copied again
# /NP /NDL    no per-file progress or directory lines in the log
$robocopyArgs = @($Source, $Destination, "*.dump", "/R:3", "/W:30", "/FFT", "/NP", "/NDL", "/LOG+:$LogFile")
& robocopy.exe @robocopyArgs | Out-Null
$rc = $LASTEXITCODE

# Robocopy: 0-7 = success (0 nothing new, 1 files copied, 2/3 extra files at
# the destination), 8 or more = at least one failure.
if ($rc -ge 8) {
  Write-Log "ERROR: robocopy failed with exit code $rc (see robocopy lines above in this log). Is the share reachable / the USB drive plugged in?"
  $copyFailed = $true
} else {
  Write-Log "Copy OK (robocopy exit code $rc)."
  $copyFailed = $false
}

# Attachment-file copies (uploads-* folders), each with its subfolders (/E).
$uploadDirs = @(Get-ChildItem -LiteralPath $Source -Directory -Filter "uploads-*" -ErrorAction SilentlyContinue)
foreach ($dir in $uploadDirs) {
  $upArgs = @($dir.FullName, (Join-Path $Destination $dir.Name), "/E", "/R:3", "/W:30", "/FFT", "/NP", "/NDL", "/LOG+:$LogFile")
  & robocopy.exe @upArgs | Out-Null
  $upRc = $LASTEXITCODE
  if ($upRc -ge 8) {
    Write-Log "ERROR: copying $($dir.Name) failed (robocopy exit code $upRc)."
    $copyFailed = $true
  } else {
    Write-Log "Copied attachment folder $($dir.Name) (robocopy exit code $upRc)."
  }
}

# ---- 2. Health of the newest dump --------------------------------------------
$unhealthy = $false
# Only the container's DAILY dumps count: a manual pre-update dump (or the
# monthly copy) must not make a dead backup container look healthy.
$newest = Get-ChildItem -LiteralPath $Source -Filter "planner-*.dump" -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^planner-\d{8}-\d{6}\.dump$' } |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1

if (-not $newest) {
  Write-Log "WARNING: no daily planner-*.dump files in $Source - the backup container has never written one."
  $unhealthy = $true
} else {
  $ageHours = ((Get-Date) - $newest.LastWriteTime).TotalHours
  $sizeKB = [math]::Round($newest.Length / 1KB, 1)
  Write-Log ("Newest dump: {0}  size {1:N1} KB  age {2:N1} h  (written {3})" -f $newest.Name, $sizeKB, $ageHours, $newest.LastWriteTime.ToString("yyyy-MM-dd HH:mm"))
  if ($ageHours -gt $MaxAgeHours) {
    Write-Log ("WARNING: newest dump is older than {0} h - check: docker compose -f docker-compose.offline.yml logs --tail=20 backup" -f $MaxAgeHours)
    $unhealthy = $true
  }
  if ($newest.Length -lt ($MinSizeKB * 1KB)) {
    Write-Log ("WARNING: newest dump is smaller than {0} KB - it is probably empty or broken." -f $MinSizeKB)
    $unhealthy = $true
  }
}

# Status files written by the backup container (see the backup service in the compose file).
$okFile = Join-Path $Source "last-backup.txt"
$errFile = Join-Path $Source "last-backup-error.txt"
if (Test-Path -LiteralPath $okFile) {
  Write-Log ("Container says last good dump: " + ((Get-Content -LiteralPath $okFile -TotalCount 1) -as [string]))
}
if (Test-Path -LiteralPath $errFile) {
  Write-Log ("WARNING: container reports a failed dump: " + ((Get-Content -LiteralPath $errFile -TotalCount 1) -as [string]))
  $unhealthy = $true
}

if ($copyFailed) { Write-Log "RESULT: FAILED (copy)"; exit 1 }
if ($unhealthy) { Write-Log "RESULT: copied, but the backups need attention"; exit 2 }
Write-Log "RESULT: OK"
exit 0
