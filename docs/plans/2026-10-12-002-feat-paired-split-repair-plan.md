---
title: feat: Add paired split repair workflow
type: feat
status: active
date: 2026-10-12
---

# feat: Add paired split repair workflow

## Overview

Extend `video_steward` so archived-season repair can handle Aaahh Real Monsters Season 3's shape: each archived odd episode file contains two 11-minute segments, while the even episode files are missing. Unlike the Season 2 duplicate-removal workflow, Season 3 needs to stage and apply two outputs per source file: replace the existing odd episode with the first segment and create the missing even episode from the second segment.

---

## Problem Frame

Season 2 had all 26 archive files. The repair plan only replaced long odd files after confirming the second segment already existed as the next even file.

Season 3 currently has only 13 archive files (`S03E01,03,...,25`). A read-only audit shows each file is ~23-24 minutes and matches `intro + act A + act B + outro` chapter evidence. TMDb lists 26 Season 3 episodes, all ~11 minutes. Because only MP4 archives remain, the missing even episodes must be created from the second act of each paired odd file.

---

## Requirements Trace

- R1. Detect paired split candidates even when the next episode file is missing.
- R2. Generate a repair plan policy that emits two outputs per source: odd replacement and even creation.
- R3. Use TMDb episode titles/runtimes for the missing even outputs.
- R4. Stage all split outputs locally before touching the archive.
- R5. Require explicit human approval before staging and before apply, preserving the existing safety gate.
- R6. Apply must back up replaced originals and create missing archive files without backing up nonexistent targets.
- R7. Final audit should show 26 Season 3 files with OK runtimes and no long candidates.

---

## Scope Boundaries

- Do not fetch or depend on original MKV rips; Season 3 is handled from existing MP4 archives only.
- Do not auto-apply repairs from audit output.
- Do not claim chapter evidence proves content identity; the staged odd/even pairs still require human spot-checking.
- Do not rewrite the existing Season 2 `segment-plus-outro-no-intro` workflow except where needed to share abstractions.
- Do not solve embedded MP4 metadata tagging in this pass.

---

## Context & Research

### Relevant Code and Patterns

- `src/season-audit.ts` builds `RepairPlanDoc` for `segment-plus-outro-no-intro` candidates.
- `src/repair.ts` validates repair plans, stages range outputs with ffmpeg, and applies staged outputs with backups.
- `src/chapters.ts` detects paired duplicate candidates from `intro + 2 acts + outro` chapter shapes.
- `src/media-fs.ts` handles Windows-drive archive paths through PowerShell under WSL.
- `archive-dvd.ts` wires `audit-season` and `repair-season` CLI commands.
- `test/repair.test.ts`, `test/season-audit.test.ts`, and `test/chapters.test.ts` cover the existing repair flow.

### Season 3 Evidence

- `Z:/video/shows/Aaahh Real Monsters/Season 03` currently contains 13 odd-numbered files only.
- Existing files are ~23-24 minutes and named `S03E01,03,...,25`.
- TMDb Season 3 has 26 episodes, each ~11 minutes.
- Chapter probes show paired segment shapes; some files include leading/trailing stub chapters that should be ignored when deriving act ranges.

---

## Key Technical Decisions

- Add a new repair policy, tentatively `split-paired-episode`, rather than overloading `segment-plus-outro-no-intro`.
- Represent apply operations as per-output actions with an explicit mode: `replace` for odd episodes and `create` for missing even episodes.
- Keep one repair plan artifact for the whole season so staging, spot-checking, apply, and final manifest remain auditable.
- Use TMDb metadata during plan generation to name even outputs and verify expected episode numbers.
- Stage 26 final archive-named `.TEST.mp4` files, not only the 13 odd replacements.
- Preserve the same approval fields (`approved_for_staging`, `approved_for_apply`) to keep the human gate familiar.

---

## Open Questions

### Resolved During Planning

- Should Season 3 reuse the Season 2 policy? No. Season 2 removes duplicate second acts; Season 3 splits each source into two final episodes.
- Should missing even files block repair generation? No. Missing even files are expected for this policy and become `create` actions.
- Should apply back up create targets? No. It should fail if a create target already exists unless forced by a future explicit mode.

### Deferred to Implementation

