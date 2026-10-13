---
title: process: Repair Aaahh Real Monsters Season 4 split archive files
type: process
status: completed
date: 2026-10-12
---

# process: Repair Aaahh Real Monsters Season 4 split archive files

## Overview

Process Aaahh Real Monsters Season 4 using the paired split repair workflow that was built for Season 3. Season 4 is similar to Season 3's initial state: the archive currently has 13 long MP4 files, each about 23-24 minutes, while TMDb Season 4 has 26 episodes at about 11 minutes each.

Season 4 has one important difference from Season 3: the existing archive files are not simply every odd episode. They are `S04E01, S04E04, S04E05, S04E07, ... S04E25`. The current `split-paired-episode` plan generator assumes the missing second output is `source episode + 1`, so it can generate 12 of the 13 needed split pairs automatically but skips `S04E04` because `S04E05` already exists. `S04E04` needs special handling so its second segment creates missing `S04E03 - The Lips Have It` instead of trying to create existing `S04E05`.

---

## Current Evidence

Read-only audit command used for planning:

```bash
npm run archive -- --config archive-dvd-s4.toml \
  audit-season "Z:/video/shows/Aaahh Real Monsters/Season 04" \
  --repair-policy split-paired-episode
```

Observed archive state:

- 13 existing `.mp4` files.
- All 13 are `LONG`, about 23:30-23:45.
- All 13 have paired split chapter evidence: `intro + first act + second act + outro`.
- TMDb Season 4 has 26 episodes, all about 11 minutes.
- `archive-dvd-s4.toml` documents that title cards were verified and the current source files map to true non-contiguous season episode numbers.

Existing source episodes:

```text
01 Battle of the Century
04 Escape Claws
05 Walk Like a Man
07 Watch the Watch
09 Oblina Without a Cause
11 Nuclear and Present Danger
13 Super Ickis
15 The Great Escape
17 Side by Side
19 Spy vs. Monster
21 Clockwise
23 Showdown
25 Laugh, Krumm, Laugh
```

Missing target episodes:

```text
02 A Perfect World
03 The Lips Have It
06 A Friend in Need
08 She Likes Me?
10 Slick Ick
12 Loch Ness Mess
14 The Substitute
16 Beast With Four Eyes
18 Hooked on Phobics
20 Misery Date
22 Gromble Soup
24 Internal Affairs
26 Rookie Monsters
```

---

## Problem Frame

Season 4 should be processed as a split-and-create repair, not a duplicate-removal repair.

For 12 files, the current workflow can split `source N` into:

- `replace N` from the first act + outro/tail
- `create N+1` from the second act + outro/tail

For `S04E04 - Escape Claws`, the target pair is non-adjacent in TMDb numbering. The planned outputs should be:

- `replace S04E04 - Escape Claws` from first act + outro/tail
- `create S04E03 - The Lips Have It` from second act + outro/tail

This one exceptional pair should be explicitly reviewed before staging/apply.

---

## Requirements Trace

- R1. Preserve the 13 original long Season 4 files via backup before replacement.
- R2. Stage 26 short outputs before touching the archive.
- R3. Create all 13 missing Season 4 episode files.
- R4. Replace all 13 existing long Season 4 files with their first segment outputs.
- R5. Handle the `S04E04` / `S04E03` non-adjacent pair explicitly.
- R6. Require human approval before staging and before apply.
- R7. Final audit must show 26 Season 4 files, all runtime `OK`, with no `LONG` rows.

---

## Scope Boundaries

- Do not depend on source MKVs/rips; process from existing archived MP4s only.
- Do not apply generated 12-pair output directly, because it omits the special `S04E04 -> S04E03` pair.
- Do not overwrite any existing create target. If a create target exists, stop and re-audit.
- Do not infer title identity from runtime alone; staged files require spot-checking.
- Do not solve embedded MP4 metadata tagging in this pass.

---

## Key Decisions

- Use `split-paired-episode` for Season 4.
- Generate the base plan with the existing CLI, then patch the plan to include the one non-adjacent `S04E04 -> S04E03` split action.
- Keep one Season 4 plan artifact (`aaahh-s4-repair-plan.json`) containing all 13 source items and all 26 output actions.
- Apply through `repair-season apply` so backups, create conflict checks, and manifests remain tool-supported.
- Do a dry-run before real apply.

---

## Processing Runbook

Target archive folder:

```text
Z:/video/shows/Aaahh Real Monsters/Season 04
```

Local artifacts:

```text
aaahh-s4-repair-plan.json
/mnt/c/Users/rd/Videos/_aaahh_s4_audit_test
```

### P1. Generate the base split repair plan ✅

```bash
npm run archive -- --config archive-dvd-s4.toml \
  audit-season "Z:/video/shows/Aaahh Real Monsters/Season 04" \
  --repair-policy split-paired-episode \
  --emit-repair-plan aaahh-s4-repair-plan.json
```

Expected base result:

- 12 source items.
- 24 output actions.
- Missing source item: `S04E04 - Escape Claws`, because the generator tries to pair it with existing `S04E05` and refuses to plan a create-over-existing action.

### P2. Patch the plan for `S04E04 -> S04E03` ✅

Add one normalized repair item for source `S04E04 - Escape Claws` with two outputs:

- `replace` target: `Aaahh Real Monsters - S04E04 - Escape Claws.mp4`
- `create` target: `Aaahh Real Monsters - S04E03 - The Lips Have It.mp4`

