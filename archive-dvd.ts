#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { emitDraft, renderReport, runClassify, type ClassifyDiscInput } from "./src/classify.js";
import { resolveShareBackend } from "./src/copy.js";
import { buildManifestView, ConfigError, loadConfig, validateManifest } from "./src/config.js";
import { appendDiscToManifest, formatDuration, formatSize, renderStarterTOML, scanDiscFolder } from "./src/intake.js";
import { Logger } from "./src/logger.js";
import { fetchSeason, loadApiKey, MetadataError, searchShows } from "./src/metadata.js";
import { attachEvidence, buildPlan, execute, findUnmappedFiles } from "./src/plan.js";
import { readRepairPlan, stageRepairs, applyRepairs } from "./src/repair.js";
import { buildRepairPlan, emitRepairPlan, renderSeasonAuditReport, runSeasonAudit } from "./src/season-audit.js";
import { detectRuntime, resolveBinary, resolveConfiguredPath, runPreflight } from "./src/paths.js";

const program = new Command();

program
  .name("video-steward")
  .description(
    "Steward for DVD-rip archives: scan discs, map titles to episodes, remux MKV to MP4, copy to a media share.",
  )
  .version("0.1.0");

// NOTE: --config is declared once on the root program (not per subcommand).
// Commander lets a parent option shadow a same-named child option, so a local
// redeclaration would be silently ignored for `cmd ... --config X` invocations.
const rootConfig = () => String(program.opts().config ?? "archive-dvd.toml");

