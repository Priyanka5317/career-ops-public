# Mode: nightly-pipeline — three runs a night, one job each

Read `modes/nightly-rules.md` first. It is the standard every step is held to.

**You are almost certainly not the orchestrator.** As of 2026-09-09 the night is
driven by `scripts/nightly-phase.mjs`, a Node driver. It runs the zero-token
stages itself and then opens **one short-lived Claude session per step**, each
with its own model and timeout. If you are reading this inside such a session,
your prompt already told you which step you are; do that step and nothing else.

## The schedule

| Time | Phase | What it does |
|---|---|---|
| 23:00 | `discover` | boards slice 1 + repos slice 1 + LinkedIn slice 1, gate, score, queue |
| 04:00 | `discover` | boards slice 2 + repos slice 2 + LinkedIn slice 2, gate, score, finalize queue |
| 09:00 | `build` | full packs, **serially**, from the queue 04:00 finalized |

One Task Scheduler task, three daily triggers. It cannot pass a different
argument per trigger, so the runner calls `--auto` and the driver picks its phase
from the clock against `config/nightly.yml` → `schedule.runs`.

**A discover run writes no artifacts. A build run scrapes nothing.**

## Why it is shaped this way

The old design ran the entire night as one `claude -p` call on `opus[1m]`. Both
real runs failed the same way:

- **2026-09-08 08:10** — `You've hit your session limit`, exit 1 at 27 minutes,
  seven pack folders holding one file each.
- **2026-09-09 02:00** — killed at the reviewer, `Background tasks still running
  after 600s`, and the whole budget spent backfilling the previous night.

Neither ever wrote a digest. Three root causes, all now fixed:

1. **The caps constrained the cheap end of the funnel and left the expensive end
   wide open.** `job-scraper.md` Step 2 told one agent to hit every board in a
   462-company universe with no ceiling, while the config carefully capped
   postings at 10 and packs at 4.
2. **Discovery and building shared one session budget**, so a long visa gate
   starved the builds.
3. **Nothing remembered individual postings.** Employers were cached 90 days and
   finished packs were a folder on disk, but a posting already extracted and
   scored was re-extracted and re-scored the next night.

## Zero-token stages — the driver runs these, not you

Never redo them, and never read a shortlist you did not just receive.

```
node nightly-boards.mjs --take 250         # rotation cursor + free ATS probing
node nightly-harvest.mjs                   # EVERY callable board, full job list
node scrape-job-repos.mjs --rotate 4       # all four public repos
node scripts/merge-feeds.mjs data/job-feed.tsv data/board-feed.tsv
node nightly-linkedin.mjs --terms 8        # guest endpoint, rotated search terms
node scripts/merge-feeds.mjs data/job-feed.tsv data/linkedin-feed.tsv
node nightly-seen.mjs --filter data/job-feed.tsv
node nightly-shortlist.mjs --out data/shortlist.tsv --limit 120 --explain
node nightly-seen.mjs --record data/shortlist.tsv --stage shortlisted
```

**`nightly-harvest.mjs` changed what this run is.** It pulls the complete job
list from every board that exposes a public slug endpoint, in-process, for zero
tokens — 21,915 postings from 172 boards in 5 seconds on 2026-09-10, against a
feed that used to hold ~450 rows. Because it is free it reads the WHOLE
universe, not the rotation slice.

Consequences you must respect:

- **Do not fetch greenhouse / ashby / lever / smartrecruiters / recruitee boards.**
  Those postings are already in the shortlist. Fetching them again is the exact
  cost that burned a whole session in 27 minutes on 2026-09-08.
- `data/board-queue.tsv` is now only useful for the ATSes the harvester cannot
  call (Workday, iCIMS, Eightfold, Dayforce, Oracle ORC, SuccessFactors, Taleo,
  UltiPro, Avature, Phenom). Nothing outside it is in scope either way.
- The shortlist **rotates**. ~589 postings qualify but only 120 reach the visa
  gate per run, so `nightly-shortlist.mjs` puts never-examined postings first
  and records each emitted row at the non-terminal stage `shortlisted`. Three
  consecutive runs shared **zero** rows. Never re-emit a shortlist by hand;
  you would break that rotation and re-examine the same slice forever.

