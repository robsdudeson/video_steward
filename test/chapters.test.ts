import { describe, expect, it } from "vitest";
import { classifyFile, detectSegmentRepairCandidate, detectSplitPairedCandidate, spansToDurations, THRESHOLDS } from "../src/chapters.js";

describe("spansToDurations", () => {
  it("computes per-chapter durations", () => {
    expect(spansToDurations([{ startSec: 0, endSec: 47 }, { startSec: 47, endSec: 709 }])).toEqual([47, 662]);
  });

  it("returns empty for no chapters", () => {
    expect(spansToDurations([])).toEqual([]);
  });
});

describe("detectSegmentRepairCandidate", () => {
  it("detects a long paired-segment candidate but keeps confidence at candidate level", () => {
    const c = detectSegmentRepairCandidate({
      chapters: [
        { startSec: 0, endSec: 47 },
        { startSec: 47, endSec: 719 },
        { startSec: 719, endSec: 1384 },
        { startSec: 1384, endSec: 1429 },
        { startSec: 1429, endSec: 1430 },
      ],
      actualDurationSec: 1430,
      expectedRuntimeMin: 11,
      nextEpisodeDurationSec: 711,
    });
    expect(c.kind).toBe("paired-duplicate-candidate");
    expect(c.confidence).toBe("medium");
    expect(c.policy).toBe("segment-plus-outro-no-intro");
    expect(c.keepRanges).toEqual([{ startSec: 47, endSec: 719 }, { startSec: 1384, endSec: 1430 }]);
  });

  it("rejects a candidate when the next file duration is far from the dropped act", () => {
    const c = detectSegmentRepairCandidate({
      chapters: [
        { startSec: 0, endSec: 47 },
        { startSec: 47, endSec: 719 },
        { startSec: 719, endSec: 1384 },
        { startSec: 1384, endSec: 1430 },
      ],
      actualDurationSec: 1430,
      expectedRuntimeMin: 11,
      nextEpisodeDurationSec: 3600,
    });
    expect(c.kind).toBe("not-candidate");
    expect(c.evidence).toContain("not close");
  });

  it("does not suggest repair when there is insufficient evidence", () => {
    expect(detectSegmentRepairCandidate({ chapters: [], actualDurationSec: 1430, expectedRuntimeMin: 11 }).kind).toBe("insufficient-evidence");
    expect(detectSegmentRepairCandidate({ chapters: [{ startSec: 0, endSec: 700 }], actualDurationSec: 700, expectedRuntimeMin: null }).kind).toBe("not-candidate");
    expect(detectSegmentRepairCandidate({ chapters: [{ startSec: 0, endSec: 47 }, { startSec: 47, endSec: 719 }], actualDurationSec: 719, expectedRuntimeMin: 11 }).kind).toBe("not-candidate");
  });

  it("does not suggest repair when the expected runtime is full-length", () => {
    const c = detectSegmentRepairCandidate({
      chapters: [{ startSec: 0, endSec: 47 }, { startSec: 47, endSec: 719 }, { startSec: 719, endSec: 1384 }, { startSec: 1384, endSec: 1430 }],
      actualDurationSec: 1430,
      expectedRuntimeMin: 22,
    });
    expect(c.kind).toBe("not-candidate");
  });
});

describe("detectSplitPairedCandidate", () => {
  it("detects a split candidate without requiring the next file to exist", () => {
    const c = detectSplitPairedCandidate({
      chapters: [
        { startSec: 0, endSec: 47 },
        { startSec: 47, endSec: 719 },
        { startSec: 719, endSec: 1384 },
        { startSec: 1384, endSec: 1429 },
        { startSec: 1429, endSec: 1430 },
      ],
      actualDurationSec: 1430,
      expectedRuntimeMin: 11,
    });
    expect(c.kind).toBe("paired-split-candidate");
    expect(c.policy).toBe("split-paired-episode");
    expect(c.splitOutputs?.oddKeep).toEqual([{ startSec: 47, endSec: 719 }, { startSec: 1384, endSec: 1430 }]);
    expect(c.splitOutputs?.evenKeep).toEqual([{ startSec: 719, endSec: 1384 }, { startSec: 1384, endSec: 1430 }]);
  });

  it("extends kept outro ranges through trailing stub chapters", () => {
    const c = detectSplitPairedCandidate({
      chapters: [
        { startSec: 0, endSec: 47 },
        { startSec: 47, endSec: 719 },
        { startSec: 719, endSec: 1384 },
        { startSec: 1384, endSec: 1429 },
        { startSec: 1429, endSec: 1430 }, // trailing stub
      ],
      actualDurationSec: 1430,
      expectedRuntimeMin: 11,
    });
    expect(c.kind).toBe("paired-split-candidate");
    expect(c.splitOutputs?.oddKeep[0]).toEqual({ startSec: 47, endSec: 719 });
    // Odd keep includes the outro extended through the trailing stub.
    expect(c.splitOutputs?.oddKeep[1]).toEqual({ startSec: 1384, endSec: 1430 });
    expect(c.splitOutputs?.evenKeep).toEqual([{ startSec: 719, endSec: 1384 }, { startSec: 1384, endSec: 1430 }]);
  });

  it("ignores leading stub chapters when detecting split candidates", () => {
    const c = detectSplitPairedCandidate({
      chapters: [
        { startSec: 0, endSec: 0 }, // leading stub from archived MP4 chapter export
        { startSec: 0, endSec: 48 },
        { startSec: 48, endSec: 703 },
        { startSec: 703, endSec: 1361 },
        { startSec: 1361, endSec: 1408 },
      ],
      actualDurationSec: 1408,
      expectedRuntimeMin: 11,
    });
    expect(c.kind).toBe("paired-split-candidate");
    expect(c.splitOutputs?.oddKeep).toEqual([{ startSec: 48, endSec: 703 }, { startSec: 1361, endSec: 1408 }]);
    expect(c.splitOutputs?.evenKeep).toEqual([{ startSec: 703, endSec: 1361 }, { startSec: 1361, endSec: 1408 }]);
  });

  it("rejects files that are not long paired shapes", () => {
    expect(detectSplitPairedCandidate({ chapters: [], actualDurationSec: 1430, expectedRuntimeMin: 11 }).kind).toBe("insufficient-evidence");
    const short = detectSplitPairedCandidate({
      chapters: [{ startSec: 0, endSec: 700 }],
      actualDurationSec: 700,
      expectedRuntimeMin: 11,
    });
    expect(short.kind).toBe("not-candidate");
    const fullLength = detectSplitPairedCandidate({
      chapters: [{ startSec: 0, endSec: 47 }, { startSec: 47, endSec: 719 }, { startSec: 719, endSec: 1384 }, { startSec: 1384, endSec: 1430 }],
      actualDurationSec: 1430,
      expectedRuntimeMin: 22,
    });
    expect(fullLength.kind).toBe("not-candidate");
  });
});

