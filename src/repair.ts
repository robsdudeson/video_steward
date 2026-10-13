import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { NormalizedRepairItem, RepairPlanDoc, RepairPolicy } from "./season-audit.js";
import { copyVerified, mediaFsForPath } from "./media-fs.js";
import { toMediaToolPath } from "./paths.js";

export class RepairError extends Error {}

export interface StageSummaryItem {
  /** Source item episode (odd episode for split plans). */
  episode: number;
  title: string;
  /** Output action identity within the item. */
  outputEpisode: number;
  mode: "replace" | "create";
  targetName: string;
  output: string;
  expectedDurationSec: number;
}

export interface StageSummary {
  policy: RepairPolicy;
  stageDir: string;
  items: StageSummaryItem[];
}

const rangeSchema = z.object({
  startSec: z.number().finite().nonnegative(),
  endSec: z.number().finite().positive(),
}).refine((r) => r.endSec > r.startSec, "range endSec must be greater than startSec");

const filenameSchema = z.string().min(1).refine((s) => !s.includes("/") && !s.includes("\\"), "must be a bare filename (no path separators)");

const outputActionSchema = z.object({
  episode: z.number().int().positive(),
  title: z.string().min(1),
  targetName: filenameSchema,
  mode: z.enum(["replace", "create"]),
  keepRanges: z.array(rangeSchema).min(1),
  dropRanges: z.array(rangeSchema),
  expectedDurationSec: z.number().finite().positive(),
});

const legacyItemSchema = z.object({
  episode: z.number().int().positive(),
  title: z.string().min(1),
  source: z.string().min(1),
  outputName: filenameSchema,
  keepRanges: z.array(rangeSchema).min(1),
  dropRanges: z.array(rangeSchema),
  expectedDurationSec: z.number().finite().positive(),
  evidence: z.string().min(1),
  confidence: z.string().min(1),
});

const splitItemSchema = z.object({
  episode: z.number().int().positive(),
  title: z.string().min(1),
  source: z.string().min(1),
  evidence: z.string().min(1),
  confidence: z.string().min(1),
  outputs: z.array(outputActionSchema).min(1),
});

const repairPlanSchema = z.discriminatedUnion("policy", [
  z.object({
    version: z.literal(1),
    policy: z.literal("segment-plus-outro-no-intro"),
    approved_for_staging: z.boolean(),
    approved_for_apply: z.boolean(),
    source_folder: z.string().min(1),
    created_at: z.string().min(1),
    checklist: z.array(z.string()),
    items: z.array(legacyItemSchema.or(splitItemSchema)),
  }),
  z.object({
    version: z.literal(1),
    policy: z.literal("split-paired-episode"),
    approved_for_staging: z.boolean(),
    approved_for_apply: z.boolean(),
    source_folder: z.string().min(1),
    created_at: z.string().min(1),
    checklist: z.array(z.string()),
    items: z.array(splitItemSchema),
  }),
]);

function toNormalized(item: z.infer<typeof legacyItemSchema> | z.infer<typeof splitItemSchema>): NormalizedRepairItem {
  if ("outputs" in item) {
    return { episode: item.episode, title: item.title, source: item.source, evidence: item.evidence, confidence: item.confidence, outputs: item.outputs };
  }
  // Legacy one-output shape becomes a single replace action.
  return {
    episode: item.episode,
    title: item.title,
    source: item.source,
    evidence: item.evidence,
    confidence: item.confidence,
    outputs: [{
      episode: item.episode,
      title: item.title,
      targetName: item.outputName.replace(/\.TEST\.mp4$/i, ".mp4"),
      mode: "replace",
      keepRanges: item.keepRanges,
      dropRanges: item.dropRanges,
      expectedDurationSec: item.expectedDurationSec,
    }],
  };
}

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
  const doc = result.data;
  return {
    version: 1,
    policy: doc.policy,
    approved_for_staging: doc.approved_for_staging,
    approved_for_apply: doc.approved_for_apply,
    source_folder: doc.source_folder,
    created_at: doc.created_at,
    checklist: doc.checklist,
    items: doc.items.map(toNormalized),
  };
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

