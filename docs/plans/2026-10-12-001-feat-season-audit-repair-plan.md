---
title: feat: Add archived season audit and segment repair workflow
type: feat
status: completed
date: 2026-10-12
---

# feat: Add archived season audit and segment repair workflow

## Overview

Add a read-first workflow for finding runtime/chapter anomalies in already-archived TV seasons, then guiding a guarded segment-repair process when the evidence matches a known duplicated-paired-segment pattern. The Aaahh!!! Real Monsters Season 1 issue is the motivating case: several files named as 11-minute segment episodes actually contained `intro + segment N + segment N+1 + outro`, while the following segment already existed separately.

This workflow should not claim to prove complete episode identity from filename/runtime alone. It should report evidence, generate reviewable repair plans, require staged test outputs, and require a human approval marker before replacement.

---

## Problem Frame

`video-steward classify` helps during disc intake, but once files are already copied to `Z:/video/shows`, there is no first-class way to audit the finished season folder. This leaves mixed archive states hard to detect: filenames and episode counts can look correct while runtimes and chapter structure are wrong. The tool should make those anomalies visible before any destructive action, then guide a guarded repair path.

The manual Aaahh S1 workflow also proved that `Z:` access should continue to work without a Linux `/mnt/z` mount: Windows PowerShell could list and manipulate `Z:/video/shows`, while Node filesystem calls under WSL could not directly see that path.

---

## Requirements Trace

- R1. Audit an existing archived season folder read-only.
- R2. Compare current files to TMDb episode title/runtime metadata when manifest metadata is available.
- R3. Detect likely paired-segment duplicate candidates from duration and chapter evidence, without overclaiming content identity.
- R4. Propose segment repair cuts without modifying originals.
- R5. Generate test outputs in a staging directory before replacement.
- R6. Require backups and manifests for any replacement workflow.
- R7. Preserve the Windows/WSL `Z:` access pattern already used by `share.backend = "auto"`.
- R8. Require explicit per-season repair policy approval before staged generation or apply.
- R9. Surface content-identity uncertainty through preview/checklist evidence instead of treating filenames as proof.

---

## Scope Boundaries

- Do not automatically infer every cartoon segment convention without user-visible review.
- Do not replace files during the first audit command.
- Do not require `/mnt/z`; Windows `Z:` via PowerShell/Windows ffmpeg remains supported.
- Do not claim the audit proves the media content matches the filename/title. Runtime, chapter shape, and metadata checks are anomaly detection unless paired with human preview or stronger fingerprints.
- Do not solve embedded MP4 tagging in this pass, beyond reporting missing tags if probe data exposes them.

### Deferred to Follow-Up Work

- Embedded metadata writing for title/show/season/episode fields.
- Sidecar `.nfo` generation.
- Perceptual video/audio fingerprinting for stronger content identity checks.
- A generalized visual preview workflow beyond simple timecoded sample commands/thumbnails.

---

## Context & Research

### Relevant Code and Patterns

- `src/ffmpeg.ts` already wraps `ffprobe` for duration, streams, and chapters, but does not currently expose top-level format tags.
- `src/metadata.ts` already fetches TMDb season metadata, including runtime/title.
- `src/paths.ts` already handles WSL path conversion and Windows media binaries.
- `src/evidence.ts` and `src/chapters.ts` already classify ripped files from chapter shapes.
- `archive-dvd.ts` already contains CLI patterns for read-only commands and safe execution gates.
- `src/copy.ts` already contains the precedent for PowerShell-backed share operations, but it must be extended for list/stat/copy/rename/size verification on archive paths.

### Learning From Aaahh!!! Real Monsters S1

