---
title: "feat: Add classify command for disc intake analysis"
type: feat
status: active
date: 2026-10-08
---

# feat: Add `classify` command for disc intake analysis

## Overview

Add a `video-steward classify` subcommand that automates the manual per-season DVD intake analysis performed today before an archive run: probe every ripped file in each given disc folder, classify each file's role from its chapter structure, check t-number continuity and file freshness, cross-check the episode count against TMDb's season listing, and print a review report. With `--emit <file>` it also writes a draft TOML manifest containing the `[disc.*]` mapping in t-number order with evidence comments.

---

## Problem Frame

Archiving a new DVD season currently requires ~30 minutes of hand work: ffprobe chapter analysis to classify each file (full episode vs no-theme episode vs extra), t-number continuity checks, a count check against TMDb, and hand-writing the load-bearing `[disc.*]` mapping into a manifest. The work is mechanical but error-prone, and it is the only remaining manual part of the archive workflow — everything after the mapping (validation, TMDb titles, remux, staging, share copy) is already automated by video_steward. `classify` collapses the hand work into one command plus an eyeball review.

---

## Requirements Trace

- R1. classify probes every `.mkv` in each given disc folder and reports duration, size, and chapter structure per file.
- R2. classify assigns each file exactly one category — full episode (with theme), no-theme episode, possible half, extra, or unknown — with a confidence level, and never silently resolves an ambiguous case.
- R3. classify detects t-number gaps/continuity problems within each given disc and reports them as warnings (per-disc PGC numbering restarts between discs by design, so cross-disc continuity is not a check).
- R4. classify warns about files that appear to still be writing (recently modified mtime).
- R5. classify fetches the TMDb season episode list for the show+season, compares it against the number of classified episode files, and reports match/mismatch with hints.
- R6. Default output is a printed review report; `--emit <path>` additionally writes a draft TOML manifest with the `[disc.*]` mapping in t-order and per-file evidence comments. No file is written without `--emit`.
- R7. classify is read-only with respect to media files and existing manifests (no conversion, no copy, no modification of existing TOML).

---

## Scope Boundaries

- No auto-correction: classify never rewrites an existing manifest; `--emit` writes only a new, explicitly named path and refuses to overwrite without `--force`.
- No DVD ripping or drive access (v1 invariant of the tool).
- No episode-order guessing beyond the t-number/PGC convention; ambiguous classifications are flagged for human review, not resolved.
- No per-episode content verification against TMDb — count-level cross-check only; titles bind at archive time via the manifest mapping.
- No changes to the main archive flow, manifest schema, validation rules, or copy backends.

---

## Context & Research

### Relevant Code and Patterns

- `src/ffmpeg.ts` — `probeMedia()` (streams + duration; no chapter data yet), ffprobe spawn pattern, `FfmpegError`.
- `src/intake.ts` — `scanDiscFolder()`, `ScannedFile` (duration/size), `renderStarterTOML()` (commented TOML emission pattern to mirror).
- `src/metadata.ts` — `SeasonMeta` and the TMDb season fetch already exist for the main flow.
- `archive-dvd.ts` — commander subcommand registration pattern (`scan`, `append-disc`, `search`).
- `src/config.ts` — manifest schema + `validateManifest()`; emitted drafts must satisfy this.
- Real-data fixtures: S1 (24 files: 13 with theme, 11 without) and S2 (26 files, same patterns). Long-file chapters ≈ `[~47s][~65x][~65x][~4x][stub]`; short files ≈ `[~65x][~4x][stub]`.

### Institutional Learnings

- Manual intake analysis for S1 and S2 (this session) established the chapter signatures, the t-order convention, and the count cross-check method. The existing manifests `archive-dvd.toml` / `archive-dvd-s2.toml` are golden references for what classify must reproduce.

---

## Key Technical Decisions

