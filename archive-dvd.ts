#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { resolveShareBackend } from "./src/copy.js";
import { buildManifestView, ConfigError, loadConfig, validateManifest } from "./src/config.js";
import { appendDiscToManifest, formatDuration, formatSize, renderStarterTOML, scanDiscFolder } from "./src/intake.js";
import { Logger } from "./src/logger.js";
import { fetchSeason, loadApiKey, MetadataError, searchShows } from "./src/metadata.js";
import { attachEvidence, buildPlan, execute, findUnmappedFiles } from "./src/plan.js";
import { detectRuntime, resolveBinary, resolveConfiguredPath, runPreflight } from "./src/paths.js";

const program = new Command();

program
  .name("video-steward")
  .description(
    "Steward for DVD-rip archives: scan discs, map titles to episodes, remux MKV to MP4, copy to a media share.",
  )
  .version("0.1.0");

interface CommonOpts {
  config: string;
}

// ---------------------------------------------------------------------------
// scan <folder> — print starter TOML for a newly extracted disc folder
// ---------------------------------------------------------------------------
program
  .command("scan")
  .description("Inspect a newly extracted DVD folder and print starter TOML")
  .argument("<folder>", "disc folder containing .mkv files")
  .option("--config <path>", "manifest path (only used to locate ffprobe config)", "archive-dvd.toml")
  .action(async (folder: string, opts: CommonOpts) => {
    const ffprobe = resolveBinary("ffprobe.exe") ?? resolveBinary("ffprobe");
    if (!ffprobe) {
      console.error("ffprobe not found on PATH; install ffmpeg or set paths.ffprobe in the manifest.");
      process.exit(1);
    }
    const files = await scanDiscFolder(path.resolve(folder), { ffprobeBin: ffprobe });
    if (files.length === 0) {
      console.error(`No .mkv files found in ${folder}`);
      process.exit(1);
    }
    console.log(renderStarterTOML(path.basename(path.resolve(folder)), files));
  });

// ---------------------------------------------------------------------------
// append-disc <folder> — add a starter [disc.NAME] section to the manifest
// ---------------------------------------------------------------------------
program
  .command("append-disc")
  .description("Append a starter [disc.NAME] section (episode numbers = 0 TODO) to the manifest")
  .argument("<folder>", "disc folder containing .mkv files")
  .option("--config <path>", "manifest path", "archive-dvd.toml")
  .action(async (folder: string, opts: CommonOpts) => {
    const ffprobe = resolveBinary("ffprobe.exe") ?? resolveBinary("ffprobe");
    if (!ffprobe) {
      console.error("ffprobe not found on PATH; install ffmpeg or set paths.ffprobe in the manifest.");
      process.exit(1);
    }
    const abs = path.resolve(folder);
    const files = await scanDiscFolder(abs, { ffprobeBin: ffprobe });
    if (files.length === 0) {
      console.error(`No .mkv files found in ${folder}`);
      process.exit(1);
    }
    const block = renderStarterTOML(path.basename(abs), files);
    await appendDiscToManifest(path.resolve(opts.config), path.basename(abs), block);
    console.log(`Appended [disc.${path.basename(abs)}] to ${opts.config}:\n\n${block}`);
  });

