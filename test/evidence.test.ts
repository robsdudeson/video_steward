import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectDiscEvidence,
  findTgaps,
  isFresh,
  parseTNumber,
  sortEvidenceRows,
  type EvidenceRow,
} from "../src/evidence.js";

const S2_D1_FILES = [
  "C10_t07.mkv",
  "C2_t00.mkv",
  "C3_t01.mkv",
  "C4_t02.mkv",
  "C5_t03.mkv",
  "C6_t04.mkv",
  "C7_t05.mkv",
  "C9_t06.mkv",
  "D2_t08.mkv",
  "D3_t09.mkv",
  "D4_t10.mkv",
  "D5_t11.mkv",
  "D7_t12.mkv",
  "D8_t13.mkv",
];

function row(file: string, tNumber: number | null): EvidenceRow {
  return {
    file,
    tNumber,
    durationSec: null,
    sizeBytes: 0,
    fresh: false,
    classification: { category: "unknown", confidence: "low", evidence: "" },
  };
}

describe("parseTNumber", () => {
  it("parses MakeMKV-style t-numbers", () => {
    expect(parseTNumber("D2_t08.mkv")).toBe(8);
    expect(parseTNumber("C10_t07.mkv")).toBe(7); // C10 is button position, not the t-number
    expect(parseTNumber("x_T42.MKV")).toBe(42);
  });

  it("returns null when no t-number suffix exists", () => {
    expect(parseTNumber("menu.mkv")).toBeNull();
    expect(parseTNumber("t07.mkv")).toBeNull(); // needs the _t prefix
  });
});

describe("sortEvidenceRows", () => {
  it("orders S2 D1 filenames in t-order C2_t00 ... D8_t13 (sequence 0-13)", () => {
    const rows = sortEvidenceRows(S2_D1_FILES.map((f) => row(f, parseTNumber(f))));
    expect(rows.map((r) => r.tNumber)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(rows[0]?.file).toBe("C2_t00.mkv");
    expect(rows[13]?.file).toBe("D8_t13.mkv");
  });

  it("puts files without a t-number last in filename order", () => {
    const rows = sortEvidenceRows([
      row("menu.mkv", null),
      row("B_t02.mkv", 2),
      row("A_t01.mkv", 1),
      row("zzz.mkv", null),
    ]);
    expect(rows.map((r) => r.file)).toEqual(["A_t01.mkv", "B_t02.mkv", "menu.mkv", "zzz.mkv"]);
  });
});

describe("findTgaps", () => {
  it("reports a missing t-number in the middle of a sequence", () => {
    expect(findTgaps([0, 1, 3])).toEqual(["t02"]);
  });

  it("reports no gaps for a complete sequence", () => {
    expect(findTgaps([0, 1, 2, 3, 4])).toEqual([]);
  });

  it("reports a missing prefix when the disc does not start at t00 (MakeMKV numbers per-disc from 0)", () => {
    expect(findTgaps([5, 6, 7])).toEqual(["t00", "t01", "t02", "t03", "t04"]);
  });

  it("returns nothing for fewer than two numbers", () => {
    expect(findTgaps([3])).toEqual([]);
    expect(findTgaps([])).toEqual([]);
  });
});

describe("isFresh", () => {
  const now = 1_000_000_000;
  it("flags files modified inside the window", () => {
    expect(isFresh(now - 2 * 60_000, now, 10)).toBe(true);
  });
  it("does not flag files older than the window", () => {
    expect(isFresh(now - 11 * 60_000, now, 10)).toBe(false);
  });
  it("does not flag future mtimes", () => {
    expect(isFresh(now + 60_000, now, 10)).toBe(false);
  });
});

describe("collectDiscEvidence", () => {
  it("lists files from a real folder with t-numbers, ordering, and freshness (no ffprobe)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "evidence-test-"));
    try {
      await fs.writeFile(path.join(dir, "D2_t08.mkv"), "x");
      await fs.writeFile(path.join(dir, "C2_t00.mkv"), "x");
      await fs.writeFile(path.join(dir, "menu.mkv"), "x");

      const now = Date.now();
      const ev = await collectDiscEvidence({
        discName: "TEST_D1",
        folder: dir,
        freshWindowMin: 10,
        nowMs: now,
      });

      expect(ev.discName).toBe("TEST_D1");
      expect(ev.rows.map((r) => r.file)).toEqual(["C2_t00.mkv", "D2_t08.mkv", "menu.mkv"]);
      expect(ev.rows[0]?.tNumber).toBe(0);
      expect(ev.rows[1]?.tNumber).toBe(8);
      expect(ev.rows[2]?.tNumber).toBeNull();
      // Files just written are inside the freshness window.
      expect(ev.rows.every((r) => r.fresh)).toBe(true);
      // Without ffprobe, classification degrades to unknown (no chapter data).
      expect(ev.rows.every((r) => r.classification.category === "unknown")).toBe(true);
      // Gap between t00 and t08 is reported.
      expect(ev.gapWarnings.join(" ")).toContain("t01");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("throws a readable error for a missing folder", async () => {
    await expect(
      collectDiscEvidence({ discName: "NOPE", folder: "/nonexistent/disc", freshWindowMin: 10 }),
    ).rejects.toThrow(/Cannot read disc folder/);
  });
});