- Episode count alone was insufficient: folder had 24 files and TMDb had 24 episodes.
- Runtime comparison surfaced the issue: episodes 2/4/6/etc. were ~24 minutes where TMDb expected ~11.
- Chapter shape exposed candidate cuts: `[intro ~47s][segment A ~11m][segment B ~11m][outro ~45s][tail ~1s]`.
- Manual preview confirmed that episode 2's chapter 3 was episode 3, but chapter timing alone did not prove that identity.
- Existing standalone partner files were `segment + outro`, no intro, so the selected season policy was “Option 3”: keep segment chapter + outro/tail, drop intro and duplicated next segment.
- Safe manual workflow was: generate staged test files, spot-check, copy originals to `Z:/video.bak`, then replace.

---

## Key Technical Decisions

- Add a new `audit-season` command for existing `.mp4` season folders rather than overloading `classify`, which is currently disc/MKV intake-focused.
- Make `audit-season` manifest-backed by default: root `--config` supplies `show.tmdb_id`, `show.season`, show name, `.env` location, and optional title overrides. A `--season` override mirrors `classify`.
- When manifest/TMDb metadata is missing, `audit-season` still performs local filename/duration/chapter audit and reports `TMDb comparison skipped`; a stricter `--require-metadata` flag can fail non-zero.
- Add a media filesystem abstraction for archive paths: native Node operations for POSIX-visible paths, and PowerShell-backed operations for Windows drive paths under WSL.
- Model audit findings separately from repair actions so read-only reports cannot accidentally mutate media.
- Treat TMDb runtime as a heuristic, not absolute truth: flag large deltas, but present chapter evidence and title matches for human review.
- Label paired-segment findings as candidates until a human preview, chapter/title evidence, or future fingerprinting confirms act identity.
- Generate repair plans as explicit JSON artifacts before generating any media outputs.
- Require each repair plan to name an episode-shape policy, such as `segment-plus-outro-no-intro`, and require an approval marker before staging or applying repairs.
- Keep replacements as a later guarded command that requires an existing backup directory or creates one under a configured backup root.

---

## Open Questions

### Resolved During Planning

- Should the first implementation modify files? No. Start with read-only audit and staged test generation.
- How should paired segments be repaired for the Aaahh S1 pattern? For that season, keep `segment + outro/tail`, no intro, matching existing standalone segment files.
- Should `Z:` be mounted into Linux? No. Preserve the PowerShell/Windows path pattern.
- How should `audit-season` get TMDb metadata? Use the existing manifest by default via root `--config`; allow `--season` override; degrade to local-only audit when metadata is unavailable unless `--require-metadata` is set.
- How should `Z:` filesystem access work? Add a PowerShell-backed media filesystem adapter rather than relying on Node `fs` seeing `Z:/...`.

### Deferred to Implementation

- Exact CLI names and flags can be adjusted while wiring Commander, but the command boundaries should remain read-only audit vs staged repair vs replacement.
- Whether to support non-MP4 archived files in v1 depends on current archive contents; start with `.mp4` because that is the existing output format.
- Exact preview evidence format can start simple: generated command lines and optional thumbnails/timecoded samples are sufficient before future fingerprinting.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```text
audit-season
  -> MediaFs.list/stat season folder
  -> ffprobe each file for duration/streams/chapters/tags
  -> parse filename identity
  -> optionally fetch TMDb using manifest config
  -> emit report + optional repair-plan candidates

repair-season stage --plan
  -> require plan.policy + approval marker
  -> create staged TEST files from keep ranges
  -> emit staged summary manifest

repair-season apply --plan
  -> require staged outputs + approval marker
  -> backup originals to backup root
  -> verify backup sizes
  -> temp-copy staged outputs into archive folder
  -> rename into place
  -> emit replacement manifest
```

---

## Implementation Units

- [x] U1. **Add archive path filesystem adapter**

**Goal:** Make archived season scanning and replacement work for both POSIX-visible paths and Windows drive paths such as `Z:/video/shows` under WSL.

**Requirements:** R1, R6, R7

**Dependencies:** None

**Files:**
- Create: `src/media-fs.ts`
- Modify: `src/copy.ts`
- Modify: `src/paths.ts`
- Test: `test/media-fs.test.ts`

