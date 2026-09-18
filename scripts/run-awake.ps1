<#
.SYNOPSIS
  Run a command while holding the system awake, then release.

.DESCRIPTION
  MEASURED 2026-09-13, and this is the single most damaging failure the nightly
  pipeline has had.

  The 2026-09-12 23:00 discover run started on time and did not exit until
  09:21 the next morning - 10 hours 21 minutes. It was therefore still
  "running" at 04:00 and at 09:00, and because the task is registered with
  MultipleInstances=IgnoreNew, BOTH the 04:00 discover and the 09:00 build were
  silently skipped. Nothing was built that day.

  Nothing hung. The Kernel-Power log shows the machine entered modern standby
  at 00:16:14 and left it at 05:50:30, then entered again at 05:51:08 and left
  at 09:16:09. Those two windows are 5h34m and 3h25m, which match exactly the
  20066s and 12327s the driver recorded for two ZERO-TOKEN node steps. The
  driver measures wall clock, so a suspended process looks identical to a hung
  one. Real work that night was under an hour.

  Sleep is already disabled on AC (standbyidle 0) but is 180 SECONDS on battery,
  so this only happens when the laptop is unplugged. Telling someone to keep it
  plugged in is not a fix; holding a wake lock is.

  ES_CONTINUOUS | ES_SYSTEM_REQUIRED tells Windows the system must stay
  available until this process exits. It is released automatically on exit,
  including a hard kill, because the flag is per-process. Deliberately NOT
  ES_DISPLAY_REQUIRED: the screen should still turn off.

.EXAMPLE
  powershell -File scripts/run-awake.ps1 -NodeArgs "--auto"
  powershell -File scripts/run-awake.ps1 -NodeArgs "--phase discover"

.NOTES
  Takes the driver flags as ONE STRING and splits on whitespace, rather than a
  string[]. PowerShell invoked with -File does not parse `"a`",`"b`" on the
  command line into an array - it arrives as the single literal string
  'a,b', which node then rejects as 'bad option: -e,process.exit(3)'. The
  driver's flags never contain spaces, so splitting is safe here.
#>
[CmdletBinding()]
param([string]$NodeArgs = '--auto')

$sig = @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
$ok = $false
$p = $null
try {
  $p = Add-Type -MemberDefinition $sig -Name 'PowerApi' -Namespace 'NightlyRun' -PassThru -ErrorAction Stop
  # ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001)
  $prev = $p::SetThreadExecutionState([uint32]2147483649)
  $ok = ($prev -ne 0)
  Write-Host "[awake] wake lock $(if ($ok) { 'HELD' } else { 'FAILED - run may be suspended by standby' })"
} catch {
  Write-Host "[awake] could not acquire wake lock: $($_.Exception.Message)"
}

$argv = @('scripts/nightly-phase.mjs') + (($NodeArgs -split '\s+') | Where-Object { $_ })
try {
  & node @argv
  $code = $LASTEXITCODE
  if ($null -eq $code) { $code = 0 }
} finally {
  if ($ok -and $p) {
    [void]$p::SetThreadExecutionState([uint32]2147483648)   # ES_CONTINUOUS clears it
    Write-Host '[awake] wake lock released'
  }
}
exit $code
