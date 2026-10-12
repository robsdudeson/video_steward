import type { ChapterSpan } from "./ffmpeg.js";

export type FileCategory = "full" | "no-theme" | "possible-half" | "extra" | "unknown";
export type Confidence = "high" | "medium" | "low";

export interface Classification {
  category: FileCategory;
  confidence: Confidence;
  evidence: string;
}

export type SegmentRepairKind = "paired-duplicate-candidate" | "paired-split-candidate" | "not-candidate" | "insufficient-evidence";

export interface ChapterRange {
  startSec: number;
  endSec: number;
}

export interface SplitOutputRanges {
  /** Output for the existing odd episode: first act + outro/tail. */
  oddKeep: ChapterRange[];
  /** Output for the missing even episode: second act + outro/tail. */
  evenKeep: ChapterRange[];
}

export interface SegmentRepairCandidate {
  kind: SegmentRepairKind;
  confidence: Confidence;
  evidence: string;
  policy: "segment-plus-outro-no-intro" | "split-paired-episode" | null;
  keepRanges: ChapterRange[];
  dropRanges: ChapterRange[];
  splitOutputs?: SplitOutputRanges;
}

/**
 * Threshold table — the single documented source of truth for file-role
 * classification. Tuning for a new season means changing values here and in
 * test/chapters.test.ts, nothing else.
 */
export const THRESHOLDS = {
  /** Lower bound (s) for an opening-theme segment. */
  introMinSec: 30,
  /** A "large act" is at least this many seconds (~5 min). */
  actMinSec: 300,
  /** Upper bound (s) for an end-credits outro segment. */
  outroMaxSec: 60,
  /** Trailing zero-length/stub chapters shorter than this are ignored. */
  stubMaxSec: 15,
  /** Files shorter than this total duration are extra candidates. */
  extraMaxTotalSec: 300,
  /** TMDb runtimes at/above this many minutes are treated as full-length. */
  fullLengthRuntimeMin: 20,
  /** Actual duration must exceed expected runtime by this many seconds before repair is considered. */
  repairLongDeltaSec: 5 * 60,
  /** Next-file duration must be this close to the dropped act to call it matching evidence. */
  nextEpisodeMatchToleranceSec: 2 * 60,
} as const;

/** Durations of the given chapter spans, in seconds. */
export function spansToDurations(spans: ChapterSpan[]): number[] {
  return spans.map((s) => s.endSec - s.startSec);
}

function trimTrailingStubs<T extends number | ChapterSpan>(items: T[], durationOf: (item: T) => number): T[] {
  const out = [...items];
  for (;;) {
    const tail = out[out.length - 1];
    if (tail === undefined || durationOf(tail) >= THRESHOLDS.stubMaxSec) break;
    out.pop();
  }
  return out;
}

function fmt(d: number): string {
  return `${Math.round(d)}s`;
}

/**
 * Classify a ripped file's role from its chapter structure.
 *
 * Known patterns (DVD authoring, verified on Aaahh!!! Real Monsters S1/S2):
 *   full episode:        [intro ~47s][act][act][outro ~45s]
 *   episode w/o theme:   [act][outro]            (disc-authoring choice)
 *   two-act, no theme:   [act][act]              (complete, no opening theme)
 * Anything else is possible-half / extra / unknown — never guessed.
 */