describe("classifyFile", () => {
  describe("real S1/S2 fixtures", () => {
    it("classifies a full episode (S1 long-file shape: intro + 2 acts + outro + stub)", () => {
      const c = classifyFile([47, 662, 662, 45, 1], 1417);
      expect(c.category).toBe("full");
      expect(c.confidence).toBe("high");
      expect(c.evidence).toContain("intro");
    });

    it("classifies a no-theme episode (S1 short-file shape: act + outro + stub)", () => {
      const c = classifyFile([662, 45, 1], 708);
      expect(c.category).toBe("no-theme");
      expect(c.confidence).toBe("high");
    });

    it("classifies S2 D1 long file C2_t00 (48|666|655|44|1)", () => {
      const c = classifyFile([48, 666, 655, 44, 1], 1413);
      expect(c.category).toBe("full");
      expect(c.confidence).toBe("high");
    });

    it("classifies S2 D1 short file C3_t01 (655|44|1)", () => {
      const c = classifyFile([655, 44, 1], 700);
      expect(c.category).toBe("no-theme");
      expect(c.confidence).toBe("high");
    });

    it("classifies S2 D2 long file C9_t06 (47|661|655|48|1)", () => {
      const c = classifyFile([47, 661, 655, 48, 1], 1412);
      expect(c.category).toBe("full");
    });
  });

  describe("edge cases", () => {
    it("classifies three large acts as possible-half (documented outcome)", () => {
      const c = classifyFile([47, 660, 660, 660, 45], 2072);
      expect(c.category).toBe("possible-half");
      expect(c.confidence).toBe("medium");
    });

    it("classifies two acts without intro as no-theme (complete episode, medium confidence)", () => {
      const c = classifyFile([655, 658], 1313);
      expect(c.category).toBe("no-theme");
      expect(c.confidence).toBe("medium");
    });

    it("classifies intro + single act as possible-half (possibly first half)", () => {
      const c = classifyFile([47, 660], 707);
      expect(c.category).toBe("possible-half");
    });

    it("classifies a single act without outro as unknown (could be a split half)", () => {
      const c = classifyFile([660], 660);
      expect(c.category).toBe("unknown");
      expect(c.confidence).toBe("low");
    });

    it("returns unknown with 'no chapter data' when there are no chapters", () => {
      const c = classifyFile([], 1400);
      expect(c.category).toBe("unknown");
      expect(c.evidence).toContain("no chapter data");
    });

    it("returns unknown (not extra) when neither chapters nor duration are known", () => {
      const c = classifyFile([], null);
      expect(c.category).toBe("unknown");
      expect(c.confidence).toBe("low");
      expect(c.evidence).toContain("no chapter data and no duration");
    });

    it("treats a short file without chapters as an extra candidate", () => {
      const c = classifyFile([], 200);
      expect(c.category).toBe("extra");
      expect(c.confidence).toBe("low");
    });

    it("treats a short file with chapters as extra regardless of shape", () => {
      const c = classifyFile([60, 120], 180);
      expect(c.category).toBe("extra");
      expect(c.confidence).toBe("medium");
    });

    it("ignores trailing stub chapters shorter than the stub threshold", () => {
      const withStub = classifyFile([47, 662, 662, 45, 1], 1417);
      const withoutStub = classifyFile([47, 662, 662, 45], 1416);
      expect(withoutStub.category).toBe("full");
      expect(withStub.category).toBe(withoutStub.category);
    });

    it("handles only-stub chapters as unknown", () => {
      const c = classifyFile([1, 0], 2);
      expect(c.category).toBe("unknown");
    });

    it("falls back to the sum of chapter durations when totalSec is null", () => {
      const c = classifyFile([47, 662, 662, 45, 1], null);
      expect(c.category).toBe("full");
    });
  });

  describe("threshold sanity", () => {
    it("keeps the documented threshold relationships", () => {
      // Guards against accidental tuning that breaks pattern separation.
      expect(THRESHOLDS.introMinSec).toBeLessThan(THRESHOLDS.actMinSec);
      expect(THRESHOLDS.outroMaxSec).toBeLessThan(THRESHOLDS.actMinSec);
      expect(THRESHOLDS.stubMaxSec).toBeLessThan(THRESHOLDS.introMinSec);
    });
  });
});
