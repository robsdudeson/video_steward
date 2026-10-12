import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { detectSegmentRepairCandidate, type ChapterRange, type SegmentRepairCandidate } from "./chapters.js";
import { probeChapters, probeMedia } from "./ffmpeg.js";
import { formatDuration, formatSize } from "./intake.js";
import { fetchSeason, loadApiKey, type SeasonMeta } from "./metadata.js";
import { mediaFsForPath, type MediaFileEntry } from "./media-fs.js";
import { toMediaToolPath } from "./paths.js";

export interface ParsedEpisodeFile {
  showName: string;
  season: number;
  episode: number;
  title: string;
}

export interface AuditRow {
  file: string;
  fullPath: string;
  sizeBytes: number;
  parsed: ParsedEpisodeFile | null;
  durationSec: number | null;
  chapters: ChapterRange[];
  formatTags: Record<string, string>;
  tmdbTitle: string | null;
  tmdbRuntimeMin: number | null;
  titleStatus: "ok" | "warning" | "unknown";
  runtimeStatus: "ok" | "long" | "short" | "unknown";
  warnings: string[];
  repair: SegmentRepairCandidate | null;
}

export interface SeasonAuditResult {
  folder: string;
  rows: AuditRow[];
  warnings: string[];
  tmdbNote: string | null;
}

export interface RunSeasonAuditOpts {
  folder: string;
  ffprobeBin: string;
  config: AppConfig | null;
  configDir: string;
  seasonOverride: number | null;
  requireMetadata: boolean;
  runtimeToleranceMin: number;
  longDeltaMin: number;
}

const FILENAME_RE = /^(.*) - S(\d{2})E(\d{2}) - (.*)\.mp4$/i;

export function parseEpisodeFileName(file: string): ParsedEpisodeFile | null {
  const m = FILENAME_RE.exec(file);
  if (!m || !m[1] || !m[2] || !m[3] || !m[4]) return null;
  return {
    showName: m[1],
    season: Number(m[2]),
    episode: Number(m[3]),
    title: m[4],
  };
}

export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function compareTitle(fileTitle: string, tmdbTitle: string | null): "ok" | "warning" | "unknown" {
  if (!tmdbTitle) return "unknown";
  return normalizeTitle(fileTitle) === normalizeTitle(tmdbTitle) ? "ok" : "warning";
}

function compareRuntime(actualSec: number | null, expectedMin: number | null, toleranceMin: number, longDeltaMin: number): "ok" | "long" | "short" | "unknown" {
  if (actualSec === null || expectedMin === null) return "unknown";
  const actualMin = actualSec / 60;
  const delta = actualMin - expectedMin;
  if (delta > longDeltaMin) return "long";
  if (delta < -toleranceMin) return "short";
  return "ok";
}

async function loadSeasonMeta(opts: RunSeasonAuditOpts): Promise<{ meta: SeasonMeta | null; note: string | null }> {
  if (!opts.config || opts.config.show.tmdb_id <= 0) {
    if (opts.requireMetadata) throw new Error("TMDb metadata required but no show.tmdb_id is configured");
    return { meta: null, note: "TMDb comparison skipped: no manifest metadata" };
  }
  const season = opts.seasonOverride ?? opts.config.show.season;
  try {
    const key = loadApiKey(opts.configDir);
    return { meta: await fetchSeason(key, opts.config.show.tmdb_id, season), note: null };
  } catch (err) {
    if (opts.requireMetadata) throw err;
    return { meta: null, note: `TMDb comparison skipped: ${(err as Error).message}` };
  }
}