- **Chapter-based classification with explicit confidence.** Chapter structure is the only reliable signal of a file's role. Categories: `full` (intro + two acts + outro), `no-theme` (one act + outro), `possible-half`, `extra`, `unknown`. Thresholds are named constants (intro ≈ 30–60 s, act ≥ ~5 min, outro ≤ ~60 s). Anything not matching a known pattern is `unknown` — never guessed. Confidence per category: `full`/`no-theme` high when the chapter pattern matches cleanly; `possible-half` medium; `extra` medium (high only if chapters confirm non-episode structure); `unknown` always low.
- **Count-level TMDb cross-check.** Classified episode count vs TMDb season count: equal → high confidence in the mapping; fewer → hint "check for split halves"; more → hint "check for unignored extras". Mirrors the manual sanity check exactly.
- **t-order = PGC order convention (user-approved for S1/S2).** Sort by t-number parsed from the `*_tNN.mkv` filename suffix; episode numbers assigned sequentially across discs in CLI argument order. Files without a parseable t-number are flagged `unknown-order`, still listed, never silently ordered.
- **Freshness heuristic.** mtime within the last N minutes (default 10, `--fresh-window-min`) → "possibly still writing" warning. Cheap; no re-probe comparison.
- **Draft emission is opt-in and non-destructive.** `--emit <path>` builds a valid manifest: show section carried from the existing config when `--config` points at one with a matching show, otherwise a minimal template with TODO markers. Refuses to overwrite an existing file without `--force`. Every mapped line carries evidence comments (duration/size/classification).

---

## Open Questions

### Resolved During Planning

- Output mode: print report by default; opt-in `--emit <file>` (user decision).
- Season number source: `--season N` flag, falling back to the existing manifest's `show.season`; error if neither is available.
- Multi-disc support: classify accepts multiple disc folder names; episode numbering continues across discs in the order given on the command line.

### Deferred to Implementation