**Approach:**
- Define a small interface for archive-path operations: `exists`, `listFiles`, `stat`, `copy`, `rename`, `mkdirp`, and size verification.
- Use native Node `fs` for POSIX-visible paths.
- Use PowerShell for Windows drive paths under WSL, matching the proven manual approach and existing `share.backend = "auto"` philosophy.
- Treat PowerShell unavailable, inaccessible `Z:`, empty folders, and size mismatch as explicit typed failures.

**Patterns to follow:**
- `src/copy.ts` for PowerShell-backed safe copy precedent.
- `src/paths.ts` for runtime/path detection.

**Test scenarios:**
- Happy path: native adapter lists and stats local fixture files.
- Happy path: PowerShell adapter command construction covers list/stat/copy/rename without requiring `/mnt/z`.
- Error path: inaccessible Windows drive returns a clear problem.
- Error path: size mismatch after copy aborts replacement.

**Verification:**
- Archive commands can be implemented without raw `fs.readdir`/`fs.stat` calls against `Z:/...`.

---

- [x] U2. **Probe archived season folders**

**Goal:** Add reusable scanning for archived `.mp4` files in a season directory.

**Requirements:** R1, R7, R9

**Dependencies:** U1

**Files:**
- Create: `src/season-audit.ts`
- Modify: `src/ffmpeg.ts`
- Modify: `archive-dvd.ts`
- Test: `test/season-audit.test.ts`
- Test: `test/ffmpeg.test.ts`

**Approach:**
- Parse filenames using the existing naming convention: `Show Name - SNNENN - Title.mp4`.
- Probe duration, streams, chapters, and top-level format tags. Extend `ffmpeg.ts` with a tag-capable probe helper rather than assuming current `MediaProbe` already exposes tags.
- Use `MediaFs` for directory listing/stat and existing media path conversion for `ffprobe` paths.
- Report unparseable filenames and missing embedded tags as audit warnings.

**Patterns to follow:**
- `src/evidence.ts` for evidence-row shape.
- `src/intake.ts` for scan-and-format helpers.

**Test scenarios:**
- Happy path: a season folder with S01E01/S01E02 files returns parsed season/episode/title plus durations.
- Edge case: unparseable filenames are reported as audit warnings, not silently skipped.
- Error path: missing folder produces a clear CLI error.
- Integration: Windows-style path is routed through `MediaFs` instead of raw Node `fs`.

**Verification:**
- `audit-season` can list archived season files and probe evidence without writing anything.

---

- [x] U3. **Compare archived files to TMDb metadata**

**Goal:** Add runtime/title comparison against TMDb season metadata when manifest metadata is available.

**Requirements:** R2

**Dependencies:** U2

**Files:**
- Modify: `src/season-audit.ts`
- Modify: `src/metadata.ts` if runtime typing needs tightening
- Modify: `archive-dvd.ts`
- Test: `test/season-audit.test.ts`

**Approach:**
- Load root `--config` the same way existing commands do. Use `config.show.tmdb_id`, `config.show.season`, and `.env` from `configDir`; support `--season` override.
- If config or TMDb metadata is unavailable, continue local audit and emit `TMDb comparison skipped`, unless `--require-metadata` is set.
- For each parsed episode, compare filename title to TMDb title with exact and normalized variants.
- Compare duration to TMDb runtime with configurable tolerance, defaulting to something like `--runtime-tolerance-min 2` and `--long-delta-min 5`.
- Apply manifest title overrides when present so known TMDb title mismatches do not create noisy warnings.

**Patterns to follow:**
- `src/metadata.ts` pure helper style, especially `checkSeasonCount`.
- Existing `classify` config/TMDb degradation behavior in `archive-dvd.ts`.

**Test scenarios:**
- Happy path: 11:58 file vs TMDb 11 min is OK under tolerance.
- Error path: 23:50 file vs TMDb 11 min is flagged `LONG`.
- Edge case: title punctuation difference like `Mother May I` vs `Mother May I?` is a warning or normalized OK, not a hard failure.
- Nil path: missing `TMDB_API_KEY` produces a skipped metadata note in normal mode and an error with `--require-metadata`.

