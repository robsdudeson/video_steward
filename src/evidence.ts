import fs from "node:fs/promises";
import path from "node:path";
import { probeChapters } from "./ffmpeg.js";
import type { Classification } from "./chapters.js";
import { classifyFile, spansToDurations } from "./chapters.js";
import { scanDiscFolder } from "./intake.js";
import { toMediaToolPath } from "./paths.js";

/** One evidence row per ripped file. */
export interface EvidenceRow {
  file: string;
  /** t-number parsed from the *_tNN.mkv filename suffix, or null when absent. */
  tNumber: number | null;
  durationSec: number | null;
  sizeBytes: number;
  /** true when the file's mtime is inside the freshness window (possibly still writing). */
  fresh: boolean;
  classification: Classification;
}

export interface DiscEvidence {
  discName: string;
  rows: EvidenceRow[];
  gapWarnings: string[];
}

/** Parse the t-number from a MakeMKV-style filename like D2_t08.mkv. */
export function parseTNumber(file: string): number | null {
  const m = /_t(\d+)\.mkv$/i.exec(file);
  if (!m || m[1] === undefined) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : null;
}

/** true when mtimeMs is within windowMin minutes before nowMs. */
export function isFresh(mtimeMs: number, nowMs: number, windowMin: number): boolean {
  return nowMs - mtimeMs < windowMin * 60_000 && nowMs - mtimeMs >= 0;
}

/** Sort rows by t-number ascending; files without a t-number go last (filename order). */
export function sortEvidenceRows(rows: EvidenceRow[]): EvidenceRow[] {
  return [...rows].sort((a, b) => {
    if (a.tNumber !== null && b.tNumber !== null && a.tNumber !== b.tNumber) {
      return a.tNumber - b.tNumber;
    }
    if (a.tNumber === null && b.tNumber === null) return a.file.localeCompare(b.file);
    if (a.tNumber === null) return 1;
    return -1;
  });
}

/** Report missing t-numbers within a disc's observed set, e.g. [0,1,3] -> ["t02"]. */
export function findTgaps(tNumbers: number[]): string[] {
  const present = new Set(tNumbers.filter((n) => n !== null));
  if (present.size < 2) return [];
  const max = Math.max(...present);
  const gaps: string[] = [];
  for (let t = 0; t <= max; t++) {
    if (!present.has(t)) gaps.push(`t${String(t).padStart(2, "0")}`);
  }
  return gaps;
}

export interface CollectEvidenceOpts {
  discName: string;
  /** Host path of the disc folder (readable by Node fs). */
  folder: string;
  ffprobeBin?: string;
  freshWindowMin: number;
  nowMs?: number;
}

/**
 * Scan a disc folder and build ordered evidence rows with chapter-based
 * classification, freshness flags, and t-gap warnings.
 */
export async function collectDiscEvidence(opts: CollectEvidenceOpts): Promise<DiscEvidence> {
  const nowMs = opts.nowMs ?? Date.now();
  const scanned = await scanDiscFolder(opts.folder, opts.ffprobeBin ? { ffprobeBin: opts.ffprobeBin } : undefined);

  const rows: EvidenceRow[] = [];
  for (const s of scanned) {
    const full = path.join(opts.folder, s.file);
    let mtimeMs = 0;
    try {
      mtimeMs = (await fs.stat(full)).mtimeMs;
    } catch {
      /* stat failed; treat as not fresh */
    }

    let durations: number[] = [];
    if (opts.ffprobeBin) {
      try {
        const spans = await probeChapters(opts.ffprobeBin, toMediaToolPath(full));
        durations = spansToDurations(spans);
      } catch {
        durations = []; // chapter probe failed; classification degrades to unknown
      }
    }

    rows.push({
      file: s.file,
      tNumber: parseTNumber(s.file),
      durationSec: s.durationSec,
      sizeBytes: s.sizeBytes,
      fresh: isFresh(mtimeMs, nowMs, opts.freshWindowMin),
      classification: classifyFile(durations, s.durationSec),
    });
  }

  const sorted = sortEvidenceRows(rows);
  const gapWarnings = findTgaps(sorted.map((r) => r.tNumber).filter((n): n is number => n !== null)).map(
    (t) => `[${opts.discName}] missing ${t} in t-number sequence`,
  );

  return { discName: opts.discName, rows: sorted, gapWarnings };
}
