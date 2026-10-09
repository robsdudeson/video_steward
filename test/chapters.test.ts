import { describe, expect, it } from "vitest";
import { classifyFile, spansToDurations, THRESHOLDS } from "../src/chapters.js";

describe("spansToDurations", () => {
  it("computes per-chapter durations", () => {
    expect(spansToDurations([{ startSec: 0, endSec: 47 }, { startSec: 47, endSec: 709 }])).toEqual([47, 662]);
  });

  it("returns empty for no chapters", () => {
    expect(spansToDurations([])).toEqual([]);
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