- Exact JSON field names for the generalized plan can be adjusted while preserving the replace/create distinction.
- Whether to emit the split repair plan from `audit-season --emit-repair-plan` automatically or behind a flag such as `--repair-policy split-paired-episode` depends on CLI ergonomics during implementation.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```text
audit-season Season 03
  -> rows: S03E01,03,...,25 are long paired files
  -> TMDb metadata supplies S03E02,04,...,26 titles
  -> build split-paired-episode plan

split source S03E01 long file:
  output action replace S03E01 = first act + outro/tail
  output action create  S03E02 = second act + outro/tail

repair-season stage
  -> generate 26 TEST outputs into stage dir
  -> write stage-summary with action identity

repair-season apply
  -> preflight every staged output
  -> backup replace targets only
  -> fail if create target already exists
  -> copy staged outputs into archive via temp names + rename
  -> write replacement/creation manifest
```

---

## Implementation Units

- [ ] U1. **Generalize repair plan schema for output actions**

**Goal:** Support repair plans that can describe both one-output replacements and two-output split actions.

**Requirements:** R2, R5, R6

**Dependencies:** None

**Files:**
- Modify: `src/season-audit.ts`
- Modify: `src/repair.ts`
- Test: `test/repair.test.ts`

**Approach:**
- Add a policy union that includes `split-paired-episode`.
- Add output/action records with fields like episode, title, target filename/path, source, keep ranges, expected duration, and apply mode (`replace` or `create`).
- Keep backward compatibility for existing `segment-plus-outro-no-intro` plans or provide a migration-normalization layer inside `readRepairPlan`.
- Update validation so create actions do not require an existing target, while replace actions do.

**Patterns to follow:**
- Existing zod validation in `src/repair.ts`.
- Existing `RepairPlanDoc` and `RepairPlanItem` shape in `src/season-audit.ts`.

**Test scenarios:**
- Happy path: current Season 2-style plan still validates and stages as before.
- Happy path: split plan with one source and two outputs validates.
- Error path: split output with a path separator in `outputName` is rejected.
- Error path: unknown policy is rejected with a clear message.

**Verification:**
- Tests prove old and new plan shapes are accepted only when structurally safe.

---

- [ ] U2. **Detect and build split-paired Season 3 repair plans**

**Goal:** Generate a repair plan for folders where odd long files contain the missing even episodes.

**Requirements:** R1, R2, R3

**Dependencies:** U1

**Files:**
- Modify: `src/chapters.ts`
- Modify: `src/season-audit.ts`
- Modify: `archive-dvd.ts`
- Test: `test/chapters.test.ts`
- Test: `test/season-audit.test.ts`

**Approach:**
- Reuse paired chapter detection but relax the requirement that the next episode file exists when the selected policy is split/create.
- For each odd parsed episode `N`, require TMDb metadata for `N` and `N+1` and derive output names from the configured show name, season, episode numbers, and TMDb titles.
- Create two output actions from one source:
  - `replace` `N`: first act + outro/tail.
  - `create` `N+1`: second act + outro/tail.
- Treat missing TMDb even metadata, non-odd source episode numbers, and unexpected existing even files as warnings or blockers depending on severity.

**Patterns to follow:**
- `buildRepairPlan` in `src/season-audit.ts`.
- Filename parsing in `parseEpisodeFileName`.
- Chapter trimming in `detectSegmentRepairCandidate`.

**Test scenarios:**
- Happy path: 13 odd long rows plus TMDb episodes 1-26 produces 26 output actions.
- Edge case: leading zero-length/stub chapters are ignored when finding intro/act/outro ranges.
- Error path: missing TMDb metadata for `N+1` blocks split plan generation.
- Error path: an even archive file already exists and the plan is in create mode; report a conflict rather than overwrite.

**Verification:**
- `audit-season` can emit a Season 3 split plan with expected episodes `1..26` and no gaps.

---

- [ ] U3. **Stage split outputs safely**

**Goal:** Generate all odd replacement and even creation `.TEST.mp4` files in a stage directory.

**Requirements:** R4, R5

**Dependencies:** U1, U2

**Files:**
- Modify: `src/repair.ts`
- Test: `test/repair.test.ts`

**Approach:**
- Update `stageRepairs` to iterate output actions rather than assuming one output per plan item.
- Keep using ffmpeg copy ranges and concat lists.
- Ensure concat lists use media-tool paths, preserving the Season 2 path-handling fix.
- Write a stage summary that records policy, source, output action mode, target path, staged output path, and expected duration.

**Patterns to follow:**
- Existing `stageRepairs` implementation.
- Existing `stage-summary.json` preflight behavior.

