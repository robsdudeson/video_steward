import type { ChapterSpan } from "./ffmpeg.js";

export type FileCategory = "full" | "no-theme" | "possible-half" | "extra" | "unknown";
export type Confidence = "high" | "medium" | "low";

export interface Classification {
  category: FileCategory;
  confidence: Confidence;
  evidence: string;
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
} as const;

/** Durations of the given chapter spans, in seconds. */
export function spansToDurations(spans: ChapterSpan[]): number[] {
  return spans.map((s) => s.endSec - s.startSec);
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
  const segs = [...chapterDurations];
  for (;;) {
    const tail = segs[segs.length - 1];
    if (tail === undefined || tail >= THRESHOLDS.stubMaxSec) break;
    segs.pop();
  }
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