// ---------------------------------------------------------------------------
// scan <folder> — print starter TOML for a newly extracted disc folder
// ---------------------------------------------------------------------------
program
  .command("scan")
  .description("Inspect a newly extracted DVD folder and print starter TOML")
  .argument("<folder>", "disc folder containing .mkv files")
  .action(async (folder: string) => {
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
  .action(async (folder: string) => {
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
    const configPath = rootConfig();
    const block = renderStarterTOML(path.basename(abs), files);
    await appendDiscToManifest(path.resolve(configPath), path.basename(abs), block);
    console.log(`Appended [disc.${path.basename(abs)}] to ${configPath}:\n\n${block}`);
  });

// ---------------------------------------------------------------------------
// search <query> — resolve a TMDb show ID
// ---------------------------------------------------------------------------
program
  .command("search")
  .description("Search TMDb shows and print candidate IDs for show.tmdb_id")
  .argument("<query>", "show name to search for")
  .action(async (query: string) => {
    const configDir = path.dirname(path.resolve(rootConfig()));
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
// classify <discs...> — chapter-based intake analysis (read-only)
// ---------------------------------------------------------------------------
program
  .command("classify")
  .description(
    "Classify ripped MKV files per disc by chapter structure; print a report, optionally emit a draft manifest",
  )
  .argument("<discs...>", "disc folder names (relative to paths.source_root) or absolute paths")
  .option("--season <n>", "season number for the TMDb cross-check (overrides manifest)")
  .option("--fresh-window-min <min>", "files modified within this many minutes are flagged as possibly still writing", "10")
  .option("--emit <path>", "write a draft manifest TOML to this path")
  .option("--force", "overwrite the --emit target if it exists")
  .action(async (
    discs: string[],
    opts: { season?: string; freshWindowMin: string; emit?: string; force?: boolean },
  ) => {
    try {
      // Config is optional for classify — a missing manifest means standalone mode.
      const configPath = path.resolve(rootConfig());
      let config = null;
      let configDir = process.cwd();
      if (fs.existsSync(configPath)) {
        ({ config, configDir } = loadConfig(configPath));
      }

      const runtime = detectRuntime();
      const sourceRoot = config
        ? resolveConfiguredPath(config.paths.source_root, configDir, runtime)
        : process.cwd();

      const discInputs: ClassifyDiscInput[] = [];
      for (const arg of discs) {
        const folder = path.isAbsolute(arg) ? path.resolve(arg) : path.join(sourceRoot, arg);
        if (!fs.existsSync(folder)) {
          throw new Error(`Disc folder not found: ${folder}`);
        }
        discInputs.push({ discName: path.basename(folder), folder });
      }

      const configuredProbe = config?.paths.ffprobe ?? "ffprobe.exe";
      const ffprobeBin = resolveBinary(configuredProbe) ?? resolveBinary("ffprobe.exe") ?? resolveBinary("ffprobe");
      if (!ffprobeBin) {
        console.error("ffprobe not found on PATH; install ffmpeg or set paths.ffprobe in the manifest.");
        process.exit(1);
      }

      const freshWindowMin = Number(opts.freshWindowMin);
      if (!Number.isFinite(freshWindowMin) || freshWindowMin < 0) {
        console.error(`--fresh-window-min must be a non-negative number, got: ${opts.freshWindowMin}`);
        process.exit(1);
      }

      let seasonOverride: number | null = null;
      if (opts.season !== undefined) {
        seasonOverride = Number(opts.season);
        if (!Number.isInteger(seasonOverride) || seasonOverride <= 0) {
          console.error(`--season must be a positive integer, got: ${opts.season}`);
          process.exit(1);
        }
      }

      const result = await runClassify({
        discs: discInputs,
        ffprobeBin,
        freshWindowMin,
        config,
        configDir,
        seasonOverride,
      });
      console.log(renderReport(result, { freshWindowMin }));

      if (opts.emit) {
        await emitDraft(result, {
          target: opts.emit,
          force: !!opts.force,
          config,
          ...(seasonOverride !== null ? { seasonOverride } : {}),
        });
        console.error(`\nWrote draft manifest to ${path.resolve(opts.emit)}`);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// audit-season <folder> — read-only audit of an archived MP4 season folder
// ---------------------------------------------------------------------------
program
  .command("audit-season")
  .description("Audit an archived MP4 season folder against local evidence and optional TMDb metadata")
  .argument("<folder>", "season folder, e.g. Z:/video/shows/Show/Season 01")
  .option("--season <n>", "season number for the TMDb comparison (overrides manifest)")
  .option("--require-metadata", "fail if TMDb metadata cannot be loaded")
  .option("--runtime-tolerance-min <min>", "allowed short/normal runtime delta", "2")
  .option("--long-delta-min <min>", "delta above TMDb runtime that flags LONG", "5")
  .option("--emit-repair-plan <path>", "write a JSON repair plan for candidate paired-segment files")
  .option("--repair-policy <policy>", "repair policy to evaluate: segment-plus-outro-no-intro (default) or split-paired-episode", "segment-plus-outro-no-intro")
  .option("--json", "emit machine-readable JSON instead of text")
  .option("--force", "overwrite the --emit-repair-plan target if it exists")
  .action(async (folder: string, opts: { season?: string; requireMetadata?: boolean; runtimeToleranceMin: string; longDeltaMin: string; emitRepairPlan?: string; repairPolicy?: string; json?: boolean; force?: boolean }) => {
    try {
      const configPath = path.resolve(rootConfig());
      let config = null;
      let configDir = process.cwd();
      if (fs.existsSync(configPath)) ({ config, configDir } = loadConfig(configPath));

      let seasonOverride: number | null = null;
      if (opts.season !== undefined) {
        seasonOverride = Number(opts.season);
        if (!Number.isInteger(seasonOverride) || seasonOverride <= 0) throw new Error(`--season must be a positive integer, got: ${opts.season}`);
      }
      const runtimeToleranceMin = Number(opts.runtimeToleranceMin);
      const longDeltaMin = Number(opts.longDeltaMin);
      if (!Number.isFinite(runtimeToleranceMin) || runtimeToleranceMin < 0) throw new Error(`--runtime-tolerance-min must be non-negative, got: ${opts.runtimeToleranceMin}`);
      if (!Number.isFinite(longDeltaMin) || longDeltaMin < 0) throw new Error(`--long-delta-min must be non-negative, got: ${opts.longDeltaMin}`);

      const configuredProbe = config?.paths.ffprobe ?? "ffprobe.exe";
      const ffprobeBin = resolveBinary(configuredProbe) ?? resolveBinary("ffprobe.exe") ?? resolveBinary("ffprobe");
      if (!ffprobeBin) throw new Error("ffprobe not found on PATH; install ffmpeg or set paths.ffprobe in the manifest.");

      const repairPolicy = (opts.repairPolicy ?? "segment-plus-outro-no-intro") as import("./src/season-audit.js").RepairPolicy;
      if (!(["segment-plus-outro-no-intro", "split-paired-episode"] as const).includes(repairPolicy)) {
        throw new Error(`Unknown --repair-policy ${opts.repairPolicy}; expected segment-plus-outro-no-intro or split-paired-episode`);
      }
      const result = await runSeasonAudit({
        folder,
        ffprobeBin,
        config,
        configDir,
        seasonOverride,
        requireMetadata: !!opts.requireMetadata,
        runtimeToleranceMin,
        longDeltaMin,
        repairPolicy,
      });
      console.log(opts.json ? JSON.stringify(result, null, 2) : renderSeasonAuditReport(result));
      if (opts.emitRepairPlan) {
        const repairPlan = buildRepairPlan(result, repairPolicy);
        await emitRepairPlan(repairPlan, opts.emitRepairPlan, !!opts.force);
        const outputCount = repairPlan.items.reduce((n, i) => n + i.outputs.length, 0);
        console.error(`\nWrote ${repairPolicy} repair plan to ${path.resolve(opts.emitRepairPlan)} (${repairPlan.items.length} source item(s), ${outputCount} output action(s))`);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// repair-season — stage or apply an approved season repair plan
// ---------------------------------------------------------------------------
const repair = program.command("repair-season").description("Stage or apply an approved archived-season repair plan");

repair
  .command("stage")
  .description("Generate staged TEST outputs from a repair plan")
  .requiredOption("--plan <path>", "repair plan JSON")
  .requiredOption("--stage-dir <path>", "directory for staged TEST outputs")
  .option("--force", "overwrite existing staged outputs")
  .option("--json", "emit machine-readable JSON instead of text")
  .action(async (opts: { plan: string; stageDir: string; force?: boolean; json?: boolean }) => {
    try {
      const configPath = path.resolve(rootConfig());
      let ffmpeg = "ffmpeg.exe";
      if (fs.existsSync(configPath)) ffmpeg = loadConfig(configPath).config.paths.ffmpeg;
      const ffmpegBin = resolveBinary(ffmpeg) ?? resolveBinary("ffmpeg.exe") ?? resolveBinary("ffmpeg");
      if (!ffmpegBin) throw new Error("ffmpeg not found on PATH; install ffmpeg or set paths.ffmpeg in the manifest.");
      const plan = await readRepairPlan(opts.plan);
      const summary = await stageRepairs({ plan, stageDir: opts.stageDir, ffmpegBin, force: !!opts.force });
      if (opts.json) console.log(JSON.stringify(summary, null, 2));
      else {
        console.log(`Staged ${summary.items.length} repair output(s) in ${summary.stageDir}`);
        console.error(`Review outputs, then set approved_for_apply=true before running apply.`);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

repair
  .command("apply")
  .description("Back up originals and replace them with staged outputs")
  .requiredOption("--plan <path>", "repair plan JSON")
  .requiredOption("--stage-dir <path>", "directory containing staged TEST outputs")
  .requiredOption("--backup-root <path>", "backup root, e.g. Z:/video.bak")
  .option("--dry-run", "validate and print planned replacements without modifying files")
  .option("--json", "emit machine-readable JSON instead of text")
  .action(async (opts: { plan: string; stageDir: string; backupRoot: string; dryRun?: boolean; json?: boolean }) => {
    try {
      const plan = await readRepairPlan(opts.plan);
      const dryRun = !!(opts.dryRun ?? program.opts().dryRun);
      const result = await applyRepairs({ plan, stageDir: opts.stageDir, backupRoot: opts.backupRoot, dryRun });
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else if (dryRun) {
        console.log(`Dry run OK. Would back up originals to ${result.backupDir}`);
        for (const r of result.replaced) console.log(`  replace S${String(r.episode).padStart(2, "0")}: ${r.target} <- ${r.replacement} (backup: ${r.backup})`);
        for (const c of result.created) console.log(`  create  S${String(c.episode).padStart(2, "0")}: ${c.target} <- ${c.replacement}`);
      } else {
        console.log(`Backed up originals to ${result.backupDir}`);
        console.log(`Replaced ${result.replaced.length} file(s), created ${result.created.length} file(s).`);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
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
