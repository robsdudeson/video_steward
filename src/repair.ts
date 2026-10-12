import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { RepairPlanDoc, RepairPlanItem } from "./season-audit.js";
import { copyVerified, mediaFsForPath } from "./media-fs.js";
import { toMediaToolPath } from "./paths.js";

export class RepairError extends Error {}

export interface StageSummaryItem {
  episode: number;
  title: string;
  output: string;
  expectedDurationSec: number;
}

export interface StageSummary {
  policy: RepairPlanDoc["policy"];
  stageDir: string;
  items: StageSummaryItem[];
}

const rangeSchema = z.object({
  startSec: z.number().finite().nonnegative(),
  endSec: z.number().finite().positive(),
}).refine((r) => r.endSec > r.startSec, "range endSec must be greater than startSec");

const repairPlanItemSchema = z.object({
  episode: z.number().int().positive(),
  title: z.string().min(1),
  source: z.string().min(1),
  outputName: z.string().min(1).refine((s) => !s.includes("/") && !s.includes("\\"), "outputName must be a filename"),
  keepRanges: z.array(rangeSchema).min(1),
  dropRanges: z.array(rangeSchema),
  expectedDurationSec: z.number().finite().positive(),
  evidence: z.string().min(1),
  confidence: z.string().min(1),
});

const repairPlanSchema = z.object({
  version: z.literal(1),
  policy: z.literal("segment-plus-outro-no-intro"),
  approved_for_staging: z.boolean(),
  approved_for_apply: z.boolean(),
  source_folder: z.string().min(1),
  created_at: z.string().min(1),
  checklist: z.array(z.string()),
  items: z.array(repairPlanItemSchema),
});

