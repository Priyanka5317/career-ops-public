<#
.SYNOPSIS
  Kill orphaned claude.exe processes left behind by dead nightly runs.

.DESCRIPTION
  Every nightly step opens a short-lived `claude -p` session. When the driver is
  hard-terminated (the 09:00 and 16:00 build runs were repeatedly killed by a
  console control event, exit 0xC000013A) its child session is NOT reaped: it
  keeps running, holding memory and drawing on the same account quota the next
  run needs.

  Measured 2026-09-11 23:20: 21 live claude.exe, the oldest running since
  05:48 that morning with 23 minutes of accumulated CPU. Later that same night
  the 08:20 run died with "You've hit your session limit". Those two facts are
  almost certainly the same fact.

  SAFETY. This only kills a process that is BOTH:
    1. a true orphan - its parent process no longer exists, and
    2. older than -MinAgeHours (default 2).

  A claude.exe belonging to a live session always has a live parent (the shell,
  the desktop app, or a running nightly-phase.mjs), so an interactive session in
  use is never a candidate. The current process tree is excluded explicitly as a
  second belt.

.EXAMPLE
  powershell -File scripts\reap-claude.ps1              # dry run, prints only
  powershell -File scripts\reap-claude.ps1 -Execute     # actually kill
#>
[CmdletBinding()]
param(
  [switch]$Execute,
  [int]$MinAgeHours = 2
)

$now = Get-Date

# Everything in our own ancestry is off limits, whatever its age.
$protected = @()
$cur = $PID
while ($cur -and $protected.Count -lt 12) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
  if (-not $p) { break }
  $protected += [int]$p.ProcessId
  $cur = $p.ParentProcessId
}

$all = Get-CimInstance Win32_Process -Filter "Name='claude.exe'" -ErrorAction SilentlyContinue
if (-not $all) { Write-Host "no claude.exe processes found"; exit 0 }

$livePids = (Get-Process -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)

$candidates = @()
foreach ($p in $all) {
  $procId = [int]$p.ProcessId
  if ($protected -contains $procId) { continue }

  $started = $p.CreationDate
  if (-not $started) { continue }
  $ageH = ($now - $started).TotalHours
  if ($ageH -lt $MinAgeHours) { continue }

  # Orphan test: the recorded parent is gone. Windows recycles PIDs, so also
  # require the surviving parent (if any) to have started AFTER the child, which
  # is impossible for a real parent and means the PID was reused.
  $ppid = [int]$p.ParentProcessId
  $orphan = $false
  if ($livePids -notcontains $ppid) {
    $orphan = $true
  } else {
    $par = Get-CimInstance Win32_Process -Filter "ProcessId=$ppid" -ErrorAction SilentlyContinue
    if ($par -and $par.CreationDate -and $par.CreationDate -gt $started) { $orphan = $true }
  }
  if (-not $orphan) { continue }

  $candidates += [pscustomobject]@{
    Id      = $procId
    Parent  = $ppid
    AgeHrs  = [math]::Round($ageH, 1)
    CPUsec  = [math]::Round(((Get-Process -Id $procId -ErrorAction SilentlyContinue).CPU), 1)
    MB      = [math]::Round($p.WorkingSetSize / 1MB)
  }
}

Write-Host ("claude.exe total {0}, protected {1}, orphaned and older than {2}h: {3}" -f `
  $all.Count, $protected.Count, $MinAgeHours, $candidates.Count)

if (-not $candidates -or $candidates.Count -eq 0) { exit 0 }
$candidates | Sort-Object AgeHrs -Descending | Format-Table -AutoSize | Out-String | Write-Host

if (-not $Execute) {
  Write-Host "DRY RUN - nothing killed. Re-run with -Execute to reap."
  exit 0
}

$killed = 0
foreach ($c in $candidates) {
  try { Stop-Process -Id $c.Id -Force -ErrorAction Stop; $killed++ }
  catch { Write-Host ("  could not kill {0}: {1}" -f $c.Id, $_.Exception.Message) }
}
Write-Host ("reaped {0} of {1}" -f $killed, $candidates.Count)
exit 0
