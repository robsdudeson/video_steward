---
title: process: Audit all Courage the Cowardly Dog archive seasons
type: process
status: completed
date: 2026-10-13
---

# process: Audit all Courage the Cowardly Dog archive seasons

## Overview

Check every archived Courage the Cowardly Dog season under the archive root:

```text
Z:/video/shows/Courage the Cowardly Dog
```

Use `video_steward`'s read-only `audit-season` workflow first, then do focused manual/tool-assisted checks only where the audit shows anomalies. Do not repair anything until the anomalous files have been reviewed and a separate repair plan exists.

---

## Current Read-Only Findings

A first pass was run with the existing Courage manifests:

- `archive-dvd-courage-s1.toml`
- `archive-dvd-courage-s2.toml`
- `archive-dvd-courage-s3.toml`
- `archive-dvd-courage-s4.toml`

### Season 1

- Expected/archive count: 26 episodes.
- Audit result: all 26 rows `OK`.
- Runtime shape: ~10:54-11:27.
- No repair candidates.

### Season 2

- Expected/archive count: 25 episodes.
- Audit result: all 25 rows `OK`.
- Runtime shape: episodes 1-24 are ~11 minutes; episode 25 `The Tower of Dr. Zalost` is ~22:45 and TMDb expects 22 minutes.
- No repair candidates.

### Season 3

- Expected/archive count: 26 episodes.
- Audit result: all 26 rows `OK`.
- Runtime shape: ~11:17-11:30.
- No repair candidates.

### Season 4

- Initial expected/archive count from manifest: 25 episodes.
- Initial audit result: 23 rows `OK`, 1 `SHORT`, 1 `LONG`.
- Initial anomalies:
  - `S04E13 - The Mask`: `00:10:11`, TMDb expects `22m`, status `SHORT`.
  - `S04E25 - Perfect`: `00:22:45`, TMDb expects `11m`, status `LONG`, repair candidate under the default duplicate-removal policy.
- Processed on 2026-10-13 with a one-off resequence repair:
  - rebuilt `S04E13 - The Mask` from current `S04E13` + current `S04E14`.
  - shifted current `S04E15`-`S04E24` down to final targets `S04E14`-`S04E23`.
  - split current `S04E25` into `S04E24 - Remembrance of Courage Past` and `S04E25 - Perfect`.
- Backup: `Z:/video.bak/courage-s4-resequence-2026-10-13T12-51-05-227Z`.
- Final audit result: all 25 rows `OK`.

Season 4 is now repaired and verified.

---

## Problem Frame

The goal is not to blindly repair Courage. The goal is to establish whether each archived season is complete and whether the few Season 4 anomalies are real problems, metadata mismatches, or expected special-case episode structures.

Season 4 needs special care because it appears to contain both:

- a short file where TMDb expects a double-length episode (`The Mask`), and
- a double-length file where TMDb expects a single-length episode (`Perfect`).

User content check resolved the likely cause: the current `S04E13` is the first half of `The Mask`, the current `S04E14` is the second half of `The Mask`, episodes after that are shifted by one, and the current `S04E25` contains both `Remembrance of Courage Past` and `Perfect`.

The target repair shape is therefore a resequence-and-split workflow, not a simple duplicate-removal repair:

1. `S04E13 - The Mask` should be rebuilt by concatenating current `S04E13` + current `S04E14`.
2. Current `S04E15` through current `S04E24` should be shifted down to targets `S04E14` through `S04E23` with TMDb titles.
3. Current `S04E25` should be split:
   - first segment -> `S04E24 - Remembrance of Courage Past`
   - second segment -> `S04E25 - Perfect`

The check should now gather enough technical evidence to stage that exact repair safely.

---

## Requirements Trace

- R1. Verify all four Courage seasons against TMDb using the season manifests.
- R2. Produce an auditable summary of counts, runtimes, title matches, and repair candidates.
- R3. Confirm Season 4's expected episode count and special episodes before modifying files.
- R4. Deep-check `S04E13 - The Mask` and `S04E25 - Perfect` using duration, chapters, filenames, and available source/backups/staged artifacts.
- R5. Avoid mutating archive files during the audit phase.
- R6. If repair is needed, create a separate repair plan with backups and staging before apply.

---

## Scope Boundaries

