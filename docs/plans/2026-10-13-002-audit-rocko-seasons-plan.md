---
title: process: Audit all Rocko's Modern Life archive seasons
type: process
status: active
date: 2026-10-13
---

# process: Audit all Rocko's Modern Life archive seasons

## Overview

Check every archived Rocko's Modern Life season under:

```text
Z:/video/shows/Rocko's Modern Life
```

A first read-only pass shows a consistent pattern: many long 23-25 minute files are paired broadcast/DVD files, while the following episode already exists as a separate short file. This resembles the Aaahh Real Monsters Season 2 duplicate-removal repair pattern, not the Season 3/4 split-and-create pattern.

The best next step is to produce durable audit artifacts for all four seasons, then plan a guarded duplicate-removal repair for candidate long files while separately investigating one non-candidate long file in Season 1.

---

## Current Read-Only Findings

Read-only audits were run with:

- `archive-dvd-rocko-s1.toml`
- `archive-dvd-rocko-s2.toml`
- `archive-dvd-rocko-s3.toml`
- `archive-dvd-rocko-s4.toml`

### Season 1

- Rows: 26.
- Initial runtime statuses: 13 `OK`, 13 `LONG`.
- Repair candidates: 12 automatic duplicate-removal candidates.
- Special anomaly: `S01E11 - The Good, the Bad, and the Wallaby` was `LONG` but not an automatic repair candidate because its chapter shape was close but outside current thresholds: `47s|652s|577s|61s`.
- User confirmed `S01E11` contains `S01E12 - Trash-O-Madness` right after the expected episode, so the plan was manually patched to include S01E11.
- Processed on 2026-10-13: replaced 13 duplicate-paired files; final audit shows all 26 rows `OK`.
- Backup: `Z:/video.bak/video-steward-repair-2026-10-13T12-27-14-150Z`.

### Season 2

- Rows: 23.
- Initial runtime statuses: 13 `OK`, 10 `LONG`.
- Repair candidates: 10 duplicate-removal candidates.
- Long-but-OK specials:
  - `S02E01 - I Have No Son!` is ~24m and TMDb expects 24m.
  - `S02E10 - Rocko's Modern Christmas` is ~23m and TMDb expects 24m.
  - `S02E13 - Cruisin'` is ~22m and TMDb expects 24m.
- Processed on 2026-10-13: replaced 10 duplicate-paired files; final audit shows all 23 rows `OK`.
- Backup: `Z:/video.bak/video-steward-repair-2026-10-13T10-56-47-110Z`.

### Season 3

- Rows: 25.
- Initial runtime statuses: 13 `OK`, 12 `LONG`.
- Repair candidates: 12 duplicate-removal candidates.
- Long-but-OK special:
  - `S03E19 - Wacky Delly` is ~25m and TMDb expects 24m.
- Processed on 2026-10-13: replaced 12 duplicate-paired files; final audit shows all 25 rows `OK`.
- Backup: `Z:/video.bak/video-steward-repair-2026-10-13T11-00-04-601Z`.

### Season 4

- Rows: 26.
- Initial runtime statuses: 13 `OK`, 13 `LONG`.
- Repair candidates: 13 duplicate-removal candidates.
- Pattern: every odd-numbered file is a duplicate-removal candidate and every following even file exists as the short second story.
- Processed on 2026-10-13: replaced 13 duplicate-paired files; final audit shows all 26 rows `OK`.
- Backup: `Z:/video.bak/video-steward-repair-2026-10-13T10-53-03-385Z`.

---

## Problem Frame

Rocko appears to have been archived from two-story DVD/broadcast files in a mixed state:

- the first story file often still contains both stories, and
- the second story already exists separately as the next episode.

That means most anomalies should be fixed by replacing the long file with first act + outro/tail, dropping the duplicate second act. This is the existing `segment-plus-outro-no-intro` repair policy.

