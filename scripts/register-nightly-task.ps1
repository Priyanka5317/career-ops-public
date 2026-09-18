<#
.SYNOPSIS
  Registers (or updates) the Windows Task Scheduler job that runs the career-ops
  nightly pipeline.

.DESCRIPTION
  Creates a task named "career-ops-nightly" that runs scripts\nightly-run.cmd
  every night at the given time, under the current user, whether or not she is
  logged in.

  The task runs LOCALLY on purpose. config/profile.yml, data/applications.md,
  portals.yml and output/ are gitignored, so a cloud runner cannot read the
  profile, the tracker, or the packs already built.

.PARAMETER At
  Start times, 24h "HH:mm". One trigger is created per value.

  Default 23:00, 04:00, 09:00 - her schedule as of 2026-09-09:
    23:00  discover  boards slice 1 + repos slice 1 + LinkedIn slice 1
    04:00  discover  boards slice 2 + repos slice 2 + LinkedIn slice 2
    09:00  build     full packs, serially, from the finalized queue

  Task Scheduler cannot pass a different argument per trigger, so the runner
  calls scripts/nightly-phase.mjs --auto, which picks its phase from the clock
  against config/nightly.yml -> schedule.runs. Keep the two in sync: change the
  times here AND there, or a 09:00 trigger will run the discover phase.

.PARAMETER RunWhenLoggedOut
  Use the S4U logon type so the run fires even when nobody is signed in.
  REQUIRES AN ELEVATED POWERSHELL - Windows denies S4U registration to a
  standard shell. Without this switch the task uses the Interactive logon type,
  which registers without admin and fires whenever she is signed in, including
  when the screen is locked.

.PARAMETER Unregister
  Remove the task instead of creating it.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\register-nightly-task.ps1
  powershell -ExecutionPolicy Bypass -File scripts\register-nightly-task.ps1 -At 23:00,04:00,09:00
  powershell -ExecutionPolicy Bypass -File scripts\register-nightly-task.ps1 -WhatIf
  powershell -ExecutionPolicy Bypass -File scripts\register-nightly-task.ps1 -Unregister
#>

[CmdletBinding()]
param(
  [string[]]$At = @("23:00", "04:00", "09:00"),
  [switch]$RunWhenLoggedOut,
  [switch]$Unregister,
  [switch]$WhatIf
)

$ErrorActionPreference = "Stop"

$TaskName = "career-ops-nightly"
$Repo     = Split-Path -Parent $PSScriptRoot
$Runner   = Join-Path $PSScriptRoot "nightly-run.cmd"

if ($Unregister) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'."
  } else {
    Write-Host "No scheduled task named '$TaskName'."
  }
  return
}

if (-not (Test-Path $Runner)) { throw "Runner not found: $Runner" }

# Validate every time before handing it to the scheduler, which fails obscurely.
$times = @()
foreach ($t in $At) {
  try { $times += [datetime]::ParseExact($t.Trim(), "HH:mm", $null) }
  catch { throw "-At values must look like 23:00 (24h). Got: '$t'" }
}
if ($times.Count -eq 0) { throw "-At needs at least one time." }

$action = New-ScheduledTaskAction -Execute $Runner -WorkingDirectory $Repo

# One daily trigger per time. Task Scheduler cannot vary the arguments per
# trigger, so every trigger runs the same runner and the DRIVER decides the
# phase from the clock (scripts/nightly-phase.mjs --auto).
$trigger = @()
foreach ($w in $times) { $trigger += New-ScheduledTaskTrigger -Daily -At $w }

if ($WhatIf) {
  Write-Host "WHATIF - nothing will be changed."
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "  Existing task '$TaskName' triggers:"
    foreach ($tr in $existing.Triggers) { Write-Host "    $($tr.StartBoundary)" }
  } else {
    Write-Host "  No existing task named '$TaskName'."
  }
  Write-Host "  Would register these daily triggers:"
  foreach ($w in $times) { Write-Host "    $($w.ToString('HH:mm'))" }
  Write-Host "  Runner: $Runner"
  return
}

# WakeToRun: wake the machine at the scheduled time so the run finishes BEFORE
# she gets up. Without it the run is merely deferred to whenever the machine next
# wakes - on 2026-09-08 the 03:00 trigger fired, the machine slept, and the work
# did not actually start until 08:10.
#
# WakeToRun alone is NOT enough: the power plan's RTCWAKE setting overrides it and
# ships disabled. It must also be enabled at the OS level, AC only so a wake timer
# never drains the battery while unplugged:
#
#   $g = (powercfg /getactivescheme) -replace '.*GUID: ([0-9a-f-]+).*','$1'
#   powercfg /setacvalueindex $g SUB_SLEEP RTCWAKE 1
#   powercfg /setactive $g
#
# StartWhenAvailable stays on as the fallback for a machine that was fully off.
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -WakeToRun `
  -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 4)

# Interactive is the default because Windows denies S4U registration to a
# non-elevated shell. Interactive still fires on a locked screen; it only skips
# the run when she is fully signed out.
$logonType = if ($RunWhenLoggedOut) { "S4U" } else { "Interactive" }

$principal = New-ScheduledTaskPrincipal `
  -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType $logonType `
  -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "career-ops nightly job pipeline. Two discover runs (23:00, 04:00) then a build run (09:00); the driver picks its phase from the clock. Writes reports/nightly/{date}-digest.md." | Out-Null
} catch {
  if ($RunWhenLoggedOut) {
    throw "Registration failed. -RunWhenLoggedOut needs an ELEVATED PowerShell. Either re-run this as administrator, or drop the switch to register an Interactive task without admin.`n$($_.Exception.Message)"
  }
  throw
}

$timeList = ($times | ForEach-Object { $_.ToString('HH:mm') }) -join ', '
Write-Host "Registered '$TaskName' - daily at $timeList (logon type: $logonType)."
Write-Host "  23:00 / 04:00 = discover (no artifacts), 09:00 = build (full packs)."
if (-not $RunWhenLoggedOut) {
  Write-Host "  Note: fires only while you are signed in (a locked screen is fine)."
  Write-Host "        For a run that fires when signed out, re-run as admin with -RunWhenLoggedOut."
}
Write-Host "  Runner : $Runner"
Write-Host "  Repo   : $Repo"
Write-Host "  Digest : reports\nightly\{date}-digest.md"
Write-Host "  Logs   : batch\logs\nightly-*.log"
Write-Host ""
Write-Host "Test it now with:  Start-ScheduledTask -TaskName $TaskName"
