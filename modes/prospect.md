# Mode: prospect — Vibe Prospecting

Powered by the **Vibe Prospecting** Claude connector (150M+ companies, 800M+ professionals, verified emails, firmographics, technographics, funding signals, hiring trends).

**Prereq:** User must have the connector installed and authorized at https://claude.com/connectors/vibeprospecting. If the connector tools aren't available when this mode runs, tell the user to install it and stop.

---

## CRITICAL: Credit Authorization Rule

**Vibe Prospecting calls cost credits. NEVER fire a query without explicit per-query user authorization.**

Workflow for EVERY Vibe Prospecting call:
1. **Propose** the exact query in plain English (e.g., *"Query Vibe Prospecting for: hiring manager + recruiter + 2 peers on Ivanti's GTM Reporting & Analytics team — 4 contact records, 1 company lookup. Run it?"*).
2. **State the target scope** — how many records, how many lookups, what fields (emails vs. just LinkedIn).
3. **Wait for explicit approval** — "yes", "run it", "go", or equivalent. Silence or ambiguity = don't run.
4. **Never batch speculative queries** to save time. If a follow-up query is needed (e.g., to fetch emails after listing people), propose and authorize it separately.
5. **Never pull emails by default.** Ask: *"Do you want verified emails for any of these, or just LinkedIn for now?"* — emails require a second authorization step and typically a separate credit cost.

If the user says "prospect X" with no further detail, that is NOT authorization to query — it's a request to plan the queries. Propose, then wait.

---

## Sub-modes (detect from args)

### A) Company drill-down — args = `{company}` or `{company} {role}`
Goal: return a ranked contact list for outreach to that company.

Use Vibe Prospecting to find, in this priority order:
1. **Hiring manager** for the team (e.g., Director/Head of the function the role sits in)
2. **Recruiter** handling the req (or the closest specialty recruiter)
3. **2–3 peers** on the team (current ICs with a similar role, bonus for alumni of the user's school / prior employers)
4. **1 adjacent team lead** whose work touches the target team daily (shown as an optional warm path)

For every person, retrieve: full name, title, LinkedIn URL, verified email (if available), tenure at company, prior company, location.

Then rank by likelihood of reply × influence on the hire. Output as a markdown table, then ask the user which contacts to draft outreach for. Pipe selected contacts into `contacto` mode.

### B) Lead-list discovery — args contain "companies" + filters
Example: `companies hiring data analysts, US-based, 100-500 employees, Series B+, H1B sponsors`

Use Vibe Prospecting filters:
- Industry / tech stack / size / geography / funding stage
- Hiring signals: roles posted in last 30/60/90 days
- Intent data: website traffic, job-posting velocity
- H1B match: cross-reference `config/profile.yml` `verified_sponsors` list first; then verify via Vibe Prospecting hiring history + LCAs if available

Output: ranked company table with `company | size | stage | role-matches-in-last-90-days | H1B-tier | fit-note`. Save to `data/prospect-lists/{YYYY-MM-DD}-{slug}.md` for tracking.

### C) Person search — args contain a person-shaped filter
Example: `senior data analysts at fintech in NYC who previously worked at Goldman`, or `recruiters at Snowflake with early-career in title`

Use Vibe Prospecting person search. Return: name, title, company, tenure, LinkedIn, verified email, prior companies. Offer to draft outreach via `contacto`.

---

## Output Rules (applies to ALL sub-modes)

1. **Never fabricate contacts.** If Vibe Prospecting returns nothing, say so. Don't fall back to guessing emails from patterns.
2. **Respect the sponsorship filter.** Cross-check every company against `config/profile.yml → sponsorship.verified_sponsors` and `reject_signals` before recommending outreach. Flag unknowns; never silently skip the check.
3. **Save research artifacts** to `data/prospect-lists/{YYYY-MM-DD}-{slug}.md` so the user can re-query without burning connector quota.
4. **Log usage:** When the mode consumes the connector, note which query was run at the top of the saved artifact (for debugging + quota awareness).
5. **Offer the pipe to contacto.** After returning the list, always ask: *"Draft LinkedIn + email for these contacts?"* — if yes, invoke `contacto` mode with the selected rows.

## When to decline

- User asks to scrape emails outside of Vibe Prospecting's verified dataset → decline, explain it violates outreach ethics + may breach CAN-SPAM / GDPR.
- User asks to prospect > 100 contacts in one pass → push back; quality-over-quantity is a hard rule from CLAUDE.md.
- User asks for personal emails (gmail/hotmail) of targets → decline. Work email only.