function rangePartName(item: NormalizedRepairItem, outputIdx: number, rangeIdx: number): string {
  const out = item.outputs[outputIdx]!;
  return `S${String(item.episode).padStart(2, "0")}.out${outputIdx + 1}E${String(out.episode).padStart(2, "0")}.part${rangeIdx + 1}.mp4`;
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
    for (const [outputIdx, output] of item.outputs.entries()) {
      const outputName = `${output.targetName.replace(/\.mp4$/i, "")}.TEST.mp4`;
      const outPath = path.join(opts.stageDir, outputName);
      if (!opts.force && await exists(outPath)) {
        throw new RepairError(`Staged output already exists: ${outPath} (use --force to overwrite)`);
      }
      const partPaths: string[] = [];
      for (const [rangeIdx, range] of output.keepRanges.entries()) {
        const part = path.join(opts.stageDir, rangePartName(item, outputIdx, rangeIdx));
        await run(opts.ffmpegBin, buildFfmpegRangeArgs(toMediaToolPath(item.source), toMediaToolPath(part), range.startSec, range.endSec));
        partPaths.push(part);
      }
      const listPath = path.join(opts.stageDir, `S${String(item.episode).padStart(2, "0")}.out${outputIdx + 1}E${String(output.episode).padStart(2, "0")}.concat.txt`);
      await fs.writeFile(listPath, partPaths.map((p) => {
        const mediaPath = toMediaToolPath(p);
        return `file '${mediaPath.replaceAll("'", "''")}'`;
      }).join("\n") + "\n", "ascii");
      await run(opts.ffmpegBin, buildFfmpegConcatArgs(toMediaToolPath(listPath), toMediaToolPath(outPath)));
      items.push({
        episode: item.episode,
        title: item.title,
        outputEpisode: output.episode,
        mode: output.mode,
        targetName: output.targetName,
        output: outPath,
        expectedDurationSec: output.expectedDurationSec,
      });
    }
  }
  const summary = { policy: opts.plan.policy, stageDir: opts.stageDir, items } satisfies StageSummary;
  await fs.writeFile(path.join(opts.stageDir, "stage-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

const stageSummarySchema = z.object({
  policy: z.enum(["segment-plus-outro-no-intro", "split-paired-episode"]),
  stageDir: z.string().min(1),
  items: z.array(z.object({
    episode: z.number().int().positive(),
    title: z.string().min(1),
    outputEpisode: z.number().int().positive(),
    mode: z.enum(["replace", "create"]),
    targetName: filenameSchema,
    output: z.string().min(1),
    expectedDurationSec: z.number().finite().positive(),
  })),
});

export interface ApplyPreflightItem {
  /** Output action episode. */
  episode: number;
  mode: "replace" | "create";
  source: string;
  target: string;
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
  const totalOutputs = opts.plan.items.reduce((n, item) => n + item.outputs.length, 0);
  if (summary.items.length !== totalOutputs) {
    throw new RepairError(`Staged summary item count ${summary.items.length} does not match plan output count ${totalOutputs}`);
  }
  const archiveFs = mediaFsForPath(opts.plan.source_folder);
  const out: ApplyPreflightItem[] = [];
  for (const item of opts.plan.items) {
    for (const output of item.outputs) {
      const expectedOutput = path.join(opts.stageDir, `${output.targetName.replace(/\.mp4$/i, "")}.TEST.mp4`);
      const summaryItem = summary.items.find((s) => s.episode === item.episode && s.outputEpisode === output.episode && s.mode === output.mode);
      if (!summaryItem) throw new RepairError(`Staged summary missing S${String(output.episode).padStart(2, "0")} ${output.title} (${output.mode})`);
      if (path.normalize(summaryItem.output) !== path.normalize(expectedOutput)) {
        throw new RepairError(`Staged output mismatch for S${String(output.episode).padStart(2, "0")}: summary=${summaryItem.output} expected=${expectedOutput}`);
      }
      if (Math.abs(summaryItem.expectedDurationSec - output.expectedDurationSec) > 1) {
        throw new RepairError(`Staged duration expectation mismatch for S${String(output.episode).padStart(2, "0")}`);
      }
      let st;
      try {
        st = await fs.stat(expectedOutput);
      } catch (err) {
        throw new RepairError(`Missing staged output ${expectedOutput}: ${(err as Error).message}`);
      }
      if (st.size === 0) throw new RepairError(`Staged output is empty: ${expectedOutput}`);
      const target = archiveJoin(opts.plan.source_folder, output.targetName);
      const targetExists = await archiveFs.exists(target);
      if (output.mode === "replace" && !targetExists) {
        throw new RepairError(`Replace target missing: ${target} (refusing to apply)`);
      }
      if (output.mode === "create" && targetExists) {
        throw new RepairError(`Create target already exists: ${target} (refusing to overwrite; resolve manually and re-audit)`);
      }
      out.push({ episode: output.episode, mode: output.mode, source: item.source, target, replacement: expectedOutput, expectedDurationSec: output.expectedDurationSec, replacementBytes: st.size });
    }
  }
  return out;
}

export interface ApplyResult {
  backupDir: string;
  replaced: { episode: number; mode: "replace"; source: string; target: string; backup: string; replacement: string }[];
  created: { episode: number; mode: "create"; source: string; target: string; replacement: string }[];
}

export async function applyRepairs(opts: { plan: RepairPlanDoc; stageDir: string; backupRoot: string; dryRun?: boolean }): Promise<ApplyResult> {
  if (!opts.plan.approved_for_apply) {
    throw new RepairError("Repair plan is not approved for apply (set approved_for_apply=true after spot-checking staged outputs)");
  }
  const preflight = await preflightApplyRepairs(opts);
  const backupDir = archiveJoin(opts.backupRoot, `video-steward-repair-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  if (opts.dryRun) {
    return {
      backupDir,
      replaced: preflight.filter((p) => p.mode === "replace").map((p) => ({ episode: p.episode, mode: "replace" as const, source: p.source, target: p.target, backup: archiveJoin(backupDir, archiveBasename(p.target)), replacement: p.replacement })),
      created: preflight.filter((p) => p.mode === "create").map((p) => ({ episode: p.episode, mode: "create" as const, source: p.source, target: p.target, replacement: p.replacement })),
    };
  }
  const archiveFs = mediaFsForPath(opts.plan.source_folder);
  await archiveFs.mkdirp(backupDir);
  const replaced: ApplyResult["replaced"] = [];
  const created: ApplyResult["created"] = [];
  for (const item of preflight) {
    const tmp = archiveJoin(archiveDirname(item.target), `.${archiveBasename(item.target)}.tmp-copying`);
    if (item.mode === "replace") {
      const backup = archiveJoin(backupDir, archiveBasename(item.target));
      await copyVerified(archiveFs, item.target, backup);
      await archiveFs.copy(item.replacement, tmp);
      await archiveFs.rename(tmp, item.target, { force: true });
      replaced.push({ episode: item.episode, mode: "replace", source: item.source, target: item.target, backup, replacement: item.replacement });
    } else {
      // Create targets are verified absent by preflight; no backup entry.
      await archiveFs.copy(item.replacement, tmp);
      await archiveFs.rename(tmp, item.target, { force: false });
      created.push({ episode: item.episode, mode: "create", source: item.source, target: item.target, replacement: item.replacement });
    }
  }
  const manifest = archiveJoin(backupDir, "replacement-manifest.json");
  await archiveFs.copy(await writeTempManifest({ backupDir, replaced, created }, opts.stageDir), manifest);
  return { backupDir, replaced, created };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeTempManifest(result: ApplyResult, stageDir?: string): Promise<string> {
  const root = stageDir ?? tmpdir();
  const p = path.join(root, `video-steward-replacement-${Date.now()}.json`);
  await fs.writeFile(p, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return p;
}