**Verification:**
- Audit report identifies all long Aaahh S1-style files while leaving S01E01 and S01E22 OK.

---

- [x] U4. **Detect paired-segment chapter candidates**

**Goal:** Convert suspicious long runtime findings into a specific “likely paired duplicate candidate” diagnosis when chapter evidence supports it, while preserving content-identity uncertainty.

**Requirements:** R3, R9

**Dependencies:** U2, U3

**Files:**
- Modify: `src/chapters.ts`
- Modify: `src/season-audit.ts`
- Test: `test/chapters.test.ts`
- Test: `test/season-audit.test.ts`

**Approach:**
- Add a classifier for archived segment repair patterns, separate from disc intake categories if that keeps semantics clean.
- Recognize `[intro][act][act][outro][stub?]` when TMDb expects a single 11-minute segment.
- Treat timing-based pair checks as candidate evidence only: next episode exists, its duration/title matches expectations, and the second act duration is close to that file's runtime.
- Do not raise confidence to “confirmed duplicate” unless preview/chapter-title/future fingerprint evidence or explicit user confirmation establishes act identity.

**Patterns to follow:**
- Existing `classifyFile` threshold-table approach in `src/chapters.ts`.

**Test scenarios:**
- Happy path: `47s, 672s, 665s, 46s, 1s` with TMDb runtime 11 => likely paired-duplicate candidate.
- Edge case: same chapter shape with TMDb runtime 22 => OK/full-length, not repair candidate.
- Error path: missing chapters keeps the finding at generic `LONG`, not an unsafe cut recommendation.
- Safety path: candidate output includes “requires preview/approval” before repair staging.

**Verification:**
- The tool explains both why a file is long and which chapters are candidate keep/drop regions without claiming it has proven content identity.

---

- [x] U5. **Emit explicit repair-plan artifacts**

**Goal:** Write a reviewable JSON/Markdown repair plan for candidate cuts without touching media.

**Requirements:** R4, R8, R9

**Dependencies:** U4

**Files:**
- Modify: `src/season-audit.ts`
- Modify: `archive-dvd.ts`
- Test: `test/season-audit.test.ts`

**Approach:**
- Add `audit-season --emit-repair-plan <path>`.
- For each candidate, include source file, expected output filename, keep ranges, drop ranges, expected duration, streams, confidence/evidence, and preview checklist.
- Include a named policy field, e.g. `segment-plus-outro-no-intro`, plus evidence from known-good files that motivates the policy.
- Require an explicit approval marker in the plan, such as `approved_for_staging: true`, before staged generation will run.

**Test scenarios:**
- Happy path: Aaahh-like candidate emits two keep ranges: segment chapter and outro/tail range.
- Edge case: no candidates emits an empty plan with a useful summary.
- Error path: refusing to overwrite an existing repair plan unless `--force` is set.
- Safety path: plan without approval marker cannot be staged.

**Verification:**
- Users can review and version a repair plan before media generation.

---

- [x] U6. **Generate staged test repairs**

**Goal:** Add a command that reads an approved repair plan and creates `.TEST.mp4` outputs in a staging directory.

**Requirements:** R5, R8

**Dependencies:** U5

**Files:**
- Create: `src/repair.ts`
- Modify: `archive-dvd.ts`
- Test: `test/repair.test.ts`

**Approach:**
- Add a command such as `repair-season --plan <path> --stage-dir <path>`.
- Refuse to run unless the repair plan has an approved policy marker.
- Implement the current manual strategy for the approved Aaahh policy: create range parts, concat them, preserve video/audio/subtitle streams, drop data streams.
- Write a staged summary manifest with durations, streams, and spot-check instructions.

**Patterns to follow:**
- `src/ffmpeg.ts` process execution/error style.
- Existing safe temp-file conventions in `src/plan.ts`.