// ---------------------------------------------------------------------------
// search <query> — resolve a TMDb show ID
// ---------------------------------------------------------------------------
program
  .command("search")
  .description("Search TMDb shows and print candidate IDs for show.tmdb_id")
  .argument("<query>", "show name to search for")
  .option("--config <path>", "manifest path (locates .env)", "archive-dvd.toml")
  .action(async (query: string, opts: CommonOpts) => {
    const configDir = path.dirname(path.resolve(opts.config));
    let key: string;
    try {
      key = loadApiKey(configDir);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
    const hits = await searchShows(key, query);
    if (hits.length === 0) {
      console.error(`No TMDb results for "${query}"`);
      process.exit(1);
    }
    for (const h of hits.slice(0, 10)) {
      console.log(`${String(h.id).padStart(6)}  ${h.name}${h.year ? ` (${h.year})` : ""}  [${h.voteAverage.toFixed(1)}]`);
    }
    console.error("\nSet show.tmdb_id in the manifest to one of the IDs above.");
  });

// ---------------------------------------------------------------------------
// default action — validate + dry-run or execute
// ---------------------------------------------------------------------------
program
  .option("--config <path>", "TOML manifest path", "archive-dvd.toml")
  .option("--dry-run", "print planned work without converting or copying")
  .option("--only <disc>", "process only one disc section (e.g. ARM_S1_D1)")
  .option("--force", "rebuild even if local or destination output exists")
  .option("--skip-copy", "convert locally but do not copy to destination")
  .option("--fail-fast", "stop on first item failure (default: continue)")
  .action(async (opts: { config: string; dryRun?: boolean; only?: string; force?: boolean; skipCopy?: boolean; failFast?: boolean }) => {
    const log = new Logger(path.join(path.dirname(path.resolve(opts.config)), "archive-dvd.log"));
    try {
      // 1-2. Load + validate config shape
      const { config, configDir } = loadConfig(opts.config);

      // Manifest-level validation (TODOs, duplicates, bad filenames) — no network needed
      const view0 = buildManifestView(config);
      const manifestErrors = validateManifest(view0);
      if (manifestErrors.length > 0) {
        for (const e of manifestErrors) log.error(e);
        log.error("Fix the manifest above, or run `scan`/`append-disc` for new discs.");
        process.exit(1);
      }

      // 4. Environment preflight
      const runtime = detectRuntime();
      const sourceRoot = resolveConfiguredPath(config.paths.source_root, configDir, runtime);
      const localOutput = resolveConfiguredPath(config.paths.local_output, configDir, runtime);
      const destRoot = resolveConfiguredPath(config.paths.destination_root, configDir, runtime);
      const backend = resolveShareBackend(config.share.backend, destRoot);
      const preflight = runPreflight({
        sourceRoot,
        localOutput,
        destinationRoot: destRoot,
        ffmpegBin: config.paths.ffmpeg,
        ffprobeBin: config.paths.ffprobe,
        skipCopy: !!opts.skipCopy,
        dryRun: !!opts.dryRun,
        shareBackend: backend,
      });
      if (!preflight.ok) {
        for (const p of preflight.problems) log.error(p);
        process.exit(1);
      }

      // 3 + 5. TMDb metadata (only when a show ID is configured)
      let seasonMeta = null;
      if (config.show.tmdb_id > 0) {
        const key = loadApiKey(configDir);
        log.info(`Fetching TMDb season ${config.show.season} for show ${config.show.tmdb_id}...`);
        seasonMeta = await fetchSeason(key, config.show.tmdb_id, config.show.season);
      } else if (Object.keys(config.title_override ?? {}).length === 0) {
        log.error("show.tmdb_id is 0 and no title overrides exist. Run `video-steward search <name>` to find the ID.");
        process.exit(1);
      }

      // 6-7. Unmapped file check + work list
      const runOpts = { config, configDir, dryRun: !!opts.dryRun, only: opts.only, force: !!opts.force, skipCopy: !!opts.skipCopy, failFast: !!opts.failFast };
      const plan = buildPlan(runOpts, seasonMeta);
      if (plan.problems.length > 0) {
        for (const p of plan.problems) log.error(p);
        process.exit(1);
      }

      const ignored = new Map<string, Set<string>>();
      for (const [d, m] of Object.entries(config.ignore ?? {})) ignored.set(d, new Set(Object.keys(m)));
      const unmapped = await findUnmappedFiles(plan.roots, runOpts, ignored);
      if (unmapped.length > 0) {
        for (const u of unmapped) log.error(`Unmapped file ${u}: add it to [disc.${u.split("/")[0]}] or [ignore.${u.split("/")[0]}]`);
        process.exit(1);
      }

      // 9. Evidence
      const ffprobeBin = preflight.info.ffprobe;
      if (!ffprobeBin) {
        log.error("ffprobe resolved during preflight but is unavailable; aborting.");
        process.exit(1);
      }
      await attachEvidence(plan.items, ffprobeBin, log);

      // 10. Table
      if (!opts.skipCopy) log.info(`Destination copy via ${backend} backend`);
      printTable(plan);

      if (opts.dryRun) {
        log.info(`Dry run complete: ${plan.items.length} item(s) ready. Rerun without --dry-run to convert.`);
        return;
      }

      // Execute
      const ffmpegBin = preflight.info.ffmpeg;
      if (!ffmpegBin) {
        log.error("ffmpeg resolved during preflight but is unavailable; aborting.");
        process.exit(1);
      }
      const summary = await execute(runOpts, plan.items, { ffmpeg: ffmpegBin, ffprobe: ffprobeBin }, log, backend);
      log.info(
        `Done. converted=${summary.converted} skipped=${summary.skipped} copied=${summary.copied} copy-skipped=${summary.copySkipped} failed=${summary.failed}`,
      );
      if (summary.failed > 0) {
        for (const f of summary.failures) log.error(f);
        process.exit(1);
      }
    } catch (err) {
      if (err instanceof ConfigError || err instanceof MetadataError) {
        log.error(err.message);
      } else {
        log.error((err as Error).stack ?? (err as Error).message);
      }
      process.exit(1);
    } finally {
      log.flush();
    }
  });

function printTable(plan: { items: import("./src/plan.js").WorkItem[]; roots: import("./src/plan.js").PlanRoots }) {
  console.log("");
  console.log(`Source root:      ${plan.roots.sourceRoot}`);
  console.log(`Local staging:    ${plan.roots.localOutput}`);
  console.log(`Destination root: ${plan.roots.destRoot}`);
  console.log("");
  for (const item of plan.items) {
    const size = item.sizeBytes !== null ? formatSize(item.sizeBytes) : "?";
    const dur = item.durationSec !== null ? formatDuration(item.durationSec) : "?";
    console.log(`${item.disc}/${item.file}   (${size}, ${dur}${item.streamNote ? `, ${item.streamNote}` : ""})`);
    console.log(`  -> Ep ${String(item.episode).padStart(2, "0")}  "${item.title?.title}" [${item.title?.source}]`);
    const relLocal = path.relative(process.cwd(), item.localOut);
    console.log(`     local: ${relLocal.startsWith("..") ? item.localOut : relLocal}`);
    console.log(`     dest:  ${item.destPath}`);
  }
  console.log("");
}

program.parse(process.argv);
