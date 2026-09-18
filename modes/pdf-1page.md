# PDF Generation Mode — 1 Page Strict

> This mode overrides the default pdf.md with strict 1-page constraints.

## CRITICAL RULES — NEVER EXCEED 1 PAGE

### Content Limits (hard caps)
- **Professional Summary:** Exactly 2 sentences. No more.
- **WhoozCooking:** Pick exactly 4 bullets (best match to JD)
- **IST Management:** Pick exactly 4 bullets (best match to JD)
- **Team Maverick:** Pick exactly 2 bullets (best match to JD)
- **Projects:** Exactly 2 projects, 3 bullets each
- **Skills:** Exactly 5 category rows, each on 1 line
- **Patent:** 1 line
- **Education:** 2 entries, coursework only if JD mentions degree requirements

### Content Selection Rules
1. Read the JD fully. Identify the top 5 keywords/skills they want.
2. From the bullet bank (cv.md + all resume variants), pick bullets that contain those keywords.
3. Lightly rewrite each bullet to echo JD language — but KEEP ALL METRICS (50%, 22%, 25%, 40%, etc.)
4. If a bullet doesn't match the JD at all, drop it. Don't include filler bullets.
5. Projects: pick the 2 most relevant from (E-Commerce DB, Sentiment Analysis, Excel Automation, Employee Retention, Wegmans Survey, F1 Strategy, Kiwi Bubble, Trust & Safety, Cost of Living).

### Formatting Rules for 1 Page
- Use the template at templates/cv-template.html
- Font size: 9-9.5pt body, 8.5pt skills, 16pt name
- Line height: 1.2 everywhere
- Section margins: 4pt
- Bullet spacing: 0.5pt
- Page padding: 0.3in top/bottom, 0.45in left/right
- NO blank lines between sections
- NO extra spacing inside entries

### Before Generating PDF
Run this mental check:
- Total bullet count: 4 + 4 + 2 + 3 + 3 = 16 bullets max
- Plus summary (2 lines), education (4 lines), skills (5 lines), patent (1 line)
- Total: ~35-40 lines of content = fits 1 page at 9pt/1.2 line-height

If you count more than 18 bullets total, you have too many. Cut.

### H1B Sponsorship Check (run FIRST)
Before generating any resume, run the sponsorship filter from modes/sponsorship-filter.md.
If REJECT → do not generate. Tell the user.
If PASS/LIKELY → proceed.
If UNKNOWN → warn the user, offer to generate anyway.

### Output Filename
`{FirstName}-{LastName}-{CompanyName}-{RoleSlug}-{YYYY-MM-DD}.pdf`
Example: `Jane-Smith-AnalyticPartners-BA-Reporting-2026-04-07.pdf`