- Do not alter files in `Z:/video/shows/Courage the Cowardly Dog` during this plan.
- Do not assume the Aaahh Real Monsters Season 3/4 split policy applies to Courage without content evidence.
- Do not trust runtime alone for content identity.
- Do not treat missing embedded metadata tags as a blocker; this has appeared on otherwise-good archived files.
- Defer MP4 metadata tagging and cosmetic filename normalization unless it affects audit correctness.

---

## Key Decisions

- Use `audit-season` as the primary season-wide checker because it already compares filenames, durations, chapters, and TMDb metadata.
- Use JSON audit output for durable summaries, then text output for human review.
- Treat Season 1-3 as provisionally healthy unless a second pass reveals count/title gaps.
- Focus manual/video spot checks on Season 4 only.
- Use a separate repair plan if Season 4 needs changes; do not fold repair into this audit plan.

---

## Processing Plan

### P1. Create durable read-only audit artifacts

Run the four audits and save JSON outputs under local processing artifacts, for example:

```bash
mkdir -p tmp/courage-audit

npm run archive -- --config archive-dvd-courage-s1.toml \
  audit-season "Z:/video/shows/Courage the Cowardly Dog/Season 01" \
  --json > tmp/courage-audit/s1.json

npm run archive -- --config archive-dvd-courage-s2.toml \
  audit-season "Z:/video/shows/Courage the Cowardly Dog/Season 02" \
  --json > tmp/courage-audit/s2.json

npm run archive -- --config archive-dvd-courage-s3.toml \
  audit-season "Z:/video/shows/Courage the Cowardly Dog/Season 03" \
  --json > tmp/courage-audit/s3.json

npm run archive -- --config archive-dvd-courage-s4.toml \
  audit-season "Z:/video/shows/Courage the Cowardly Dog/Season 04" \
  --json > tmp/courage-audit/s4.json
```

Note: `npm run` prepends package-manager output, so a helper may need to strip leading non-JSON lines before parsing.

Expected summary:

- S1: 26 rows, all `OK`.
- S2: 25 rows, all `OK`.
- S3: 26 rows, all `OK`.
- S4: 25 rows, with `S04E13` short and `S04E25` long.

### P2. Check count and episode-number continuity

From the JSON artifacts, verify for each season:

- row count matches the manifest and TMDb expectation.
- episode numbers are continuous from `1..N`.
- no duplicate episode numbers.
- no filename parse failures.
- no title warnings except known punctuation/sanitization differences.

Expected result based on first pass:

- S1 continuous `1..26`.
- S2 continuous `1..25`.
- S3 continuous `1..26`.
- S4 continuous `1..25`.

### P3. Deep-check Season 4 anomalies

Inspect `S04E13 - The Mask` and `S04E25 - Perfect` in detail:

- ffprobe duration and chapter spans.
- audit repair evidence.
- TMDb episode runtime/title metadata for S4 episodes 13 and 25.
- current archive filenames and sizes.
- any corresponding source/staged MKVs if still available under the configured source root.
- backup candidates under `Z:/video.bak` if prior conversions/repairs touched Courage.

Resolved content finding from user review:

- Current `S04E13` + current `S04E14` together form `The Mask`.
- Current `S04E25` contains `Remembrance of Courage Past` first and `Perfect` second.
- Episodes between those endpoints should be shifted down by one target episode.

Remaining technical questions:

- Can current `S04E13` + `S04E14` be concatenated cleanly with stream copy, or does it need remux/re-encode?
- What exact chapter ranges from current `S04E25` produce clean `S04E24` and `S04E25` outputs?
- Should this be implemented as a one-off guarded script/manifest or by extending `repair-season` to support concat/rename/split replacement actions?

### P4. Human spot-check Season 4 video content

Spot-check only the anomalous files unless P3 reveals broader issues:

- `S04E13 - The Mask`
- `S04E25 - Perfect`

Check beginning/middle/end timestamps:

- Does `The Mask` have a normal beginning and ending? Does it cut off early?
- Does `Perfect` have one story or two story segments?
- If `Perfect` has two segments, identify whether the second segment is duplicate, another episode, credits/extras, or part of the same story.

### P5. Decide outcome category

Classify Season 4 after P3/P4:

1. **Healthy with metadata caveat**: No archive change needed; document that TMDb runtime expectations are misleading for one or both episodes.
2. **Needs metadata/manifest override only**: Archive content is correct but title/runtime comparison needs an override facility.
3. **Needs repair from existing MP4**: `Perfect` can be trimmed/split using current repair tooling.
4. **Needs source/backups**: `The Mask` is incomplete and cannot be reconstructed from current archive MP4s.
5. **Needs custom repair workflow**: The anomaly is real but not covered by current `segment-plus-outro-no-intro` or `split-paired-episode` policies.

Current classification: **Needs custom repair workflow**. The repair has three action types: concatenate existing files, shift/rename existing content, and split one paired file into two replacements.

### P5a. Target Season 4 repair mapping

Final archive targets should be:

| Target | Source |
| --- | --- |
| `S04E01`-`S04E12` | unchanged |
| `S04E13 - The Mask` | concat current `S04E13` + current `S04E14` |
| `S04E14 - Squatting Tiger, Hidden Dog` | current `S04E15` |
| `S04E15 - Muted Muriel` | current `S04E16` |
| `S04E16 - Aqua-Farmer` | current `S04E17` |
| `S04E17 - Food of the Dragon` | current `S04E18` |
| `S04E18 - The Last of the Starmakers` | current `S04E19` |
| `S04E19 - Son of the Chicken from Outer Space` | current `S04E20` |
| `S04E20 - Courageous Cure` | current `S04E21` |
| `S04E21 - Ball of Revenge` | current `S04E22` |
| `S04E22 - Cabaret Courage` | current `S04E23` |
| `S04E23 - Wrath of the Librarian` | current `S04E24` |
| `S04E24 - Remembrance of Courage Past` | first segment of current `S04E25` |
| `S04E25 - Perfect` | second segment of current `S04E25` |

All current `S04E13`-`S04E25` files should be backed up before replacement.

### P6. If repair is needed, create a separate repair plan

Do not repair in this audit plan. Create a new focused plan only after P5 identifies the correct outcome category.

That plan should include:

- source evidence,
- staging path,
- backup root,
- exact expected targets,
- dry-run apply,
- final audit success criteria.

---

## Success Criteria

The check is complete when:

- A saved summary exists for all four seasons. ✅
- Seasons 1-3 are either confirmed healthy or have documented exceptions. ✅
- Season 4's `The Mask` and `Perfect` discrepancy is classified into one of the P5 outcome categories. ✅
- No archive mutation occurred during the audit/check phase. ✅
- If repairs are needed, the next action is a specific repair plan rather than ad hoc file changes. ✅

Actual completion:

- One-off staged outputs: `/mnt/c/Users/rd/Videos/_courage_s4_resequence_test`.
- Apply manifest: `/mnt/c/Users/rd/Videos/_courage_s4_resequence_test/apply-manifest.json` and backup copy under `Z:/video.bak/courage-s4-resequence-2026-10-13T12-51-05-227Z/apply-manifest.json`.
- Final Season 4 audit passed: `S04E01`-`S04E25` all `OK`; `S04E13 - The Mask` is now `00:22:49`; `S04E24` and `S04E25` are separate ~11m files.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| TMDb runtime metadata is wrong or uses a different episode grouping | Compare against chapters and actual content before deciding repair. |
| `Perfect` appears repairable but contains a legitimate double-length story | Spot-check content before trimming/splitting. |
| `The Mask` is incomplete and no source exists | Search source root/backups before declaring unrecoverable. |
| JSON audit output includes npm/env preamble | Strip leading lines before parsing or use text summaries for human review. |
| Existing working tree has unrelated modified files/artifacts | Avoid committing local audit artifacts unless explicitly requested. |

---

## Sources & References

- Configs: `archive-dvd-courage-s1.toml`, `archive-dvd-courage-s2.toml`, `archive-dvd-courage-s3.toml`, `archive-dvd-courage-s4.toml`
- Audit code: `src/season-audit.ts`
- Chapter/repair evidence: `src/chapters.ts`
- Repair tooling, if later needed: `src/repair.ts`
- Related Season 3/4 Aaahh split plans: `docs/plans/2026-10-12-002-feat-paired-split-repair-plan.md`, `docs/plans/2026-10-12-003-process-aaahh-s4-split-repair-plan.md`
