# Sponsorship Filter Mode

> Runs as STEP 0 before evaluation. Jobs that fail → auto-rejected.

## 4-Stage Pipeline

### Stage 1: JD Text Scan
Reject: "must be authorized", "no visa sponsorship", "will not sponsor", "US citizen only"
Approve: "visa sponsorship available", "H1B sponsorship", "will sponsor", "willing to sponsor"

### Stage 2: Company Match
Check company vs. profile.yml verified_sponsors (Tier 1/2/3).

### Stage 3: H1B Data Lookup (if ambiguous)
Query `nexgendata/h1b-visa-salary-search` via Apify. Cross-ref `jobright-ai/Daily-H1B-Jobs-In-Tech`.

### Stage 4: Decision

| JD Signal | Company | H1B Data | Decision |
|-----------|---------|----------|----------|
| APPROVE   | Any     | Any      | PASS     |
| REJECT    | Any     | Any      | REJECT   |
| None      | Tier1/2 | LCAs     | PASS     |
| None      | Tier 3  | LCAs     | PASS with warning |
| None      | None    | None     | REJECT   |

## Scoring: sponsorship_verified weight = 2.5 (highest)
- CONFIRMED in JD = 5.0/5.0
- Tier 1 + LCAs = 4.5/5.0
- Tier 2 + LCAs = 4.0/5.0
- Tier 3 / new = 3.0/5.0
- No evidence = 0.0/5.0 (auto-reject)

## Report Header
Every evaluation includes:
```
## Sponsorship Status
| Check | Result | Detail |
|-------|--------|--------|
| JD Scan | pass/fail/unknown | [signal found or "no signal"] |
| Company List | Tier X | [match detail] |
| H1BGrader | X LCAs | [latest year + salary] |
| Jobright | gold/silver/none | [link if found] |
| Verdict | PASS/REJECT | |
```
