import fs from "node:fs/promises";
import path from "node:path";
import { AppConfig, buildManifestView, DiscItem, ManifestView } from "./config.js";
import { copyFinal } from "./copy.js";
import { cleanupTempIfEmpty, FfmpegError, probeMedia, remuxToTmp } from "./ffmpeg.js";
import { Logger } from "./logger.js";
import { outputFileName, showSeasonDir } from "./naming.js";
import { ResolvedTitle, SeasonMeta, resolveEpisodeTitle } from "./metadata.js";
import { assertContained, detectRuntime, resolveConfiguredPath, toMediaToolPath } from "./paths.js";

export interface RunOptions {
  config: AppConfig;
  configDir: string;
  dryRun: boolean;
  only?: string | undefined;
  force: boolean;
  skipCopy: boolean;
  failFast: boolean;
}

export interface WorkItem extends DiscItem {
  srcPath: string;
  localOut: string;
  destPath: string;
  title: ResolvedTitle | null;
  sizeBytes: number | null;
  durationSec: number | null;
  streamNote: string | null;
}

export interface PlanRoots {
  sourceRoot: string;
  localOutput: string;
  destRoot: string;
}

export interface PlanResult {
  items: WorkItem[];
  problems: string[];
  roots: PlanRoots;
  view: ManifestView;
}

function emptySeason(config: AppConfig): SeasonMeta {
  return { tmdbId: config.show.tmdb_id, season: config.show.season, episodes: new Map() };
}

/** Resolve all configured roots and build the per-item work list. */
export function buildPlan(opts: RunOptions, seasonMeta: SeasonMeta | null): PlanResult {
  const { config, configDir } = opts;
  const runtime = detectRuntime();
  const problems: string[] = [];

  let sourceRoot: string;
  let localOutput: string;
  let destRoot: string;
  try {
    sourceRoot = resolveConfiguredPath(config.paths.source_root, configDir, runtime);
    localOutput = resolveConfiguredPath(config.paths.local_output, configDir, runtime);
    destRoot = resolveConfiguredPath(config.paths.destination_root, configDir, runtime);
  } catch (err) {
    return { items: [], problems: [(err as Error).message], roots: { sourceRoot: "", localOutput: "", destRoot: "" }, view: buildManifestView(config) };
  }

  const view = buildManifestView(config);
  const filtered = opts.only ? view.items.filter((i) => i.disc === opts.only) : view.items;

  const items: WorkItem[] = [];
  for (const item of filtered) {
    let srcPath: string;
    try {
      const discDir = path.join(sourceRoot, item.disc);
      assertContained(discDir, sourceRoot, "disc folder");
      srcPath = path.join(discDir, item.file);
      assertContained(srcPath, sourceRoot, "source file");
    } catch (err) {
      problems.push(`[${item.disc}] "${item.file}": ${(err as Error).message}`);
      continue;
    }

    let title: ResolvedTitle | null = null;
    const override = view.overrides.get(item.disc)?.get(item.file);
    try {
      if (seasonMeta || override) {
        title = resolveEpisodeTitle({
          seasonMeta: seasonMeta ?? emptySeason(config),
          episode: item.episode,
          override,
        });
      } else {
        problems.push(
          `[${item.disc}] "${item.file}": TMDb metadata unavailable (show.tmdb_id not set?) and no title override`,
        );
      }
    } catch (err) {
      problems.push(`[${item.disc}] "${item.file}": ${(err as Error).message}`);
    }
    if (!title) continue;

    let localOut: string;
    let destPath: string;
    try {
      const relOut = path.join(
        showSeasonDir(config.show.name, config.show.season),
        outputFileName(config.show.name, config.show.season, item.episode, title.title),
      );
      localOut = path.join(localOutput, relOut);
      assertContained(localOut, localOutput, "local output");
      destPath = path.join(destRoot, relOut);
      assertContained(destPath, destRoot, "destination");
    } catch (err) {
      problems.push(`[${item.disc}] "${item.file}": ${(err as Error).message}`);
      continue;
    }

    items.push({ ...item, srcPath, localOut, destPath, title, sizeBytes: null, durationSec: null, streamNote: null });
  }

  return { items, problems, roots: { sourceRoot, localOutput, destRoot }, view };
}

