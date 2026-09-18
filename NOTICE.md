# NOTICE

## This is not the canonical repository

`career-ops` is an MIT-licensed open-source project created and maintained by
**Santiago Fernández de Valderrama**.

- Canonical upstream: <https://github.com/santifer/career-ops>
- Upstream is the place to file issues, open pull requests, read the changelog,
  and get the newest version.

This repository is a **redistributed copy** of that project, published under the
MIT License with the original copyright notice intact (see [LICENSE](LICENSE)).
It is a point-in-time snapshot, it is **not** affiliated with or endorsed by the
upstream maintainer, and it will drift behind upstream over time.

**If you want to use career-ops, get it from upstream, not from here.**

## What was changed in this copy

This copy exists to share the setup, not to fork the project. Relative to the
upstream snapshot it was taken from:

**Personal data removed.** The working copy this was made from was in active use
for a real job search. Every personal artifact was excluded: `cv.md`, the
applications tracker and scan history, the contacts store, generated resumes,
cover letters, pitch decks, interview prep, and scratch/scrape output. Files
that had identity details hardcoded were rewritten to read from
`config/profile.yml` or to use `{{PLACEHOLDER}}` values.

**Upstream governance and community automation removed**, because it has no
meaning outside the canonical repository and would misfire here:

- `.github/FUNDING.yml` — would render a Sponsor button on this repo
- `.github/CODEOWNERS` — would request upstream-maintainer review on PRs here
- Release automation (`release.yml`, `sbom.yml`), community bots
  (`welcome.yml`, `stale.yml`, `ledger-bot.yml`, `manifesto-guestbook.yml`,
  `gh-events-feed.yml`, `auto-triage-scan-output.yml`), and `signature-ci.yml`

Code-validation CI was kept: `test.yml`, `codeql.yml`, `dependency-review.yml`,
`no-user-data.yml`, `plugin-registry-validate.yml`, `labeler.yml`, `web-ci.yml`.

**A scheduled scan workflow was removed.** It ran on cron and ended in
`git add -A && git commit && git push`. That pattern does not belong in a public
repository, so it is not shipped here.

## Attribution

Please cite the upstream project, not this copy. See
[CITATION.cff](CITATION.cff), which correctly credits the original author.
