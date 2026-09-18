@echo off
REM ===================================================================
REM nightly-run.cmd - thin wrapper around scripts/nightly-phase.mjs.
REM
REM Registered with Windows Task Scheduler as ONE task with three daily
REM triggers (see scripts/register-nightly-task.ps1):
REM
REM   23:00  discover   boards slice 1 + repos slice 1 + LinkedIn slice 1
REM   04:00  discover   boards slice 2 + repos slice 2 + LinkedIn slice 2
REM   09:00  build      full packs, serially, from the finalized queue
REM
REM Task Scheduler cannot pass a different argument per trigger, so the
REM driver picks its phase from the clock with --auto. Pass an explicit
REM phase to override.
REM
REM Runs LOCALLY on purpose: config/profile.yml, data/applications.md,
REM portals.yml and output/ are all gitignored, so a cloud runner cannot
REM see the profile, the tracker or the packs already built, and would
REM duplicate work every single night.
REM
REM Manual:   scripts\nightly-run.cmd
REM Discover: scripts\nightly-run.cmd --phase discover
REM Build:    scripts\nightly-run.cmd --phase build
REM Plan:     scripts\nightly-run.cmd --plan
REM ===================================================================

setlocal

set "REPO=%~dp0.."
pushd "%REPO%" || exit /b 1

REM Timestamped log per run. The task reports success even when a step failed,
REM so the log and reports/nightly/{date}-digest.md are the real record.
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HHmmss"') do set "STAMP=%%i"
if not exist "batch\logs" mkdir "batch\logs"
set "LOG=batch\logs\nightly-%STAMP%.log"

echo [nightly] start %DATE% %TIME% >> "%LOG%"
echo [nightly] repo: %REPO% >> "%LOG%"
echo [nightly] args: %* >> "%LOG%"

REM Reap claude.exe sessions orphaned by a hard-terminated previous run. Only
REM kills processes whose PARENT IS GONE and that are over 2h old, so a live
REM interactive session is never a candidate - verified 2026-09-11, when it
REM correctly reported 0 of 20 live processes as orphans.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\reap-claude.ps1" -Execute >> "%LOG%" 2>&1

REM The driver runs the zero-token stages in process, then opens ONE short-lived
REM claude session per step with its own model and timeout. It appends to the
REM digest after every step, so a killed step can no longer lose the night.
REM Run under a WAKE LOCK. On 2026-09-12 the 23:00 run took 10h21m of wall clock
REM because the machine entered modern standby twice mid-run (00:16-05:50 and
REM 05:51-09:16). It was therefore still "running" at 04:00 and 09:00, and
REM MultipleInstances=IgnoreNew silently SKIPPED both of those runs - nothing was
REM built that day. Sleep is off on AC but 180s on battery, so this bites
REM whenever the laptop is unplugged. run-awake.ps1 holds ES_SYSTEM_REQUIRED for
REM the life of the run and releases it on exit.
if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\run-awake.ps1" -NodeArgs "--auto" >> "%LOG%" 2>&1
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\run-awake.ps1" -NodeArgs "%*" >> "%LOG%" 2>&1
)

set "RC=%ERRORLEVEL%"
echo [nightly] exit %RC% at %DATE% %TIME% >> "%LOG%"

popd
endlocal & exit /b %RC%