/** Find .mkv files on disk that are neither mapped nor ignored. */
export async function findUnmappedFiles(
  roots: PlanRoots,
  opts: RunOptions,
  ignored: Map<string, Set<string>>,
): Promise<string[]> {
  const unmapped: string[] = [];
  for (const disc of Object.keys(opts.config.disc).sort()) {
    if (opts.only && disc !== opts.only) continue;
    const discDir = path.join(roots.sourceRoot, disc);
    let entries: string[];
    try {
      entries = await fs.readdir(discDir);
    } catch {
      continue; // missing folder is reported by the preflight/item checks
    }
    const mapped = new Set(Object.keys(opts.config.disc[disc] ?? {}));
    const ignoredSet = ignored.get(disc) ?? new Set<string>();
    for (const f of entries.sort()) {
      if (!f.toLowerCase().endsWith(".mkv")) continue;
      if (mapped.has(f) || ignoredSet.has(f)) continue;
      unmapped.push(`${disc}/${f}`);
    }
  }
  return unmapped;
}

/** Attach size + duration + stream evidence to work items. */
export async function attachEvidence(items: WorkItem[], ffprobeBin: string, log: Logger): Promise<void> {
  const runtime = detectRuntime();
  for (const item of items) {
    try {
      item.sizeBytes = (await fs.stat(item.srcPath)).size;
    } catch {
      item.streamNote = "source file missing";
      continue;
    }
    try {
      const probe = await probeMedia(ffprobeBin, toMediaToolPath(item.srcPath, runtime));
      item.durationSec = probe.durationSec;
      const v = probe.streams.filter((s) => s.codecType === "video")[0];
      const a = probe.streams.filter((s) => s.codecType === "audio").length;
      const s = probe.streams.filter((x) => x.codecType === "subtitle").length;
      item.streamNote = v ? `${v.codecName} video, ${a} audio, ${s} subtitle` : "no video stream";
    } catch (err) {
      log.warn(`ffprobe failed for ${item.srcPath}: ${(err as Error).message}`);
      item.streamNote = "probe failed";
    }
  }
}

export interface Summary {
  converted: number;
  skipped: number;
  copied: number;
  copySkipped: number;
  failed: number;
  failures: string[];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Execute the work list and return summary counts. */
export async function execute(
  opts: RunOptions,
  items: WorkItem[],
  bins: { ffmpeg: string; ffprobe: string },
  log: Logger,
): Promise<Summary> {
  const summary: Summary = { converted: 0, skipped: 0, copied: 0, copySkipped: 0, failed: 0, failures: [] };
  const runtime = detectRuntime();
  const mediaPath = (p: string) => toMediaToolPath(p, runtime);

  const season = opts.config.show.season;
  for (const item of items) {
    const label = `[${item.disc}] ${item.file} -> S${String(season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}`;
    try {
      let localExists = await pathExists(item.localOut);

      if (!localExists) {
        const tmp = `${item.localOut}.tmp.mp4`;
        await fs.mkdir(path.dirname(item.localOut), { recursive: true });
        log.info(`${label} converting...`);
        try {
          const result = await remuxToTmp({
            ffmpegBin: bins.ffmpeg,
            ffprobeBin: bins.ffprobe,
            mediaToolPath: mediaPath,
            input: item.srcPath,
            outputTmp: tmp,
          });
          if (opts.force && (await pathExists(item.localOut))) {
            await fs.unlink(item.localOut);
          }
          await fs.rename(tmp, item.localOut);
          summary.converted++;
          for (const s of result.skipped) {
            log.warn(`${label} dropped ${s.codecType} stream (${s.codecName}): ${s.reason}`);
          }
        } catch (err) {
          await cleanupTempIfEmpty(tmp);
          throw err;
        }
      } else if (!opts.force) {
        log.info(`${label} local output exists, reusing (use --force to rebuild)`);
      }

      if (opts.skipCopy) {
        summary.copySkipped++;
        continue;
      }

      const copy = await copyFinal({
        src: item.localOut,
        destDir: path.dirname(item.destPath),
        fileName: path.basename(item.destPath),
        force: opts.force,
      });
      if (copy.status === "skipped-existing") {
        summary.skipped++;
        log.info(`${label} destination already exists, skipped`);
      } else {
        summary.copied++;
        log.info(`${label} copied to ${item.destPath}`);
      }
    } catch (err) {
      summary.failed++;
      const msg = `${label} FAILED: ${(err as Error).message}`;
      summary.failures.push(msg);
      log.error(msg);
      if (opts.failFast) break;
    }
  }

  return summary;
}