export function classifyFile(chapterDurations: number[], totalSec: number | null): Classification {
  const total = totalSec ?? chapterDurations.reduce((a, b) => a + b, 0);

  if (chapterDurations.length === 0) {
    // Only call it an extra when the duration is actually known; a missing
    // duration means we have no evidence at all, not that the file is short.
    if (totalSec !== null && totalSec < THRESHOLDS.extraMaxTotalSec) {
      return { category: "extra", confidence: "low", evidence: `no chapters; total ${fmt(totalSec)} is short` };
    }
    const why = totalSec === null ? "no chapter data and no duration" : "no chapter data";
    return { category: "unknown", confidence: "low", evidence: why };
  }

  // Drop trailing stub chapters (0-1s tail entries MakeMKV/DVDs often emit).
  const segs = trimTrailingStubs(chapterDurations, (d) => d);
  if (segs.length === 0) {
    return { category: "unknown", confidence: "low", evidence: "only stub-length chapters" };
  }

  const acts = segs.filter((d) => d >= THRESHOLDS.actMinSec).length;
  // segs is guaranteed non-empty above; ?? 0 is a type-level guard only.
  const first = segs[0] ?? 0;
  const last = segs[segs.length - 1] ?? 0;
  const hasIntro = first < THRESHOLDS.actMinSec && first >= THRESHOLDS.introMinSec;
  const hasOutro = last <= THRESHOLDS.outroMaxSec;
  const shape = segs.map(fmt).join("|");

  if (total < THRESHOLDS.extraMaxTotalSec) {
    return { category: "extra", confidence: "medium", evidence: `total ${fmt(total)} is short; chapters ${shape}` };
  }
  if (acts === 0) {
    return { category: "unknown", confidence: "low", evidence: `no act-sized segments in ${shape}` };
  }
  if (acts >= 3) {
    return { category: "possible-half", confidence: "medium", evidence: `${acts} large acts (${shape}) — likely concatenated episodes` };
  }
  if (acts === 2 && hasIntro && hasOutro) {
    return { category: "full", confidence: "high", evidence: `intro ${fmt(first)} + 2 acts + outro ${fmt(last)}` };
  }
  if (acts === 2 && !hasIntro) {
    return { category: "no-theme", confidence: "medium", evidence: `2 acts, no opening theme (${shape})` };
  }
  if (acts === 1 && hasOutro && !hasIntro) {
    return { category: "no-theme", confidence: "high", evidence: `1 act + outro ${fmt(last)}, no opening theme (${shape})` };
  }
  if (acts === 1 && hasIntro) {
    return {
      category: "possible-half",
      confidence: "medium",
      evidence: `intro + single act (${shape}) — possibly first half of an episode`,
    };
  }
  return {
    category: "unknown",
    confidence: "low",
    evidence: `unrecognized chapter shape ${shape}${hasOutro ? "" : ", no outro"}`,
  };
}

/**
 * Shared structural gate for paired-segment files: intro + two act-sized
 * chapters + outro, total duration well above the expected single-episode
 * runtime. Returns the trimmed four-span shape or a rejection candidate.
 */
function longPairedShape(opts: {
  chapters: ChapterSpan[];
  actualDurationSec: number | null;
  expectedRuntimeMin: number | null;
}): { intro: ChapterRange; firstAct: ChapterRange; secondAct: ChapterRange; outro: ChapterRange; tailEndSec: number; durations: string[] } | SegmentRepairCandidate {
  if (opts.chapters.length === 0) {
    return { kind: "insufficient-evidence", confidence: "low", evidence: "no chapter data", policy: null, keepRanges: [], dropRanges: [] };
  }
  if (opts.expectedRuntimeMin === null || opts.expectedRuntimeMin >= THRESHOLDS.fullLengthRuntimeMin) {
    return {
      kind: "not-candidate",
      confidence: "medium",
      evidence: opts.expectedRuntimeMin === null ? "no expected runtime" : `expected runtime ${opts.expectedRuntimeMin}m is full-length`,
      policy: null,
      keepRanges: [],
      dropRanges: [],
    };
  }

  const trimmed = trimTrailingStubs(opts.chapters, (c) => c.endSec - c.startSec);
  if (trimmed.length !== 4) {
    return { kind: "not-candidate", confidence: "low", evidence: `chapter shape ${spansToDurations(trimmed).map(fmt).join("|")} is not intro+2 acts+outro`, policy: null, keepRanges: [], dropRanges: [] };
  }
  const [intro, firstAct, secondAct, outro] = trimmed;
  if (!intro || !firstAct || !secondAct || !outro) {
    return { kind: "insufficient-evidence", confidence: "low", evidence: "incomplete chapter data", policy: null, keepRanges: [], dropRanges: [] };
  }

  const introDur = intro.endSec - intro.startSec;
  const firstDur = firstAct.endSec - firstAct.startSec;
  const secondDur = secondAct.endSec - secondAct.startSec;
  const outroDur = outro.endSec - outro.startSec;
  const hasIntro = introDur >= THRESHOLDS.introMinSec && introDur < THRESHOLDS.actMinSec;
  const hasTwoActs = firstDur >= THRESHOLDS.actMinSec && secondDur >= THRESHOLDS.actMinSec;
  const hasOutro = outroDur <= THRESHOLDS.outroMaxSec;
  const total = opts.actualDurationSec ?? opts.chapters.at(-1)?.endSec ?? 0;
  const expectedSec = opts.expectedRuntimeMin * 60;
  const isLong = total > expectedSec + THRESHOLDS.repairLongDeltaSec;
  if (!hasIntro || !hasTwoActs || !hasOutro || !isLong) {
    return { kind: "not-candidate", confidence: "medium", evidence: `shape ${spansToDurations(trimmed).map(fmt).join("|")} does not match long paired-segment candidate`, policy: null, keepRanges: [], dropRanges: [] };
  }

  const tail = opts.chapters.slice(trimmed.length);
  return {
    intro,
    firstAct,
    secondAct,
    outro,
    tailEndSec: tail.length > 0 ? tail[tail.length - 1]!.endSec : outro.endSec,
    durations: spansToDurations(trimmed).map(fmt),
  };
}

