import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendDiscToManifest, formatDuration, formatSize, renderStarterTOML, scanDiscFolder } from "../src/intake.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "vs-intake-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("scanDiscFolder", () => {
  it("lists top-level .mkv files sorted and ignores non-mkv", async () => {
    writeFileSync(path.join(dir, "b.mkv"), "x");
    writeFileSync(path.join(dir, "a.mkv"), "x");
    writeFileSync(path.join(dir, "notes.txt"), "x");
    mkdirSync(path.join(dir, "sub"));
    writeFileSync(path.join(dir, "sub", "c.mkv"), "x");

    const files = await scanDiscFolder(dir);
    expect(files.map((f) => f.file)).toEqual(["a.mkv", "b.mkv"]);
  });

  it("fails clearly for a missing folder", async () => {
    await expect(scanDiscFolder(path.join(dir, "nope"))).rejects.toThrow(/Cannot read disc folder/);
  });
});

describe("renderStarterTOML", () => {
  it("emits TODO episode numbers with duration and size hints", () => {
    const toml = renderStarterTOML("ARM_S1_D3", [
      { file: "B2_t00.mkv", sizeBytes: 1.2 * 1024 ** 3, durationSec: 23 * 60 + 41 },
      { file: "B4_t02.mkv", sizeBytes: 210 * 1024 ** 2, durationSec: 4 * 60 + 12 },
    ]);
    expect(toml).toContain('[disc.ARM_S1_D3]');
    expect(toml).toContain('"B2_t00.mkv" = 0 # TODO episode; 00:23:41; 1.2 GB');
    expect(toml).toContain('"B4_t02.mkv" = 0 # TODO episode; 00:04:12; 210 MB ; likely extra');
  });

  it("handles unknown duration", () => {
    const toml = renderStarterTOML("D", [{ file: "a.mkv", sizeBytes: 1024, durationSec: null }]);
    expect(toml).toContain("duration unknown");
  });
});

describe("appendDiscToManifest", () => {
  it("appends a new section without clobbering existing content", async () => {
    const cfg = path.join(dir, "m.toml");
    writeFileSync(cfg, '[show]\nname = "X"\n');
    await appendDiscToManifest(cfg, "ARM_S1_D3", "[disc.ARM_S1_D3]\n\"a.mkv\" = 0");
    const raw = readFileSync(cfg, "utf8");
    expect(raw).toContain('[show]\nname = "X"');
    expect(raw).toContain("[disc.ARM_S1_D3]");
    expect(raw.trimEnd().endsWith('"a.mkv" = 0')).toBe(true);
  });

  it("refuses to overwrite an existing [disc.NAME] section", async () => {
    const cfg = path.join(dir, "m.toml");
    writeFileSync(cfg, "[disc.ARM_S1_D3]\n\"a.mkv\" = 1\n");
    await expect(appendDiscToManifest(cfg, "ARM_S1_D3", "[disc.ARM_S1_D3]")).rejects.toThrow(
      /already exists/,
    );
  });

  it("does not confuse similarly-named discs", async () => {
    const cfg = path.join(dir, "m.toml");
    writeFileSync(cfg, "[disc.ARM_S1_D3X]\n\"a.mkv\" = 1\n");
    await appendDiscToManifest(cfg, "ARM_S1_D3", "[disc.ARM_S1_D3]\n\"b.mkv\" = 0");
    const raw = readFileSync(cfg, "utf8");
    expect(raw).toContain("[disc.ARM_S1_D3X]");
    expect(raw).toContain("[disc.ARM_S1_D3]");
  });
});

describe("formatters", () => {
  it("formats durations as HH:MM:SS", () => {
    expect(formatDuration(1420.685)).toBe("00:23:41");
    expect(formatDuration(null)).toBe("duration unknown");
  });

  it("never lets seconds round up to 60", () => {
    expect(formatDuration(719.6)).toBe("00:12:00");
    expect(formatDuration(3599.9)).toBe("01:00:00");
  });

  it("formats sizes in human units", () => {
    expect(formatSize(210 * 1024 ** 2)).toBe("210 MB");
    expect(formatSize(1.2 * 1024 ** 3)).toBe("1.2 GB");
  });
});