export async function runSeasonAudit(opts: RunSeasonAuditOpts): Promise<SeasonAuditResult> {
  const mediaFs = mediaFsForPath(opts.folder);
  const [entries, metaResult] = await Promise.all([
    mediaFs.listFiles(opts.folder, ".mp4"),
    loadSeasonMeta(opts),
  ]);
  const rows: AuditRow[] = [];
  const warnings: string[] = [];
  if (entries.length === 0) warnings.push(`No .mp4 files found in ${opts.folder}`);

  const partialRows: Array<{ entry: MediaFileEntry; parsed: ParsedEpisodeFile | null; durationSec: number | null; chapters: ChapterRange[]; formatTags: Record<string, string>; tmdbTitle: string | null; tmdbRuntimeMin: number | null; titleStatus: "ok" | "warning" | "unknown"; runtimeStatus: "ok" | "long" | "short" | "unknown"; warnings: string[] }> = [];
  for (const entry of entries) {
    const parsed = parseEpisodeFileName(entry.name);
    const rowWarnings: string[] = [];
    if (!parsed) rowWarnings.push("filename does not match 'Show Name - SNNENN - Title.mp4'");

    let durationSec: number | null = null;
    let formatTags: Record<string, string> = {};
    let chapters: ChapterRange[] = [];
    try {
      const probe = await probeMedia(opts.ffprobeBin, toMediaToolPath(entry.fullPath));
      durationSec = probe.durationSec;
      formatTags = probe.formatTags ?? {};
      chapters = (await probeChapters(opts.ffprobeBin, toMediaToolPath(entry.fullPath))).map((c) => ({ startSec: c.startSec, endSec: c.endSec }));
    } catch (err) {
      rowWarnings.push(`ffprobe failed: ${(err as Error).message}`);
    }

    const epMeta = parsed ? metaResult.meta?.episodes.get(parsed.episode) : undefined;
    const overrideTitle = parsed ? titleOverrideFor(opts.config, parsed.episode) : null;
    const tmdbTitle = overrideTitle ?? epMeta?.name ?? null;
    const tmdbRuntimeMin = epMeta?.runtimeMin ?? null;
    const titleStatus = parsed ? compareTitle(parsed.title, tmdbTitle) : "unknown";
    const runtimeStatus = compareRuntime(durationSec, tmdbRuntimeMin, opts.runtimeToleranceMin, opts.longDeltaMin);
    if (titleStatus === "warning") rowWarnings.push(`title differs from TMDb: ${parsed?.title} vs ${tmdbTitle}`);
    if (runtimeStatus === "long") rowWarnings.push(`runtime ${formatDuration(durationSec)} is longer than expected ${tmdbRuntimeMin}m`);
    if (runtimeStatus === "short") rowWarnings.push(`runtime ${formatDuration(durationSec)} is shorter than expected ${tmdbRuntimeMin}m`);
    if (Object.keys(formatTags).filter((k) => ["title", "show", "season_number", "episode_id"].includes(k.toLowerCase())).length === 0) {
      rowWarnings.push("embedded episode metadata tags not detected");
    }

    partialRows.push({ entry, parsed, durationSec, chapters, formatTags, tmdbTitle, tmdbRuntimeMin, titleStatus, runtimeStatus, warnings: rowWarnings });
  }

  for (const row of partialRows) {
    const next = row.parsed ? partialRows.find((r) => r.parsed?.episode === row.parsed!.episode + 1) : undefined;
    const repair = row.runtimeStatus === "long"
      ? detectSegmentRepairCandidate({
        chapters: row.chapters,
        actualDurationSec: row.durationSec,
        expectedRuntimeMin: row.tmdbRuntimeMin,
        nextEpisodeDurationSec: next?.durationSec,
      })
      : null;
    rows.push({
      file: row.entry.name,
      fullPath: row.entry.fullPath,
      sizeBytes: row.entry.sizeBytes,
      parsed: row.parsed,
      durationSec: row.durationSec,
      chapters: row.chapters,
      formatTags: row.formatTags,
      tmdbTitle: row.tmdbTitle,
      tmdbRuntimeMin: row.tmdbRuntimeMin,
      titleStatus: row.titleStatus,
      runtimeStatus: row.runtimeStatus,
      warnings: row.warnings,
      repair,
    });
  }

  return { folder: opts.folder, rows, warnings, tmdbNote: metaResult.note };
}