export function detectSegmentRepairCandidate(opts: {
  chapters: ChapterSpan[];
  actualDurationSec: number | null;
  expectedRuntimeMin: number | null;
  nextEpisodeDurationSec?: number | null | undefined;
}): SegmentRepairCandidate {
  const shape = longPairedShape(opts);
  if ("kind" in shape) return shape;

  const { intro, firstAct, secondAct, outro, tailEndSec, durations } = shape;
  const secondDur = secondAct.endSec - secondAct.startSec;

  const keepRanges = [
    { startSec: firstAct.startSec, endSec: firstAct.endSec },
    { startSec: outro.startSec, endSec: tailEndSec },
  ];
  const dropRanges = [
    { startSec: intro.startSec, endSec: intro.endSec },
    { startSec: secondAct.startSec, endSec: secondAct.endSec },
  ];

  if (opts.nextEpisodeDurationSec !== null && opts.nextEpisodeDurationSec !== undefined) {
    const delta = Math.abs(opts.nextEpisodeDurationSec - secondDur);
    if (delta > THRESHOLDS.nextEpisodeMatchToleranceSec) {
      return {
        kind: "not-candidate",
        confidence: "medium",
        evidence: `next file duration ${fmt(opts.nextEpisodeDurationSec)} is not close to dropped act ${fmt(secondDur)}`,
        policy: null,
        keepRanges: [],
        dropRanges: [],
      };
    }
  }

  const nextEvidence = opts.nextEpisodeDurationSec !== undefined && opts.nextEpisodeDurationSec !== null
    ? `; next file duration ${fmt(opts.nextEpisodeDurationSec)} is close to second act ${fmt(secondDur)}`
    : "; next-file identity requires preview confirmation";
  return {
    kind: "paired-duplicate-candidate",
    confidence: "medium",
    evidence: `long file with intro + 2 act-sized chapters + outro (${durations.join("|")})${nextEvidence}`,
    policy: "segment-plus-outro-no-intro",
    keepRanges,
    dropRanges,
  };
}

/**
 * Detect the Season-3 shape: a long paired file whose second act has no
 * sibling even-episode file in the archive. Unlike
 * detectSegmentRepairCandidate this does not require (and ignores) the next
 * episode's duration, because the even file is expected to be missing.
 */
export function detectSplitPairedCandidate(opts: {
  chapters: ChapterSpan[];
  actualDurationSec: number | null;
  expectedRuntimeMin: number | null;
}): SegmentRepairCandidate {
  const shape = longPairedShape(opts);
  if ("kind" in shape) return shape;

  const { intro, firstAct, secondAct, outro, tailEndSec, durations } = shape;
  const splitOutputs: SplitOutputRanges = {
    oddKeep: [
      { startSec: firstAct.startSec, endSec: firstAct.endSec },
      { startSec: outro.startSec, endSec: tailEndSec },
    ],
    evenKeep: [
      { startSec: secondAct.startSec, endSec: secondAct.endSec },
      { startSec: outro.startSec, endSec: tailEndSec },
    ],
  };
  return {
    kind: "paired-split-candidate",
    confidence: "medium",
    evidence: `long file with intro + 2 act-sized chapters + outro (${durations.join("|")}); even episode must be created from the second act`,
    policy: "split-paired-episode",
    keepRanges: splitOutputs.oddKeep,
    dropRanges: [{ startSec: intro.startSec, endSec: intro.endSec }],
    splitOutputs,
  };
}