`data/shortlist.tsv` is already filtered for role family, seniority, level
markers, the 2-year ceiling, US location, the skip list, the tracker, finished
packs **and** the seen-jobs ledger. Do not widen any of it.

## Entry level is 2 years, and it is checked three times

Their rule, 2026-09-09: *"be very accurate in being entry level roles ... less than
2 years of work experience."*

1. `nightly-shortlist.mjs` — the title: years stated in the title, level markers
   (`II`/`III`/`IV`, `Level 3`, `Data Analyst 2`, mid-level, intermediate,
   experienced), senior/staff/principal/lead, people-manager shapes. Roman `I`
   and grade `1` are entry level and pass.
2. `check-jd-experience.mjs --over-only` — the JD body, which is usually the only
   place the requirement is actually stated. **Drop every OVER file before the
   visa gate.**
3. The visa gate and the scorer never relax either of the above.

## The seen-jobs ledger

`data/seen-jobs.tsv`, keyed by normalized posting URL (tracking params stripped,
real job-id params kept).

- A **terminal** verdict (`DROP:`, `SKIP:`, `BUILT`) is never reprocessed.
- An **open** sighting is still a live candidate.
- Record every ruling you make, or the next run pays for it again:

```
node nightly-seen.mjs --record <tsv> --stage dropped --verdict "DROP:over-cap"
node nightly-seen.mjs --record <tsv> --stage built   --verdict BUILT
```

## Discover phase, agent steps

**Step 1 — extract + visa gate** (`sonnet`, 25 min)

Extract a JD to `jds/{company-slug}-{role-slug}.md` for each shortlist row that
has none, using the ATS recipes in `.claude/agents/job-scraper.md`. Record
verbatim any sentence about work authorization, sponsorship, citizenship,
clearance, required degree field or graduation year. Apply the liveness gate.

Then run the JD experience gate, drop the OVER files, and collapse survivors to
**unique employers**. Reuse any `data/visa-cache.tsv` verdict newer than 90 days
for free; fan out `visa-evaluator` only for uncached employers, 4 lookups each.
A req-level wall goes to `data/skip-list.tsv` against that exact title while the
employer's cache entry still records `SPONSOR`.

Write survivors to `data/gated.tsv`. Build nothing.

**Step 2 — score + queue** (`opus`, 20 min)

Score each survivor with the A-G evaluation in `modes/oferta.md`. TIER-3 is a
**downgrade, not a skip**; cap-exempt earns +0.3 to +0.5. Route by
`build_policy`: above 4.0 full pack, 3.0-4.0 no deck, below 3.0 digest line only.

Write `data/build-queue.tsv` best first. **Write the tracker row now, before any
build.** If `seen_company` is flagged, open that existing row and update it —
never create a second row. Then `node generate-applications-tracker.mjs`.

## Build phase, 09:00

Everything is already discovered, gated and scored. Do not scrape, re-gate or
re-score. Read `data/build-queue.tsv` only.

Incomplete packs on disk are finished **first** and count against the caps
(`caps.backfill_counts_against_cap`). Audit and complete them, never regenerate.

**Build strictly one at a time.** Never fan out `pack-builder` across roles. Per
role: pack → verify by measurement → outreach → `check-ats-score.mjs`,
`check-f-pattern.mjs` (0 findings), `check-outreach-rules.mjs` → only then record
`BUILT`. A pack is done when the checks pass, not when you say so.

If budget runs short, **stop cleanly after the current pack and say so.** A short
honest run beats a truncated one. Never leave a half-built pack.

## The digest

`reports/nightly/{YYYY-MM-DD}-digest.md`, appended by the driver after **every**
step, including failures and timeouts. It exists even when every agent dies —
which is the whole point, because under the old design it never existed at all.

Leave it as the single file the candidate opens in the morning, ending with apply links.

**Do not send anything. Do not tell their to go send anything.** The candidate sends their own
applications; the run's job is to have everything ready.

## If a step fails

The driver kills it, records it in the digest with the real error, and continues
to the next step. A partial run that is honestly reported is a good outcome; a
run that hides a failure is not.