- Exact chapter thresholds after seeing S3 data (seasons may vary); keep them named constants with dedicated tests so tuning is a one-line change.
- Whether to extend `MediaProbe` with chapters or add a sibling probe function — decide when touching `src/ffmpeg.ts` (a sibling function keeps the remux path's probe lean).

---

## Implementation Units

- [x] U1. **Chapter classification engine**

**Goal:** A pure module that turns chapter durations + total duration into `{ category, confidence, evidence }`.

**Requirements:** R2, R1

**Dependencies:** None

**Files:**
- Create: `src/chapters.ts`
- Create: `test/chapters.test.ts`
- Modify: `src/ffmpeg.ts` (add chapter retrieval — sibling probe function preferred over bloating `probeMedia`)

**Approach:**
- Extend the ffprobe invocation to include `chapter=start_time,end_time` (JSON), parse into per-chapter durations.
- Pure function `classifyFile(chapterDurations, totalDuration)` against named threshold constants; returns category, confidence (`high`/`medium`/`low`), and a one-line evidence string (e.g. `intro 47s + 2 acts + outro 45s`).

**Patterns to follow:**
- ffprobe spawn/parsing in `src/ffmpeg.ts`; fixture-driven tests in `test/ffmpeg.test.ts`.

**Test scenarios:**
- Happy path: S1 long-file chapters `[47, 662, 662, 45, 1]` → `full` (with theme), high confidence.
- Happy path: S1 short-file chapters `[662, 45, 1]` → `no-theme`, high confidence.
- Edge case: three large acts in one file → `possible-half` (two full episodes likely concatenated); the test asserts this single documented outcome.
- Edge case: zero chapters → `unknown` with "no chapter data" evidence.
- Edge case: total duration < ~5 min → `extra` candidate regardless of chapters.
- Error path: ffprobe failure propagates as `FfmpegError` (per-file containment tested in U4).

**Verification:**
- Unit tests pass using both S1 and S2 chapter fixtures; thresholds live in named constants in `src/chapters.ts` forming the single documented table that tests reference.

---

- [x] U2. **Disc evidence collection**

**Goal:** Per-disc scan producing ordered evidence rows: filename, t-number, duration, size, freshness flag, chapter classification (via U1), plus t-gap warnings.

**Requirements:** R1, R3, R4

**Dependencies:** U1

**Files:**
- Create: `src/evidence.ts`
- Create: `test/evidence.test.ts`
- Modify: `src/intake.ts` only if `ScannedFile` needs a freshness/mtime field (otherwise reuse as-is)

**Approach:**
- Reuse `scanDiscFolder()` for the file listing; add mtime to the scan result.
- Parse t-number from the `*_tNN.mkv` filename suffix; compute freshness against a configurable window; call U1 per file.
- Detect missing t-numbers within each disc (e.g. t00, t01, t03 → gap warning for t02) and report them.

**Patterns to follow:**
- `scanDiscFolder()` in `src/intake.ts`; table rendering helpers used by the `scan` command.

**Test scenarios:**
- Happy path: S2 D1 filenames → t-order `C2_t00 … D8_t13` with correct sequence 0–13.
- Edge case: filename without a t-number (e.g. `menu.mkv`) → `unknown-order`, still listed and classified.
- Edge case: t-number gap (t00, t01, t03) → warning naming the missing t02.
- Edge case: mtime inside the freshness window → warning flag set; outside → not set.

**Verification:**
- Evidence rows for real S1 D1/D2 and S2 D1/D2 reproduce the manually established file lists (durations/sizes match, ordering matches the manifests).

---

- [x] U3. **TMDb season cross-check**

**Goal:** Fetch the season episode list (existing `SeasonMeta`), compare counts against classified episodes, produce a verdict with hints.

**Requirements:** R5

**Dependencies:** None (independent of U1/U2)

**Files:**
- Modify: `src/metadata.ts` (expose a small season-summary helper if the existing fetch doesn't surface a plain count)
- Create: `test/metadata.test.ts` (or extend an existing test file with mocked HTTP)

**Approach:**
- Reuse the existing TMDb client; keep network calls out of the comparison logic.
- Pure function comparing classified episode count vs TMDb count → verdict `match` / `more-files` / `fewer-files` plus a one-line hint (fewer → "check for split halves"; more → "check for unignored extras").

**Patterns to follow:**
- Existing TMDb client and error handling (`MetadataError`) in `src/metadata.ts`.

**Test scenarios:**
- Happy path: 24 classified vs TMDb 24 → `match`.
- Edge case: 23 vs 24 → `fewer-files` with the halves hint.
- Edge case: 25 vs 24 → `more-files` with the extras hint.
- Error path: TMDb fetch failure → caller can still print the classification report; cross-check section shows the error text instead of a verdict (no crash).

**Verification:**
- Unit tests pass with mocked responses; live run against show 2429 seasons 1 and 2 returns `match` for both.

---

- [x] U4. **`classify` CLI command, report rendering, draft emission**

**Goal:** Wire `video-steward classify <disc...> [--season N] [--config path] [--emit path] [--force] [--fresh-window-min N]`; render the review report; emit a draft manifest on request.

**Requirements:** R1–R7

**Dependencies:** U1, U2, U3

**Files:**
- Create: `src/classify.ts` (orchestration, report rendering, draft TOML emission)
- Modify: `archive-dvd.ts` (commander registration)
- Create: `test/classify.test.ts`

**Approach:**
- Orchestrate U2 + U3 per disc; assign episode numbers sequentially in t-order across discs **only** to files classified `full` or `no-theme`; `possible-half`, `extra`, and `unknown` files get no number and are listed under a "needs review" section.
- Render the report: one table row per file (disc, file, t#, category, confidence, duration, size, warnings) + summary block (per-disc counts, TMDb verdict, needs-review list). Reuse the existing table-printing pattern from the main flow.
- Draft emission builds a valid TOML: show section carried from the existing config when `--config` resolves to a manifest with a matching show, otherwise a minimal template; per-file evidence comments; refuses to overwrite an existing emit path without `--force`.
- Per-file probe failures degrade to `unknown` classification with a logged error; TMDb failure degrades only the cross-check section.

**Patterns to follow:**
- Commander subcommand registration in `archive-dvd.ts`; TOML emission style of `renderStarterTOML()` in `src/intake.ts`.

**Test scenarios:**
- Happy path: classify S1 D1 + D2 → report shows 24 numbered episodes E01–E24 in the established order and a TMDb `match` verdict.
- Happy path: `--emit` writes a draft TOML that passes `loadConfig()` + `validateManifest()` with no blocking errors, and whose `[disc.*]` mapping equals the manual S1 manifest mapping.
- Edge case: one file classified `unknown` → appears under "needs review" with no number; remaining files numbered correctly with no gaps in assigned numbers beyond the unreviewed set.
- Error path: `--emit` to an existing file without `--force` → clean error, nothing written.
- Integration: classify run against real manifest + media is read-only — no media or manifest file modified (mtime/size unchanged) apart from the explicit emit path.

**Verification:**
- `npx tsx archive-dvd.ts classify ARM_S1_D1 ARM_S1_D2 --season 1` reproduces the manual S1 mapping exactly; same for S2 with its disc folders.

---

- [x] U5. **Documentation and real-data regression note**

**Goal:** Document the command in the README and record the S1/S2 expected-output regression reference.

**Requirements:** R6 (workflow documentation)

**Dependencies:** U4

**Files:**
- Modify: `README.md`

**Approach:**
- New "Disc intake (classify)" section: usage example, category table with confidence semantics, the classify → review → dry-run → run workflow, and a short regression note (S1: 24/24 match; S2: 26/26 match) so future threshold tuning has a known-good baseline.

**Test expectation:** none — documentation only; correctness is verified by running the documented examples.

**Verification:**
- README examples match actual CLI behavior when run verbatim.

---

## System-Wide Impact

- **Interaction graph:** New subcommand only; existing commands (`scan`, `append-disc`, `search`, default archive) and the main flow are untouched.
- **Error propagation:** Per-file probe failures → `unknown` classification + logged error; TMDb failure → cross-check section shows error text; neither aborts the report.
- **State lifecycle risks:** None — read-only except the explicit `--emit` path (new file only, overwrite guarded).
- **Unchanged invariants:** Main archive flow, manifest schema, validation rules, copy backends, and remux behavior are unchanged. Emitted drafts must satisfy the existing config schema (enforced by a U4 test through `loadConfig`).

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| S3 chapter structure differs from S1/S2 patterns and thresholds misclassify | `unknown` category plus the count cross-check catch it; thresholds are named constants with dedicated tests, tunable after seeing S3 data |
| t-number/PGC order convention breaks for a future disc | The report prints the full evidence table so the user can renumber by hand; the draft is a starting point, not gospel |
| Some files lack chapter data entirely | `unknown` classification with explicit "no chapters" evidence; never guessed |
| Draft emission produces an invalid manifest | U4 test asserts emitted drafts pass `loadConfig()` + `validateManifest()` |
| Freshness heuristic false-positives (touched-but-complete file) | Warning only, never blocks; window is configurable via `--fresh-window-min` |

---

## Documentation / Operational Notes

- README gains the classify section (U5); no other docs affected.
- The command's output is designed to be pastable into a PR/commit message when finalizing a season's mapping.

---

## Completion Notes (2026-10-08)

All units implemented and verified against real S1/S2 data:

- **U1** `src/chapters.ts` + `probeChapters()` in `src/ffmpeg.ts`. 19 tests incl.
  real S1/S2 chapter fixtures (47|656|656|45|1 → full; 655|44|1 → no-theme).
- **U2** `src/evidence.ts`: t-number parse/sort, per-disc gap warnings (absolute
  from t00 — MakeMKV numbers per disc), freshness window. 13 tests.
- **U3** `checkSeasonCount()` in `src/metadata.ts` (pure; no network). 4 tests.
- **U4** `src/classify.ts` + commander wiring. Report, needs-review list, draft
  emission with show/paths carried from config (or commented template),
  overwrite guard. 12 tests incl. draft-passes-loadConfig scenario.
- **U5** README "classify" section + workflow update.

Regression results (real media, real TMDb):
- S1: `classify ARM_S1_D1 ARM_S1_D2` → 24/24 numbered E01–E24 in exactly the
  manual mapping's order; TMDb MATCH (24=24).
- S2: `classify ARM_S2_D1 ARM_S2_D2 --config archive-dvd-s2.toml` → 26/26 numbered
  E01–E26; TMDb MATCH (26=26).
- `--emit` draft for S1 passes `loadConfig()` + `validateManifest()` with 0 errors
  and its `[disc.*]` mapping equals the manual S1 manifest byte-for-byte per disc.
- Read-only invariant verified: media + manifest mtimes unchanged after a run.

Bug found and fixed during U4 (commander): a subcommand option with the same name
as a parent option is silently shadowed — `--config X` after the subcommand bound
to the root program, so classify used the default S1 manifest for S2 (cross-check
showed 26 vs 24 = season 1 data). Fix: `--config` declared once on the root
program; subcommands read it via `program.opts()`. Applied to scan/append-disc/
search as well (they had the same latent bug).

Test suite: 115 tests, all passing; typecheck clean.