function titleOverrideFor(_config: AppConfig | null, _episode: number): string | null {
  // Archive-season files no longer know their source disc/file mapping, so
  // manifest overrides cannot be applied reliably until a future sidecar maps
  // archived files back to source entries. Keep the function explicit so the
  // audit contract is visible instead of silently pretending overrides apply.
  return null;
}

export function renderSeasonAuditReport(result: SeasonAuditResult): string {
  const lines: string[] = [`Season audit: ${result.folder}`];
  if (result.tmdbNote) lines.push(result.tmdbNote);
  for (const w of result.warnings) lines.push(`WARNING: ${w}`);
  lines.push("");
  lines.push("Ep  Runtime   DB    Status  Title");
  for (const row of result.rows) {
    const ep = row.parsed ? String(row.parsed.episode).padStart(2, "0") : "--";
    const db = row.tmdbRuntimeMin === null ? "--" : `${row.tmdbRuntimeMin}m`;
    const title = row.parsed?.title ?? row.file;
    const repair = row.repair?.kind === "paired-duplicate-candidate" ? "  [repair candidate]" : "";
    lines.push(`${ep}  ${formatDuration(row.durationSec)}  ${db.padEnd(5)} ${row.runtimeStatus.toUpperCase().padEnd(7)} ${title}${repair}`);
    for (const w of row.warnings) lines.push(`    - ${w}`);
    if (row.repair?.kind === "paired-duplicate-candidate") lines.push(`    - ${row.repair.evidence}; requires preview/approval`);
  }
  return lines.join("\n");
}

export interface RepairPlanItem {
  episode: number;
  title: string;
  source: string;
  outputName: string;
  keepRanges: ChapterRange[];
  dropRanges: ChapterRange[];
  expectedDurationSec: number;
  evidence: string;
  confidence: string;
}

export interface RepairPlanDoc {
  version: 1;
  policy: "segment-plus-outro-no-intro";
  approved_for_staging: boolean;
  approved_for_apply: boolean;
  source_folder: string;
  created_at: string;
  checklist: string[];
  items: RepairPlanItem[];
}

export function buildRepairPlan(result: SeasonAuditResult): RepairPlanDoc {
  const items = result.rows.flatMap((row): RepairPlanItem[] => {
    if (row.repair?.kind !== "paired-duplicate-candidate" || !row.parsed) return [];
    const expectedDurationSec = row.repair.keepRanges.reduce((sum, r) => sum + (r.endSec - r.startSec), 0);
    return [{
      episode: row.parsed.episode,
      title: row.parsed.title,
      source: row.fullPath,
      outputName: row.file.replace(/\.mp4$/i, ".TEST.mp4"),
      keepRanges: row.repair.keepRanges,
      dropRanges: row.repair.dropRanges,
      expectedDurationSec,
      evidence: row.repair.evidence,
      confidence: row.repair.confidence,
    }];
  });
  return {
    version: 1,
    policy: "segment-plus-outro-no-intro",
    approved_for_staging: false,
    approved_for_apply: false,
    source_folder: result.folder,
    created_at: new Date().toISOString(),
    checklist: [
      "Confirm the policy matches known-good files for this season.",
      "Preview each candidate and confirm dropped act content exists in the following episode file.",
      "Set approved_for_staging=true only after reviewing this plan.",
      "Set approved_for_apply=true only after spot-checking staged outputs.",
    ],
    items,
  };
}

export async function emitRepairPlan(plan: RepairPlanDoc, target: string, force: boolean): Promise<void> {
  try {
    await fs.access(target);
    if (!force) throw new Error(`${target} already exists; refusing to overwrite (use --force)`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await fs.mkdir(path.dirname(path.resolve(target)), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
}

export { formatDuration, formatSize };
