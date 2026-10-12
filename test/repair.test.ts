import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyRepairs, buildFfmpegConcatArgs, buildFfmpegRangeArgs, preflightApplyRepairs, readRepairPlan, stageRepairs } from "../src/repair.js";
import type { RepairPlanDoc } from "../src/season-audit.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "vs-repair-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makePlan(overrides: Partial<RepairPlanDoc> = {}): RepairPlanDoc {
  const sourceFolder = path.join(dir, "Season 01");
  return {
    version: 1,
    policy: "segment-plus-outro-no-intro",
    approved_for_staging: false,
    approved_for_apply: false,
    source_folder: sourceFolder,
    created_at: "2026-10-12T00:00:00.000Z",
    checklist: [],
    items: [
      {
        episode: 2,
        title: "Monsters, Get Real",
        source: path.join(sourceFolder, "Show - S01E02 - Monsters, Get Real.mp4"),
        outputName: "Show - S01E02 - Monsters, Get Real.TEST.mp4",
        keepRanges: [{ startSec: 47.28, endSec: 718.98 }, { startSec: 1384.04, endSec: 1430.02 }],
        dropRanges: [],
        expectedDurationSec: 717.68,
        evidence: "candidate",
        confidence: "medium",
      },
    ],
    ...overrides,
  };
}

function writeStage(plan: RepairPlanDoc, stageDir: string): void {
  mkdirSync(stageDir, { recursive: true });
  const item = plan.items[0]!;
  const output = path.join(stageDir, item.outputName);
  writeFileSync(output, "replacement-bytes");
  writeFileSync(path.join(stageDir, "stage-summary.json"), JSON.stringify({
    policy: plan.policy,
    stageDir,
    items: [{ episode: item.episode, title: item.title, output, expectedDurationSec: item.expectedDurationSec }],
  }));
}

describe("repair command helpers", () => {
  it("builds range extraction args preserving video/audio/subtitles and dropping data", () => {
    expect(buildFfmpegRangeArgs("in.mp4", "part.mp4", 47.28, 718.98)).toEqual([
      "-hide_banner", "-y", "-ss", "47.28", "-to", "718.98", "-i", "in.mp4",
      "-map", "0:v:0", "-map", "0:a?", "-map", "0:s?", "-dn",
      "-c", "copy", "-avoid_negative_ts", "make_zero", "part.mp4",
    ]);
  });

  it("builds concat args preserving all expected stream types", () => {
    expect(buildFfmpegConcatArgs("list.txt", "out.mp4").join(" ")).toContain("-map 0:a?");
  });

  it("refuses to stage unapproved plans", async () => {
    await expect(stageRepairs({ plan: makePlan(), stageDir: "stage", ffmpegBin: "ffmpeg" })).rejects.toThrow(/not approved/);
  });
});

describe("readRepairPlan", () => {
  it("reports invalid JSON with the plan path", async () => {
    const p = path.join(dir, "bad.json");
    writeFileSync(p, "not-json");
    await expect(readRepairPlan(p)).rejects.toThrow(new RegExp(`Cannot parse repair plan .*${path.basename(p)}`));
  });

  it("validates human-edited plan shape", async () => {
    const p = path.join(dir, "bad-shape.json");
    writeFileSync(p, JSON.stringify({ version: 1, policy: "segment-plus-outro-no-intro", items: [] }));
    await expect(readRepairPlan(p)).rejects.toThrow(/approved_for_staging/);
  });
});

describe("applyRepairs", () => {
  it("refuses apply when staged summary is missing", async () => {
    const plan = makePlan({ approved_for_apply: true });
    await expect(applyRepairs({ plan, stageDir: path.join(dir, "stage"), backupRoot: path.join(dir, "bak") })).rejects.toThrow(/Missing staged summary/);
  });

  it("preflights staged output identity before replacement", async () => {
    const plan = makePlan({ approved_for_apply: true });
    const stageDir = path.join(dir, "stage");
    writeStage(plan, stageDir);
    const preflight = await preflightApplyRepairs({ plan, stageDir });
    expect(preflight).toEqual([{ source: plan.items[0]!.source, replacement: path.join(stageDir, plan.items[0]!.outputName), expectedDurationSec: 717.68, replacementBytes: 17 }]);
  });

  it("backs up original, replaces target, and writes replacement manifest", async () => {
    const plan = makePlan({ approved_for_apply: true });
    mkdirSync(plan.source_folder, { recursive: true });
    writeFileSync(plan.items[0]!.source, "original-bytes");
    const stageDir = path.join(dir, "stage");
    writeStage(plan, stageDir);
    const backupRoot = path.join(dir, "bak");

    const result = await applyRepairs({ plan, stageDir, backupRoot });
    expect(result.replaced).toHaveLength(1);
    expect(readFileSync(plan.items[0]!.source, "utf8")).toBe("replacement-bytes");
    expect(readFileSync(result.replaced[0]!.backup, "utf8")).toBe("original-bytes");
    expect(readFileSync(path.join(result.backupDir, "replacement-manifest.json"), "utf8")).toContain(plan.items[0]!.outputName);
  });

  it("dry-runs without mutating files", async () => {
    const plan = makePlan({ approved_for_apply: true });
    mkdirSync(plan.source_folder, { recursive: true });
    writeFileSync(plan.items[0]!.source, "original-bytes");
    const stageDir = path.join(dir, "stage");
    writeStage(plan, stageDir);
    const result = await applyRepairs({ plan, stageDir, backupRoot: path.join(dir, "bak"), dryRun: true });
    expect(result.replaced[0]?.source).toBe(plan.items[0]!.source);
    expect(readFileSync(plan.items[0]!.source, "utf8")).toBe("original-bytes");
  });
});