However, Season 1 has one long file (`S01E11`) that the tool does not currently classify as a repair candidate because its outro is about 61 seconds, just above the current `outroMaxSec` threshold of 60. This should be reviewed before deciding whether to tune the threshold, patch a one-off plan, or leave it alone.

---

## Requirements Trace

- R1. Audit all four Rocko seasons against TMDb using the season manifests.
- R2. Save parseable audit summaries for counts, runtime status, title status, and repair candidates.
- R3. Distinguish legitimate 24-minute specials from erroneous duplicate-paired long files.
- R4. Investigate `S01E11` before applying broad repair.
- R5. If repair is needed, stage outputs and require human spot-check before archive mutation.
- R6. Back up every replaced archive file under `Z:/video.bak`.
- R7. Final audit after any repair should show expected rows with all runtime statuses `OK` and no unintended repair candidates.

---

## Scope Boundaries

- Do not use `split-paired-episode` for Rocko unless a missing-file pattern is proven; current evidence points to duplicate removal.
- Do not repair legitimate long specials (`S02E01`, `S02E10`, `S02E13`, `S03E19`).
- Do not mutate archive files during the audit/classification phase.
- Do not treat missing embedded metadata tags as failures.
- Defer MP4 metadata tagging and cosmetic filename changes.

---

## Key Decisions

- Use `audit-season` with the default `segment-plus-outro-no-intro` policy for Rocko.
- Treat Season 4 as the cleanest candidate for automated duplicate-removal repair if we choose to process repairs.
- Treat Season 1 as requiring a small investigation because of `S01E11`.
- Use separate per-season repair plans if repairs are applied, rather than one giant cross-season plan.
- Keep all generated plans/staging directories season-specific to avoid mixing Rocko artifacts.

---

## Processing Plan

### P1. Create durable read-only audit artifacts

Run audits and save JSON outputs locally:

```bash
mkdir -p tmp/rocko-audit

npm run archive -- --config archive-dvd-rocko-s1.toml \
  audit-season "Z:/video/shows/Rocko's Modern Life/Season 01" \
  --json > tmp/rocko-audit/s1.json

npm run archive -- --config archive-dvd-rocko-s2.toml \
  audit-season "Z:/video/shows/Rocko's Modern Life/Season 02" \
  --json > tmp/rocko-audit/s2.json

npm run archive -- --config archive-dvd-rocko-s3.toml \
  audit-season "Z:/video/shows/Rocko's Modern Life/Season 03" \
  --json > tmp/rocko-audit/s3.json

npm run archive -- --config archive-dvd-rocko-s4.toml \
  audit-season "Z:/video/shows/Rocko's Modern Life/Season 04" \
  --json > tmp/rocko-audit/s4.json
```

Note: `npm run` may prepend package/env output, so strip leading non-JSON lines before machine parsing.

### P2. Build a season summary table

From the audit artifacts, summarize:

- row count,
- expected TMDb/runtime count,
- `OK` / `LONG` / `SHORT` counts,
- repair candidate episodes,
- long-but-OK specials,
- non-candidate anomalies.

Expected first-pass summary:

| Season | Rows | OK | LONG | Repair candidates | Notes |
| --- | ---: | ---: | ---: | --- | --- |
| S1 | 26 | 13 | 13 | 12 | `S01E11` long non-candidate |
| S2 | 23 | 13 | 10 | 10 | specials `S02E01`, `S02E10`, `S02E13` OK |
| S3 | 25 | 13 | 12 | 12 | special `S03E19` OK |
| S4 | 26 | 13 | 13 | 13 | clean odd/even duplicate pattern |

### P3. Deep-check non-candidate `S01E11`

Inspect `S01E11 - The Good, the Bad, and the Wallaby` and neighboring `S01E12 - Trash-O-Madness`:

- ffprobe chapter spans and duration.
- whether `S01E12` duration matches `S01E11`'s second act within tolerance.
- video spot-check first act, second act, and outro.
- whether the 61-second outro is a real longer outro or chapter boundary drift.

Decision options:

1. Tune `outroMaxSec` from 60 to a slightly higher threshold and add a regression test.
2. Manually patch the Season 1 repair plan for only `S01E11`.
3. Leave `S01E11` unchanged if content evidence says it is a legitimate long/special file.

### P4. Generate per-season repair plans where safe

For seasons with duplicate-removal candidates, emit one repair plan per season:

```bash
npm run archive -- --config archive-dvd-rocko-s4.toml \
  audit-season "Z:/video/shows/Rocko's Modern Life/Season 04" \
  --emit-repair-plan rocko-s4-repair-plan.json
```

Repeat for S1-S3 only after handling their special cases.

Expected plan sizes before any S1 special handling:

- S1: 12 items unless `S01E11` is handled.
- S2: 10 items.
- S3: 12 items.
- S4: 13 items.

### P5. Stage and spot-check by season

Use separate stage directories:

```text
/mnt/c/Users/rd/Videos/_rocko_s1_audit_test
/mnt/c/Users/rd/Videos/_rocko_s2_audit_test
/mnt/c/Users/rd/Videos/_rocko_s3_audit_test
/mnt/c/Users/rd/Videos/_rocko_s4_audit_test
```

For each season:

1. Review emitted plan.
2. Set `approved_for_staging=true`.
3. Run `repair-season stage`.
4. Spot-check several staged outputs, including edge cases:
   - S1: include `S01E11` if repaired.
   - S2: ensure specials are not included.
   - S3: ensure `S03E19 - Wacky Delly` is not included.
   - S4: check first, middle, and last odd/even pairs.

### P6. Dry-run and apply one season at a time

For each approved staged season:

```bash
npm run archive -- repair-season apply \
  --plan rocko-sX-repair-plan.json \
  --stage-dir /mnt/c/Users/rd/Videos/_rocko_sX_audit_test \
  --backup-root Z:/video.bak \
  --dry-run
```

If dry-run is clean and spot-checks pass, set `approved_for_apply=true` and apply without `--dry-run`.

### P7. Final audit after each season

After each season apply, rerun the corresponding read-only audit.

Success criteria:

- Legitimate specials remain `OK`.
- Repaired duplicate-paired files become `OK` at ~11-13 minutes.
- No unexpected `SHORT` files appear.
- No repair candidates remain except intentionally deferred cases.

---

## Recommended Execution Order

1. Season 4 first: cleanest all-odd duplicate-removal pattern. ✅ completed
2. Season 2: fewer candidates, but preserve known 24-minute specials. ✅ completed
3. Season 3: preserve `Wacky Delly` special. ✅ completed
4. Season 1 last: resolve `S01E11` before finalizing repair. ✅ completed

This order builds confidence on the simplest case before handling the only threshold/manual anomaly.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Accidentally trimming a legitimate special | Only repair emitted candidates; explicitly exclude long-but-OK specials. |
| `S01E11` threshold edge case is mishandled | Deep-check and choose tune/manual/leave before applying S1. |
| Duplicate-removal cuts wrong content | Spot-check staged outputs and verify dropped second act exists as next episode. |
| Cross-season artifacts get mixed | Use per-season plan and stage paths. |
| Partial archive mutation | Use existing apply preflight, backups, and one-season-at-a-time execution. |

---

## Sources & References

- Configs: `archive-dvd-rocko-s1.toml`, `archive-dvd-rocko-s2.toml`, `archive-dvd-rocko-s3.toml`, `archive-dvd-rocko-s4.toml`
- Audit code: `src/season-audit.ts`
- Chapter candidate logic: `src/chapters.ts`
- Repair tooling: `src/repair.ts`
- Related duplicate-removal precedent: `docs/plans/2026-10-12-001-feat-season-audit-repair-plan.md`