**Test scenarios:**
- Happy path: command builds expected ffmpeg argument sequence for two keep ranges.
- Error path: missing source file fails before any output replacement.
- Error path: unapproved repair plan refuses to stage.
- Edge case: extra audio stream is preserved when allowed by stream policy.

**Verification:**
- Staged outputs can be spot-checked before originals are touched.

---

- [x] U7. **Guarded backup and replacement workflow**

**Goal:** Support replacing archived files only after staged outputs exist, policy approval is present, and originals are backed up.

**Requirements:** R6, R7, R8

**Dependencies:** U6

**Files:**
- Modify: `src/repair.ts`
- Modify: `archive-dvd.ts`
- Test: `test/repair.test.ts`

**Approach:**
- Add a separate command or flag such as `repair-season apply --plan <path> --stage-dir <path> --backup-root Z:/video.bak`.
- Require both staged summary evidence and an apply approval marker, such as `approved_for_apply: true`, after spot-checking.
- Create a timestamped backup folder, copy originals, verify sizes, write backup manifest, then replace via temp copy + rename using `MediaFs`.
- Refuse to apply when staged outputs are missing, durations are outside plan bounds, approvals are absent, or backups cannot be verified.

**Patterns to follow:**
- `src/copy.ts` safe copy semantics.
- Manual session workflow: backup first, move backup out of season folder, then replace.

**Test scenarios:**
- Happy path: apply creates backup manifest and replaces target with staged file.
- Error path: backup size mismatch aborts before replacement.
- Error path: missing backup root or inaccessible destination gives a clear message.
- Safety path: apply refuses without explicit apply approval marker.

**Verification:**
- Replacement is resumable/auditable and originals are recoverable.

---

## System-Wide Impact

- **Interaction graph:** New commands reuse ffprobe, TMDb metadata, path conversion, PowerShell share access, and safe file-copy helpers.
- **Error propagation:** Audit warnings should not exit non-zero by default unless requested; repair/apply failures should exit non-zero.
- **State lifecycle risks:** Applying repairs touches archived media, so backup verification, approval markers, and temp-file replacement are mandatory.
- **API surface parity:** Existing `classify` remains disc intake; new audit commands cover archived season folders.
- **Integration coverage:** Tests should cover path handling, plan emission, ffmpeg command construction, PowerShell adapter command construction, and guarded replacement flow.
- **Content-identity risk:** Runtime and chapter evidence are not proof of episode identity; reports and repair plans must keep that uncertainty visible until user preview/approval confirms it.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Runtime metadata differs by provider | Treat runtime mismatch as evidence, not automatic truth; require chapter evidence for cut recommendations. |
| Filename/title matches wrong content | Narrow audit language to anomaly detection and require preview/approval before repair/apply. |
| Wrong cut policy for another show | Make repair policy explicit in the emitted plan and require per-season approval before staging. |
| Media replacement loses originals | Apply command must verify backups before replacing and write backup manifests. |
| Windows/WSL path mismatch | Add `MediaFs` with PowerShell-backed operations for Windows drive paths under WSL. |
| TMDb metadata unavailable | Local audit still runs; metadata comparison is skipped unless strict mode is requested. |

---

## Documentation / Operational Notes

- Update `README.md` with an “Archived season audit” workflow:
  1. `audit-season` the archived folder using `--config` for TMDb context.
  2. Review anomaly report and preview/checklist evidence.
  3. Emit a repair plan with an explicit episode-shape policy.
  4. Mark the plan approved for staging.
  5. Generate staged test outputs.
  6. Spot-check.
  7. Mark the plan approved for apply.
  8. Apply with backup root.
- Include the Aaahh!!! Real Monsters S1 pattern as an example, but label it as a specific policy choice rather than a universal cartoon-segment default.

---

## Sources & References

- Related code: `src/chapters.ts`, `src/evidence.ts`, `src/ffmpeg.ts`, `src/metadata.ts`, `src/paths.ts`, `src/copy.ts`, `archive-dvd.ts`
- Prior plan: `docs/plans/2026-10-08-001-feat-disc-classify-command-plan.md`
