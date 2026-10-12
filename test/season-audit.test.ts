import { beforeEach, describe, expect, it } from "vitest";
import { buildRepairPlan, clearSplitEvenMetadata, normalizeTitle, parseEpisodeFileName, renderSeasonAuditReport, setSplitEvenMetadata, type AuditRow, type SeasonAuditResult } from "../src/season-audit.js";

describe("parseEpisodeFileName", () => {
  it("parses the archive naming convention", () => {
    expect(parseEpisodeFileName("Aaahh Real Monsters - S01E02 - Monsters, Get Real.mp4")).toEqual({
      showName: "Aaahh Real Monsters",
      season: 1,
      episode: 2,
      title: "Monsters, Get Real",
    });
  });

  it("returns null for unparseable names", () => {
    expect(parseEpisodeFileName("random.mp4")).toBeNull();
  });
});

describe("normalizeTitle", () => {
  it("ignores punctuation and case", () => {
    expect(normalizeTitle("Mother May I")).toBe(normalizeTitle("Mother May I?"));
  });
});

const segmentAudit = {
  folder: "Z:/video/shows/Aaahh Real Monsters/Season 01",
  warnings: [],
  tmdbNote: null,
  rows: [
    {
      file: "Aaahh Real Monsters - S01E02 - Monsters, Get Real.mp4",
      fullPath: "Z:/video/shows/Aaahh Real Monsters/Season 01/Aaahh Real Monsters - S01E02 - Monsters, Get Real.mp4",
      sizeBytes: 1,
      parsed: { showName: "Aaahh Real Monsters", season: 1, episode: 2, title: "Monsters, Get Real" },
      durationSec: 1430,
      chapters: [],
      formatTags: {},
      tmdbTitle: "Monsters, Get Real",
      tmdbRuntimeMin: 11,
      titleStatus: "ok",
      runtimeStatus: "long",
      warnings: [],
      repair: {
        kind: "paired-duplicate-candidate",
        confidence: "medium",
        evidence: "intro + 2 acts + outro",
        policy: "segment-plus-outro-no-intro",
        keepRanges: [{ startSec: 47, endSec: 719 }, { startSec: 1384, endSec: 1430 }],
        dropRanges: [{ startSec: 0, endSec: 47 }, { startSec: 719, endSec: 1384 }],
      },
    },
  ],
} satisfies SeasonAuditResult;

describe("repair plan emission (segment policy)", () => {
  it("builds an unapproved explicit repair plan with a replace action", () => {
    const plan = buildRepairPlan(segmentAudit);
    expect(plan.policy).toBe("segment-plus-outro-no-intro");
    expect(plan.approved_for_staging).toBe(false);
    expect(plan.approved_for_apply).toBe(false);
    expect(plan.items[0]?.outputs[0]?.expectedDurationSec).toBe(718);
    expect(plan.items[0]?.outputs[0]?.mode).toBe("replace");
    expect(plan.items[0]?.outputs[0]?.targetName).toBe("Aaahh Real Monsters - S01E02 - Monsters, Get Real.mp4");
    expect(plan.checklist.join(" ").toLowerCase()).toContain("preview");
  });

  it("renders repair candidates as requiring approval", () => {
    const report = renderSeasonAuditReport(segmentAudit);
    expect(report).toContain("repair candidate");
    expect(report).toContain("requires preview/approval");
  });
});

function splitRow(episode: number, title: string): AuditRow {
  return {
    file: `Aaahh Real Monsters - S03E${String(episode).padStart(2, "0")} - ${title}.mp4`,
    fullPath: `Z:/video/shows/Aaahh Real Monsters/Season 03/Aaahh Real Monsters - S03E${String(episode).padStart(2, "0")} - ${title}.mp4`,
    sizeBytes: 1,
    parsed: { showName: "Aaahh Real Monsters", season: 3, episode, title },
    durationSec: 1430,
    chapters: [],
    formatTags: {},
    tmdbTitle: title,
    tmdbRuntimeMin: 11,
    titleStatus: "ok",
    runtimeStatus: "long",
    warnings: [],
    repair: {
      kind: "paired-split-candidate",
      confidence: "medium",
      evidence: "intro + 2 acts + outro; even episode must be created from the second act",
      policy: "split-paired-episode",
      keepRanges: [{ startSec: 47, endSec: 719 }, { startSec: 1384, endSec: 1430 }],
      dropRanges: [{ startSec: 0, endSec: 47 }],
      splitOutputs: {
        oddKeep: [{ startSec: 47, endSec: 719 }, { startSec: 1384, endSec: 1430 }],
        evenKeep: [{ startSec: 719, endSec: 1384 }, { startSec: 1384, endSec: 1430 }],
      },
    },
  };
}

describe("repair plan emission (split policy)", () => {
  beforeEach(() => {
    clearSplitEvenMetadata();
  });

  it("builds replace+create outputs for each odd source", () => {
    const audit = {
      folder: "Z:/video/shows/Aaahh Real Monsters/Season 03",
      warnings: [],
      tmdbNote: null,
      rows: [splitRow(1, "Pilot Part 1"), splitRow(3, "Episode Three")],
    } satisfies SeasonAuditResult;
    setSplitEvenMetadata(audit.rows[0]!.fullPath, { title: "Pilot Part 2", runtimeMin: 11 });
    setSplitEvenMetadata(audit.rows[1]!.fullPath, { title: "Episode Four", runtimeMin: 11 });

    const plan = buildRepairPlan(audit, "split-paired-episode");
    expect(plan.policy).toBe("split-paired-episode");
    expect(plan.items).toHaveLength(2);
    const [first] = plan.items;
    expect(first?.outputs.map((o) => o.mode)).toEqual(["replace", "create"]);
    expect(first?.outputs[1]?.targetName).toBe("Aaahh Real Monsters - S03E02 - Pilot Part 2.mp4");
    expect(first?.outputs[1]?.title).toBe("Pilot Part 2");
    const allEpisodes = plan.items.flatMap((i) => i.outputs.map((o) => o.episode)).sort((a, b) => a - b);
    expect(allEpisodes).toEqual([1, 2, 3, 4]);
  });

  it("skips sources whose even TMDb metadata is missing and warns", () => {
    const audit = {
      folder: "Z:/video/shows/Aaahh Real Monsters/Season 03",
      warnings: [],
      tmdbNote: null,
      rows: [splitRow(1, "Pilot Part 1"), splitRow(3, "Episode Three")],
    } satisfies SeasonAuditResult;
    setSplitEvenMetadata(audit.rows[0]!.fullPath, { title: "Pilot Part 2", runtimeMin: 11 });
    // No metadata registered for S03E04.

    const plan = buildRepairPlan(audit, "split-paired-episode");
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.episode).toBe(1);
    expect(audit.warnings.join(" ")).toContain("S03E03");
  });

  it("refuses to plan a create over an existing even file", () => {
    const audit = {
      folder: "Z:/video/shows/Aaahh Real Monsters/Season 03",
      warnings: [],
      tmdbNote: null,
      rows: [splitRow(1, "Pilot Part 1"), splitRow(2, "Pilot Part 2")],
    } satisfies SeasonAuditResult;
    setSplitEvenMetadata(audit.rows[0]!.fullPath, { title: "Pilot Part 2", runtimeMin: 11 });

    const plan = buildRepairPlan(audit, "split-paired-episode");
    expect(plan.items).toHaveLength(0);
    expect(audit.warnings.join(" ")).toContain("already exists");
  });
});