export async function readRepairPlan(planPath: string): Promise<RepairPlanDoc> {
  let raw: string;
  try {
    raw = await fs.readFile(planPath, "utf8");
  } catch (err) {
    throw new RepairError(`Cannot read repair plan ${planPath}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RepairError(`Cannot parse repair plan ${planPath}; regenerate with audit-season --emit-repair-plan. ${(err as Error).message}`);
  }
  const result = repairPlanSchema.safeParse(parsed);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new RepairError(`Invalid repair plan ${planPath}: ${problems}`);
  }
  return result.data;
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new RepairError(`${path.basename(bin)} exited ${code}: ${stderr.slice(-800)}`));
    });
  });
}

function archiveBasename(p: string): string {
  return p.includes("\\") ? path.win32.basename(p) : path.basename(p);
}

function archiveDirname(p: string): string {
  return p.includes("\\") ? path.win32.dirname(p) : path.dirname(p);
}

function archiveJoin(root: string, child: string): string {
  return root.includes("\\") ? path.win32.join(root, child) : path.join(root, child);
}

function rangePartName(item: RepairPlanItem, idx: number): string {
  return `S${String(item.episode).padStart(2, "0")}.part${idx + 1}.mp4`;
}

export function buildFfmpegRangeArgs(source: string, output: string, startSec: number, endSec: number): string[] {
  return [
    "-hide_banner", "-y",
    "-ss", String(startSec),
    "-to", String(endSec),
    "-i", source,
    "-map", "0:v:0", "-map", "0:a?", "-map", "0:s?", "-dn",
    "-c", "copy", "-avoid_negative_ts", "make_zero",
    output,
  ];
}

export function buildFfmpegConcatArgs(listPath: string, output: string): string[] {
  return [
    "-hide_banner", "-y",
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-map", "0:v:0", "-map", "0:a?", "-map", "0:s?", "-dn",
    "-c", "copy",
    output,
  ];
}

export async function stageRepairs(opts: { plan: RepairPlanDoc; stageDir: string; ffmpegBin: string; force?: boolean }): Promise<StageSummary> {
  if (!opts.plan.approved_for_staging) {
    throw new RepairError("Repair plan is not approved for staging (set approved_for_staging=true after review)");
  }
  await fs.mkdir(opts.stageDir, { recursive: true });
  const items: StageSummaryItem[] = [];
  for (const item of opts.plan.items) {
    const output = path.join(opts.stageDir, item.outputName);
    if (!opts.force && await exists(output)) {
      throw new RepairError(`Staged output already exists: ${output} (use --force to overwrite)`);
    }
    const partPaths: string[] = [];
    for (const [idx, range] of item.keepRanges.entries()) {
      const part = path.join(opts.stageDir, rangePartName(item, idx));
      await run(opts.ffmpegBin, buildFfmpegRangeArgs(toMediaToolPath(item.source), toMediaToolPath(part), range.startSec, range.endSec));
      partPaths.push(part);
    }
    const listPath = path.join(opts.stageDir, `S${String(item.episode).padStart(2, "0")}.concat.txt`);
    await fs.writeFile(listPath, partPaths.map((p) => `file '${p.replaceAll("'", "''")}'`).join("\n") + "\n", "ascii");
    await run(opts.ffmpegBin, buildFfmpegConcatArgs(toMediaToolPath(listPath), toMediaToolPath(output)));
    items.push({ episode: item.episode, title: item.title, output, expectedDurationSec: item.expectedDurationSec });
  }
  const summary = { policy: opts.plan.policy, stageDir: opts.stageDir, items } satisfies StageSummary;
  await fs.writeFile(path.join(opts.stageDir, "stage-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

export interface ApplyResult {
  backupDir: string;
  replaced: { source: string; backup: string; replacement: string }[];
}

const stageSummarySchema = z.object({
  policy: z.literal("segment-plus-outro-no-intro"),
  stageDir: z.string().min(1),
  items: z.array(z.object({
    episode: z.number().int().positive(),
    title: z.string().min(1),
    output: z.string().min(1),
    expectedDurationSec: z.number().finite().positive(),
  })),
});

export interface ApplyPreflightItem {
  source: string;
  replacement: string;
  expectedDurationSec: number;
  replacementBytes: number;
}

export async function preflightApplyRepairs(opts: { plan: RepairPlanDoc; stageDir: string }): Promise<ApplyPreflightItem[]> {
  const summaryPath = path.join(opts.stageDir, "stage-summary.json");
  let summaryRaw: string;
  try {
    summaryRaw = await fs.readFile(summaryPath, "utf8");
  } catch (err) {
    throw new RepairError(`Missing staged summary ${summaryPath}; rerun repair-season stage before apply. ${(err as Error).message}`);
  }
  let summaryJson: unknown;
  try {
    summaryJson = JSON.parse(summaryRaw) as unknown;
  } catch (err) {
    throw new RepairError(`Cannot parse staged summary ${summaryPath}: ${(err as Error).message}`);
  }
  const parsed = stageSummarySchema.safeParse(summaryJson);
  if (!parsed.success) {
    throw new RepairError(`Invalid staged summary ${summaryPath}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const summary = parsed.data;
  if (summary.items.length !== opts.plan.items.length) {
    throw new RepairError(`Staged summary item count ${summary.items.length} does not match plan item count ${opts.plan.items.length}`);
  }
  const out: ApplyPreflightItem[] = [];
  for (const item of opts.plan.items) {
    const expectedOutput = path.join(opts.stageDir, item.outputName);
    const summaryItem = summary.items.find((s) => s.episode === item.episode && s.title === item.title);
    if (!summaryItem) throw new RepairError(`Staged summary missing S${String(item.episode).padStart(2, "0")} ${item.title}`);
    if (path.normalize(summaryItem.output) !== path.normalize(expectedOutput)) {
      throw new RepairError(`Staged output mismatch for S${String(item.episode).padStart(2, "0")}: summary=${summaryItem.output} expected=${expectedOutput}`);
    }
    if (Math.abs(summaryItem.expectedDurationSec - item.expectedDurationSec) > 1) {
      throw new RepairError(`Staged duration expectation mismatch for S${String(item.episode).padStart(2, "0")}`);
    }
    let st;
    try {
      st = await fs.stat(expectedOutput);
    } catch (err) {
      throw new RepairError(`Missing staged output ${expectedOutput}: ${(err as Error).message}`);
    }
    if (st.size === 0) throw new RepairError(`Staged output is empty: ${expectedOutput}`);
    out.push({ source: item.source, replacement: expectedOutput, expectedDurationSec: item.expectedDurationSec, replacementBytes: st.size });
  }
  return out;
}

export async function applyRepairs(opts: { plan: RepairPlanDoc; stageDir: string; backupRoot: string; dryRun?: boolean }): Promise<ApplyResult> {
  if (!opts.plan.approved_for_apply) {
    throw new RepairError("Repair plan is not approved for apply (set approved_for_apply=true after spot-checking staged outputs)");
  }
  const preflight = await preflightApplyRepairs(opts);
  const backupDir = archiveJoin(opts.backupRoot, `video-steward-repair-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const archiveFs = mediaFsForPath(opts.plan.source_folder);
  const replaced: ApplyResult["replaced"] = [];
  if (opts.dryRun) {
    return { backupDir, replaced: preflight.map((p) => ({ source: p.source, backup: archiveJoin(backupDir, archiveBasename(p.source)), replacement: p.replacement })) };
  }
  await archiveFs.mkdirp(backupDir);
  for (const item of opts.plan.items) {
    const replacement = path.join(opts.stageDir, item.outputName);
    const targetName = archiveBasename(item.source);
    const backup = archiveJoin(backupDir, targetName);
    const tmp = archiveJoin(archiveDirname(item.source), `.${targetName}.tmp-copying`);
    await copyVerified(archiveFs, item.source, backup);
    await archiveFs.copy(replacement, tmp);
    await archiveFs.rename(tmp, item.source, { force: true });
    replaced.push({ source: item.source, backup, replacement });
  }
  const manifest = archiveJoin(backupDir, "replacement-manifest.json");
  await archiveFs.copy(await writeTempManifest({ backupDir, replaced }), manifest);
  return { backupDir, replaced };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeTempManifest(result: ApplyResult): Promise<string> {
  const p = path.join(tmpdir(), `video-steward-replacement-${Date.now()}.json`);
  await fs.writeFile(p, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return p;
}