**Test scenarios:**
- Happy path: one split source stages two outputs with distinct filenames.
- Edge case: existing staged output refuses to overwrite without `--force`.
- Error path: unapproved plan refuses staging.
- Integration: stage summary item count matches output action count, not source item count.

**Verification:**
- A Season 3 split plan stages 26 files in `C:/Users/rd/Videos/_aaahh_s3_audit_test`.

---

- [ ] U4. **Apply replace/create actions with backups and conflict checks**

**Goal:** Apply staged split outputs to the archive without losing originals or accidentally overwriting newly-created even files.

**Requirements:** R5, R6

**Dependencies:** U3

**Files:**
- Modify: `src/repair.ts`
- Test: `test/repair.test.ts`
- Test: `test/media-fs.test.ts` if media filesystem existence checks need coverage

**Approach:**
- Preflight all staged outputs before any archive mutation.
- For `replace` actions: require target exists, back it up, then copy/rename staged output into place.
- For `create` actions: require target does not exist, then copy/rename staged output into place; do not create a backup entry for nonexistent targets.
- Write a manifest that distinguishes replacements from creations.
- Fail the whole apply if any conflict is found before starting mutation.

**Patterns to follow:**
- `copyVerified`, `mediaFsForPath`, temp-copy then rename in current `applyRepairs`.

**Test scenarios:**
- Happy path: replace action backs up original and replaces target.
- Happy path: create action writes a new target and records it as created.
- Error path: create action fails if target already exists.
- Error path: replace action fails if target is missing.
- Error path: missing staged output fails before any archive file is changed.

**Verification:**
- Dry-run lists 13 replacements and 13 creations for Season 3.

---

- [ ] U5. **Document and verify the Season 3 workflow**

**Goal:** Make the new workflow understandable and verify the real Season 3 archive end state.

**Requirements:** R7

**Dependencies:** U2, U3, U4

**Files:**
- Modify: `README.md`
- Test: `test/season-audit.test.ts`

**Approach:**
- Add documentation explaining duplicate-removal versus split-create repair policies.
- Include the Season 3 command sequence: audit/emit split plan, approve staging, stage, spot-check, approve apply, dry-run apply, apply, final audit.
- After implementation, run the final audit against Season 3 and confirm all 26 files are OK.

**Patterns to follow:**
- Existing README section `Archived season audit + guarded repair`.

**Test scenarios:**
- Documentation-only assertions are not needed; behavioral coverage lives in U2-U4.
- Final real-world verification: archive audit reports 26 rows, all runtime `OK`, no repair candidates.

**Verification:**
- README makes clear which policy to use for Season 2 versus Season 3.

---

## System-Wide Impact

- **Interaction graph:** `audit-season` emits a richer plan; `repair-season stage/apply` consume the generalized plan.
- **Error propagation:** missing metadata, existing create targets, missing replace targets, and absent staged outputs should fail before mutation.
- **State lifecycle risks:** apply must avoid partial mutation by preflighting every action first; backups remain required for replacements.
- **API surface parity:** CLI help and README need to expose the new policy clearly.
- **Integration coverage:** tests should cover old duplicate-removal plans and new split-create plans so Season 2 behavior does not regress.
- **Unchanged invariants:** repairs remain approval-gated and staged before apply; no command should mutate archive files during audit.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Splitting the wrong act into the even title | Keep plan confidence at candidate level and require spot-checking staged outputs before apply. |
| Partial archive mutation during apply | Preflight all actions before mutation; use temp-copy + rename; write manifest after successful actions. |
| Regressing Season 2 repair | Keep backward compatibility tests for `segment-plus-outro-no-intro`. |
| Existing even file conflict | Create actions fail if target exists, forcing explicit user review. |
| Windows/WSL path issues | Reuse `mediaFsForPath` and the fixed media-tool concat paths. |

---

## Documentation / Operational Notes

- The working tree currently has a local untracked `aaahh-s2-repair-plan.json`; implementation should avoid accidentally committing that artifact.
- Season 3 staged output directory should be separate from Season 2, e.g. `C:/Users/rd/Videos/_aaahh_s3_audit_test`.
- Backups should continue to live under `Z:/video.bak`.

---

## Sources & References

- Related code: `src/season-audit.ts`
- Related code: `src/repair.ts`
- Related code: `src/chapters.ts`
- Related tests: `test/repair.test.ts`
- Related tests: `test/season-audit.test.ts`
- Prior plan: `docs/plans/2026-10-12-001-feat-season-audit-repair-plan.md`
