import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPsCopyCommand,
  buildPsExistsCommand,
  copyFinal,
  psQuote,
  resolveShareBackend,
} from "../src/copy.js";

let dir: string;
let srcDir: string;
let destDir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "vs-copy-"));
  srcDir = path.join(dir, "local");
  mkdirSync(srcDir);
  destDir = path.join(dir, "dest", "Show", "Season 01");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("copyFinal", () => {
  it("copies atomically via temp + rename, creating parent dirs", async () => {
    const src = path.join(srcDir, "a.mp4");
    writeFileSync(src, "video-bytes");
    const res = await copyFinal({ src, destDir, fileName: "a.mp4" });
    expect(res.status).toBe("copied");
    expect(readFileSync(path.join(destDir, "a.mp4"), "utf8")).toBe("video-bytes");
    // no temp file left behind
    expect(() => statSync(path.join(destDir, ".a.mp4.tmp"))).toThrow();
  });

  it("skips an existing destination unless forced", async () => {
    const src = path.join(srcDir, "a.mp4");
    writeFileSync(src, "new-bytes");
    mkdirSync(destDir, { recursive: true });
    writeFileSync(path.join(destDir, "a.mp4"), "old-bytes");

    const skip = await copyFinal({ src, destDir, fileName: "a.mp4" });
    expect(skip.status).toBe("skipped-existing");
    expect(readFileSync(path.join(destDir, "a.mp4"), "utf8")).toBe("old-bytes");

    const force = await copyFinal({ src, destDir, fileName: "a.mp4", force: true });
    expect(force.status).toBe("copied");
    expect(readFileSync(path.join(destDir, "a.mp4"), "utf8")).toBe("new-bytes");
  });

  it("cleans up the temp file when the copy fails", async () => {
    const src = path.join(srcDir, "missing.mp4");
    const res = await copyFinal({ src, destDir, fileName: "missing.mp4" }).catch((e) => e);
    expect(res).toBeInstanceOf(Error);
    expect(() => statSync(path.join(destDir, ".missing.mp4.tmp"))).toThrow();
  });
});

describe("windows backend helpers", () => {
  it("psQuote doubles embedded single quotes", () => {
    expect(psQuote("C:/a b")).toBe("'C:/a b'");
    expect(psQuote("it's")).toBe("'it''s'");
  });

  it("buildPsCopyCommand mkdirs, copies to hidden tmp, then renames", () => {
    const cmd = buildPsCopyCommand("C:\\staging\\S01\\a.mp4", "Z:\\video\\shows\\Show\\S01", "a.mp4");
    expect(cmd).toContain("New-Item -ItemType Directory -Force -Path 'Z:\\video\\shows\\Show\\S01'");
    expect(cmd).toContain("Copy-Item -LiteralPath 'C:\\staging\\S01\\a.mp4' -Destination 'Z:\\video\\shows\\Show\\S01\\.a.mp4.tmp' -Force");
    expect(cmd).toContain("Move-Item -LiteralPath 'Z:\\video\\shows\\Show\\S01\\.a.mp4.tmp' -Destination 'Z:\\video\\shows\\Show\\S01\\a.mp4' -Force");
  });

  it("buildPsExistsCommand emits 1-based indices for existing paths", () => {
    const cmd = buildPsExistsCommand(["Z:/a.mp4", "Z:/b.mp4"]);
    expect(cmd).toContain("if (Test-Path -LiteralPath 'Z:/a.mp4') { Write-Output 1 }");
    expect(cmd).toContain("if (Test-Path -LiteralPath 'Z:/b.mp4') { Write-Output 2 }");
    expect(buildPsExistsCommand([])).toBe("exit 0");
  });

  it("resolveShareBackend honors explicit choices", () => {
    expect(resolveShareBackend("native", "/nonexistent")).toBe("native");
    expect(resolveShareBackend("windows", "/whatever")).toBe("windows");
  });

  it("resolveShareBackend auto picks native when the destination is reachable", () => {
    const real = mkdtempSync(path.join(tmpdir(), "vs-share-"));
    try {
      expect(resolveShareBackend("auto", real)).toBe("native");
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });
});