Use the same split ranges reported by the read-only audit for `S04E04`:

- chapter shape: `47s|656s|660s|47s`
- odd/current output keeps first act + outro/tail
- missing `S04E03` output keeps second act + outro/tail

After patching, expected full plan:

- 13 source items.
- 26 output actions.
- Modes: 13 `replace`, 13 `create`.
- Create episodes: `02,03,06,08,10,12,14,16,18,20,22,24,26`.

### P3. Review and approve staging ✅

Before staging, inspect `aaahh-s4-repair-plan.json` and confirm:

- `policy` is `split-paired-episode`.
- `approved_for_staging` is still `false` until review is complete.
- No output target contains path separators.
- Every `create` target is currently missing from the archive.
- `S04E04` has outputs for episodes 4 and 3, not episodes 4 and 5.

Then set:

```json
"approved_for_staging": true
```

### P4. Stage all 26 outputs ✅

```bash
rm -rf /mnt/c/Users/rd/Videos/_aaahh_s4_audit_test
npm run archive -- repair-season stage \
  --plan aaahh-s4-repair-plan.json \
  --stage-dir /mnt/c/Users/rd/Videos/_aaahh_s4_audit_test
```

Expected staging result:

- 26 `.TEST.mp4` files.
- `stage-summary.json` with 26 items.
- Durations around 11-12 minutes.

### P5. Spot-check staged outputs ✅

Recommended minimum checks:

- `S04E01` / `S04E02` for the normal adjacent pair path.
- `S04E04` / `S04E03` for the non-adjacent special pair.
- `S04E25` / `S04E26` for the final pair.

Confirm:

- `S04E04 - Escape Claws.TEST.mp4` contains Escape Claws.
- `S04E03 - The Lips Have It.TEST.mp4` contains The Lips Have It.
- Each checked output is one segment plus acceptable outro/tail, not a 23-minute paired file.

### P6. Approve and dry-run apply ✅

After spot-checking, set:

```json
"approved_for_apply": true
```

Then run:

```bash
npm run archive -- repair-season apply \
  --plan aaahh-s4-repair-plan.json \
  --stage-dir /mnt/c/Users/rd/Videos/_aaahh_s4_audit_test \
  --backup-root Z:/video.bak \
  --dry-run
```

Expected dry-run result:

- 13 replacements.
- 13 creations.
- No create-over-existing conflicts.
- No archive mutation.

### P7. Apply Season 4 repair ✅

```bash
npm run archive -- repair-season apply \
  --plan aaahh-s4-repair-plan.json \
  --stage-dir /mnt/c/Users/rd/Videos/_aaahh_s4_audit_test \
  --backup-root Z:/video.bak
```

Expected apply result:

- 13 original long files backed up under a new `Z:/video.bak/video-steward-repair-*` directory.
- 13 missing short files created.
- Apply manifest separates `replaced` and `created` outputs.

### P8. Final audit ✅

```bash
npm run archive -- --config archive-dvd-s4.toml \
  audit-season "Z:/video/shows/Aaahh Real Monsters/Season 04"
```

Success criteria:

- Season folder contains 26 `.mp4` files.
- Episodes `S04E01` through `S04E26` are present.
- All rows report runtime `OK`.
- No `LONG` rows remain.
- No split repair candidates remain.

Actual result:

- Generated `aaahh-s4-repair-plan.json`, patched it to 13 source items / 26 output actions, and approved staging/apply after review.
- Staged 26 `.TEST.mp4` outputs at `/mnt/c/Users/rd/Videos/_aaahh_s4_audit_test`.
- Sanitized the Windows-invalid `?` in `S04E08 - She Likes Me?` to archive filename `S04E08 - She Likes Me.mp4`; audit normalization still matched TMDb.
- Dry-run passed with 13 replacements and 13 creations.
- Applied repair and backed up originals to `Z:/video.bak/video-steward-repair-2026-10-13T02-07-23-459Z`.
- Final audit passed with episodes `S04E01` through `S04E26` present and all runtimes `OK`.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| `S04E04` second segment is not actually `S04E03` | Spot-check `S04E04`/`S04E03` before apply; this is the highest-risk pair. |
| Manual plan patch introduces invalid JSON or unsafe target name | Validate with `repair-season stage`; schema rejects path separators and malformed actions. |
| Create target already appears before apply | Dry-run/apply preflight fails instead of overwriting. |
| Partial archive mutation | Apply preflights every staged output first and backs up replacement targets. |
| Confusing Season 3 and Season 4 artifacts | Use `aaahh-s4-repair-plan.json` and `_aaahh_s4_audit_test` only. |

---

## Notes for Future Tooling

Season 4 shows that `split-paired-episode` needs an optional pair override map for non-adjacent TMDb episode numbering. A future enhancement could support a config section like:

```toml
[repair.split_pairs]
4 = 3
```

or a CLI override file so `buildRepairPlan` can generate all 13 pairs without manual JSON patching.

---

## Sources & References

- Related config: `archive-dvd-s4.toml`
- Related code: `src/season-audit.ts`
- Related code: `src/repair.ts`
- Related code: `src/chapters.ts`
- Related tests: `test/repair.test.ts`
- Related tests: `test/season-audit.test.ts`
- Prior processing plan: `docs/plans/2026-10-12-002-feat-paired-split-repair-plan.md`
