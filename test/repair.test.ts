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
        evidence: "candidate",
        confidence: "medium",
        outputs: [
          {
            episode: 2,
            title: "Monsters, Get Real",
            targetName: "Show - S01E02 - Monsters, Get Real.mp4",
            mode: "replace",
            keepRanges: [{ startSec: 47.28, endSec: 718.98 }, { startSec: 1384.04, endSec: 1430.02 }],
            dropRanges: [],
            expectedDurationSec: 717.68,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function makeSplitPlan(overrides: Partial<RepairPlanDoc> = {}): RepairPlanDoc {
  const sourceFolder = path.join(dir, "Season 03");
  return {
    version: 1,
    policy: "split-paired-episode",
    approved_for_staging: false,
    approved_for_apply: false,
    source_folder: sourceFolder,
    created_at: "2026-10-12T00:00:00.000Z",
    checklist: [],
    items: [
      {
        episode: 1,
        title: "Pilot Part 1",
        source: path.join(sourceFolder, "Show - S03E01 - Pilot Part 1.mp4"),
        evidence: "candidate",
        confidence: "medium",
        outputs: [
          {
            episode: 1,
            title: "Pilot Part 1",
            targetName: "Show - S03E01 - Pilot Part 1.mp4",
            mode: "replace",
            keepRanges: [{ startSec: 47, endSec: 719 }, { startSec: 1384, endSec: 1430 }],
            dropRanges: [],
            expectedDurationSec: 722,
          },
          {
            episode: 2,
            title: "Pilot Part 2",
            targetName: "Show - S03E02 - Pilot Part 2.mp4",
            mode: "create",
            keepRanges: [{ startSec: 719, endSec: 1384 }, { startSec: 1384, endSec: 1430 }],
            dropRanges: [],
            expectedDurationSec: 715,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function writeStage(plan: RepairPlanDoc, stageDir: string): void {
  mkdirSync(stageDir, { recursive: true });
  const summaryItems = [];
  for (const item of plan.items) {
    for (const output of item.outputs) {
      const outputName = `${output.targetName.replace(/\.mp4$/i, "")}.TEST.mp4`;
      const out = path.join(stageDir, outputName);
      writeFileSync(out, "replacement-bytes");
      summaryItems.push({ episode: item.episode, title: item.title, outputEpisode: output.episode, mode: output.mode, targetName: output.targetName, output: out, expectedDurationSec: output.expectedDurationSec });
    }
  }
  writeFileSync(path.join(stageDir, "stage-summary.json"), JSON.stringify({ policy: plan.policy, stageDir, items: summaryItems }));
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

  it("normalizes legacy segment plans into replace actions", async () => {
    const p = path.join(dir, "legacy.json");
    writeFileSync(p, JSON.stringify({
      version: 1,
      policy: "segment-plus-outro-no-intro",
      approved_for_staging: false,
      approved_for_apply: false,
      source_folder: "/tmp/Season 01",
      created_at: "2026-10-12T00:00:00.000Z",
      checklist: [],
      items: [
        {
          episode: 2,
          title: "Monsters, Get Real",
          source: "/tmp/Season 01/Show - S01E02 - Monsters, Get Real.mp4",
          outputName: "Show - S01E02 - Monsters, Get Real.TEST.mp4",
          keepRanges: [{ startSec: 47.28, endSec: 718.98 }],
          dropRanges: [],
          expectedDurationSec: 671.7,
          evidence: "candidate",
          confidence: "medium",
        },
      ],
    }));
    const plan = await readRepairPlan(p);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.outputs).toEqual([
      {
        episode: 2,
        title: "Monsters, Get Real",
        targetName: "Show - S01E02 - Monsters, Get Real.mp4",
        mode: "replace",
        keepRanges: [{ startSec: 47.28, endSec: 718.98 }],
        dropRanges: [],
        expectedDurationSec: 671.7,
      },
    ]);
  });

  it("accepts a split plan with one source and two outputs", async () => {
    const p = path.join(dir, "split.json");
    writeFileSync(p, JSON.stringify(makeSplitPlan()));
    const plan = await readRepairPlan(p);
    expect(plan.policy).toBe("split-paired-episode");
    expect(plan.items[0]?.outputs.map((o) => o.mode)).toEqual(["replace", "create"]);
  });

  it("rejects a split output with a path separator in targetName", async () => {
    const plan = makeSplitPlan();
    (plan.items[0]!.outputs[1] as { targetName: string }).targetName = "sub/Show - S03E02 - Pilot Part 2.mp4";
    const p = path.join(dir, "split-bad.json");
    writeFileSync(p, JSON.stringify(plan));
    await expect(readRepairPlan(p)).rejects.toThrow(/bare filename/);
  });

  it("rejects an unknown policy with a clear message", async () => {
    const plan = makeSplitPlan({ policy: "made-up-policy" as never });
    const p = path.join(dir, "split-unknown.json");
    writeFileSync(p, JSON.stringify(plan));
    await expect(readRepairPlan(p)).rejects.toThrow(/Invalid repair plan/);
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
    mkdirSync(plan.source_folder, { recursive: true });
    writeFileSync(path.join(plan.source_folder, "Show - S01E02 - Monsters, Get Real.mp4"), "original-bytes");
    const preflight = await preflightApplyRepairs({ plan, stageDir });
    expect(preflight).toEqual([
      {
        episode: 2,
        mode: "replace",
        source: plan.items[0]!.source,
        target: path.join(plan.source_folder, "Show - S01E02 - Monsters, Get Real.mp4"),
        replacement: path.join(stageDir, "Show - S01E02 - Monsters, Get Real.TEST.mp4"),
        expectedDurationSec: 717.68,
        replacementBytes: 17,
      },
    ]);
  });

  it("backs up original, replaces target, and writes replacement manifest", async () => {
    const plan = makePlan({ approved_for_apply: true });
    mkdirSync(plan.source_folder, { recursive: true });
    writeFileSync(path.join(plan.source_folder, "Show - S01E02 - Monsters, Get Real.mp4"), "original-bytes");
    const stageDir = path.join(dir, "stage");
    writeStage(plan, stageDir);
    const backupRoot = path.join(dir, "bak");

    const result = await applyRepairs({ plan, stageDir, backupRoot });
    expect(result.replaced).toHaveLength(1);
    expect(result.created).toHaveLength(0);
    expect(readFileSync(path.join(plan.source_folder, "Show - S01E02 - Monsters, Get Real.mp4"), "utf8")).toBe("replacement-bytes");
    expect(readFileSync(result.replaced[0]!.backup, "utf8")).toBe("original-bytes");
    expect(readFileSync(path.join(result.backupDir, "replacement-manifest.json"), "utf8")).toContain("Show - S01E02 - Monsters, Get Real.mp4");
  });

  it("dry-runs without mutating files", async () => {
    const plan = makePlan({ approved_for_apply: true });
    mkdirSync(plan.source_folder, { recursive: true });
    writeFileSync(path.join(plan.source_folder, "Show - S01E02 - Monsters, Get Real.mp4"), "original-bytes");
    const stageDir = path.join(dir, "stage");
    writeStage(plan, stageDir);
    const result = await applyRepairs({ plan, stageDir, backupRoot: path.join(dir, "bak"), dryRun: true });
    expect(result.replaced[0]?.target).toBe(path.join(plan.source_folder, "Show - S01E02 - Monsters, Get Real.mp4"));
    expect(readFileSync(path.join(plan.source_folder, "Show - S01E02 - Monsters, Get Real.mp4"), "utf8")).toBe("original-bytes");
  });

  describe("split replace/create actions", () => {
    it("replaces the odd target with backup and creates the even target without one", async () => {
      const plan = makeSplitPlan({ approved_for_apply: true });
      mkdirSync(plan.source_folder, { recursive: true });
      writeFileSync(path.join(plan.source_folder, "Show - S03E01 - Pilot Part 1.mp4"), "odd-original");
      const stageDir = path.join(dir, "stage");
      writeStage(plan, stageDir);

      const result = await applyRepairs({ plan, stageDir, backupRoot: path.join(dir, "bak") });
      expect(result.replaced).toHaveLength(1);
      expect(result.created).toHaveLength(1);
      expect(readFileSync(path.join(plan.source_folder, "Show - S03E01 - Pilot Part 1.mp4"), "utf8")).toBe("replacement-bytes");
      expect(readFileSync(path.join(plan.source_folder, "Show - S03E02 - Pilot Part 2.mp4"), "utf8")).toBe("replacement-bytes");
      expect(readFileSync(result.replaced[0]!.backup, "utf8")).toBe("odd-original");
      const manifest = JSON.parse(readFileSync(path.join(result.backupDir, "replacement-manifest.json"), "utf8")) as { replaced: unknown[]; created: unknown[] };
      expect(manifest.replaced).toHaveLength(1);
      expect(manifest.created).toHaveLength(1);
    });

    it("fails create when the target already exists", async () => {
      const plan = makeSplitPlan({ approved_for_apply: true });
      mkdirSync(plan.source_folder, { recursive: true });
      writeFileSync(path.join(plan.source_folder, "Show - S03E01 - Pilot Part 1.mp4"), "odd-original");
      writeFileSync(path.join(plan.source_folder, "Show - S03E02 - Pilot Part 2.mp4"), "existing-even");
      const stageDir = path.join(dir, "stage");
      writeStage(plan, stageDir);

      await expect(applyRepairs({ plan, stageDir, backupRoot: path.join(dir, "bak") })).rejects.toThrow(/Create target already exists/);
      // No mutation happened.
      expect(readFileSync(path.join(plan.source_folder, "Show - S03E01 - Pilot Part 1.mp4"), "utf8")).toBe("odd-original");
    });

    it("fails replace when the target is missing", async () => {
      const plan = makePlan({ approved_for_apply: true });
      mkdirSync(plan.source_folder, { recursive: true }); // no source file present
      const stageDir = path.join(dir, "stage");
      writeStage(plan, stageDir);

      await expect(applyRepairs({ plan, stageDir, backupRoot: path.join(dir, "bak") })).rejects.toThrow(/Replace target missing/);
    });

    it("fails before mutation when a staged output is missing", async () => {
      const plan = makeSplitPlan({ approved_for_apply: true });
      mkdirSync(plan.source_folder, { recursive: true });
      writeFileSync(path.join(plan.source_folder, "Show - S03E01 - Pilot Part 1.mp4"), "odd-original");
      const stageDir = path.join(dir, "stage");
      writeStage(plan, stageDir);
      rmSync(path.join(stageDir, "Show - S03E02 - Pilot Part 2.TEST.mp4"));

      await expect(applyRepairs({ plan, stageDir, backupRoot: path.join(dir, "bak") })).rejects.toThrow(/Missing staged output/);
      expect(readFileSync(path.join(plan.source_folder, "Show - S03E01 - Pilot Part 1.mp4"), "utf8")).toBe("odd-original");
    });

    it("dry-run lists replacements and creations separately", async () => {
      const plan = makeSplitPlan({ approved_for_apply: true });
      mkdirSync(plan.source_folder, { recursive: true });
      writeFileSync(path.join(plan.source_folder, "Show - S03E01 - Pilot Part 1.mp4"), "odd-original");
      const stageDir = path.join(dir, "stage");
      writeStage(plan, stageDir);

      const result = await applyRepairs({ plan, stageDir, backupRoot: path.join(dir, "bak"), dryRun: true });
      expect(result.replaced).toHaveLength(1);
      expect(result.created).toHaveLength(1);
      expect(result.created[0]?.target).toBe(path.join(plan.source_folder, "Show - S03E02 - Pilot Part 2.mp4"));
    });
  });
});
