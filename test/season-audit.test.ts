import { describe, expect, it } from "vitest";
import { buildRepairPlan, normalizeTitle, parseEpisodeFileName, renderSeasonAuditReport, type SeasonAuditResult } from "../src/season-audit.js";

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

describe("repair plan emission", () => {
  const audit = {
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

  it("builds an unapproved explicit repair plan", () => {
    const plan = buildRepairPlan(audit);
    expect(plan.policy).toBe("segment-plus-outro-no-intro");
    expect(plan.approved_for_staging).toBe(false);
    expect(plan.approved_for_apply).toBe(false);
    expect(plan.items[0]?.expectedDurationSec).toBe(718);
    expect(plan.checklist.join(" ").toLowerCase()).toContain("preview");
  });

  it("renders repair candidates as requiring approval", () => {
    const report = renderSeasonAuditReport(audit);
    expect(report).toContain("repair candidate");
    expect(report).toContain("requires preview/approval");
  });
});
