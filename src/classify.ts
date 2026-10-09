import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { collectDiscEvidence, type DiscEvidence } from "./evidence.js";
import { formatDuration, formatSize } from "./intake.js";
import {
  checkSeasonCount,
  fetchSeason,
  loadApiKey,
  type SeasonCountCheck,
} from "./metadata.js";

export interface ClassifyDiscInput {
  /** [disc.NAME] key to use in the draft manifest. */
  discName: string;
  /** Resolved absolute host path of the disc folder. */
  folder: string;
}

export interface ClassifyResult {
  evidences: DiscEvidence[];
  /** `${disc}/${file}` -> assigned episode number (full/no-theme files only, in CLI order). */
  episodes: Map<string, number>;
  seasonCheck: SeasonCountCheck | null;
  seasonCheckNote: string | null;
}

/**
 * Assign episode numbers 1..N to full/no-theme rows: discs in given order,
 * rows in their (t-)order. Other categories get no number — they are listed
 * for review, never guessed.
 */
export function assignEpisodes(evidences: DiscEvidence[]): Map<string, number> {
  const episodes = new Map<string, number>();
  let next = 1;
  for (const ev of evidences) {
    for (const row of ev.rows) {
      if (row.classification.category === "full" || row.classification.category === "no-theme") {
        episodes.set(`${ev.discName}/${row.file}`, next++);
      }
    }
  }
  return episodes;
}

export interface RunClassifyOpts {
  discs: ClassifyDiscInput[];
  ffprobeBin: string;
  freshWindowMin: number;
  nowMs?: number;
  /** Loaded manifest, when one exists and parsed — supplies show/paths context. */
  config: AppConfig | null;
  configDir: string;
  seasonOverride: number | null;
}

/**
 * Read-only intake analysis: scan each disc folder, classify files by chapter
 * structure, assign episode numbers to confidently-classified files in
 * t-order across discs (CLI argument order), and cross-check the count
 * against TMDb. Never touches media or manifests.
 */
export async function runClassify(opts: RunClassifyOpts): Promise<ClassifyResult> {
  const evidences: DiscEvidence[] = [];
  for (const d of opts.discs) {
    evidences.push(
      await collectDiscEvidence({
        discName: d.discName,
        folder: d.folder,
        ffprobeBin: opts.ffprobeBin,
        freshWindowMin: opts.freshWindowMin,
        ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
      }),
    );
  }

  // Episode numbering: discs in CLI order, rows already in t-order.
  const episodes = assignEpisodes(evidences);

  let seasonCheck: SeasonCountCheck | null = null;
  let seasonCheckNote: string | null = null;
  const classified = episodes.size;
  if (opts.config && opts.config.show.tmdb_id > 0) {
    const season = opts.seasonOverride ?? opts.config.show.season;
    try {
      const key = loadApiKey(opts.configDir);
      const meta = await fetchSeason(key, opts.config.show.tmdb_id, season);
      seasonCheck = checkSeasonCount(classified, meta.episodes.size);
      if (seasonCheck.verdict !== "match") {
        seasonCheckNote = seasonCheck.hint;
      }
    } catch (err) {
      seasonCheckNote = `TMDb cross-check failed: ${(err as Error).message}`;
    }
  } else {
    seasonCheckNote = "TMDb cross-check skipped: no show.tmdb_id in manifest";
  }

  return { evidences, episodes, seasonCheck, seasonCheckNote };
}

function confidenceTag(c: DiscEvidence["rows"][number]["classification"]): string {
  return `${c.category} (${c.confidence})`;
}

/** Render the human-readable report. */
export function renderReport(result: ClassifyResult, opts: { freshWindowMin: number }): string {
  const lines: string[] = [];
  for (const ev of result.evidences) {
    lines.push(`Disc ${ev.discName}`);
    for (const row of ev.rows) {
      const t = row.tNumber !== null ? `t${String(row.tNumber).padStart(2, "0")}` : "--";
      const dur = formatDuration(row.durationSec);
      const size = formatSize(row.sizeBytes);
      const ep = result.episodes.get(`${ev.discName}/${row.file}`);
      const epTag = ep !== undefined ? `  -> Ep ${String(ep).padStart(2, "0")}` : "";
      const freshTag = row.fresh ? "  [modified recently — possibly still writing]" : "";
      lines.push(`  ${t}  ${row.file.padEnd(16)} ${dur}  ${size.padStart(8)}  ${confidenceTag(row.classification)}: ${row.classification.evidence}${epTag}${freshTag}`);
    }
    for (const w of ev.gapWarnings) lines.push(`  WARNING: ${w}`);
    lines.push("");
  }

  const review = result.evidences.flatMap((ev) =>
    ev.rows
      .filter((r) => !result.episodes.has(`${ev.discName}/${r.file}`))
      .map((r) => `  - [${ev.discName}] ${r.file} — ${confidenceTag(r.classification)}: ${r.classification.evidence}`),
  );
  lines.push("Needs review (not numbered):");
  lines.push(review.length > 0 ? review.join("\n") : "  (none)");

  if (result.seasonCheck) {
    const c = result.seasonCheck;
    lines.push("");
    lines.push(
      `TMDb cross-check: ${c.classified} classified vs ${c.tmdbEpisodes} episode(s) — ${c.verdict.toUpperCase()}`,
    );
  }
  if (result.seasonCheckNote) {
    lines.push(result.seasonCheckNote);
  }
  return lines.join("\n");
}

/**
 * Render a draft manifest TOML. Numbered files become mapping entries;
 * needs-review files are emitted as comments so nothing is silently dropped.
 */
export function renderDraftTOML(result: ClassifyResult): string {
  const lines: string[] = [
    "# Draft manifest generated by `video-steward classify`.",
    "# Review every entry before archiving; episode 0 blocks conversion.",
    "",
  ];
  for (const ev of result.evidences) {
    lines.push(`[disc.${ev.discName}]`);
    for (const row of ev.rows) {
      const ep = result.episodes.get(`${ev.discName}/${row.file}`);
      if (ep !== undefined) {
        lines.push(
          `  "${row.file}" = ${ep}   # ${confidenceTag(row.classification)}: ${row.classification.evidence}; ${formatDuration(row.durationSec)}`,
        );
      } else {
        lines.push(`  # "${row.file}" — ${confidenceTag(row.classification)}: ${row.classification.evidence} (needs review)`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

export interface EmitDraftOpts {
  target: string;
  force: boolean;
}

/** Write the draft TOML, refusing to overwrite an existing file without force. */
export async function emitDraft(result: ClassifyResult, opts: EmitDraftOpts): Promise<void> {
  const target = path.resolve(opts.target);
  try {
    await fs.access(target);
    if (!opts.force) {
      throw new Error(`${target} already exists; refusing to overwrite (use --force)`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, renderDraftTOML(result), "utf8");
}
