---
description: Run the 6-agent nightly job pipeline (scrape, visa gate, score, build packs, draft outreach, review)
---

Execute the full pipeline in `modes/nightly-pipeline.md`.

Read `modes/nightly-rules.md` first and hold every stage to it.

Arguments (optional): $ARGUMENTS

- `--dry-run` — run Stages A-D only. Score and report, build no artifacts.
- `--since N` — override `caps.feed_since_days` when pulling the feed.
- `--limit N` — override how many shortlisted postings get evaluated.
- `--stage X` — run a single stage (A-F) and stop.

With no arguments, run every stage.
