import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPsCopyFileCommand,
  buildPsListFilesCommand,
  buildPsRenameCommand,
  buildPsStatCommand,
  copyVerified,
  mediaFsForPath,
  shouldUsePowerShellMediaFs,
} from "../src/media-fs.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "vs-media-fs-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("mediaFsForPath", () => {
  it("uses native fs for visible local paths", async () => {
    writeFileSync(path.join(dir, "b.mp4"), "bb");
    writeFileSync(path.join(dir, "a.mp4"), "a");
    writeFileSync(path.join(dir, "note.txt"), "x");
    const fs = mediaFsForPath(dir);
    const files = await fs.listFiles(dir, ".mp4");
    expect(files.map((f) => f.name)).toEqual(["a.mp4", "b.mp4"]);
    expect(files[0]?.sizeBytes).toBe(1);
  });

  it("detects inaccessible Windows drive paths under WSL as PowerShell-backed", () => {
    expect(shouldUsePowerShellMediaFs("Z:/video/shows", "wsl")).toBe(true);
    expect(shouldUsePowerShellMediaFs("/mnt/c/video", "wsl")).toBe(false);
  });

  it("copyVerified catches size mismatches", async () => {
    const src = path.join(dir, "src.bin");
    const dest = path.join(dir, "dest.bin");
    writeFileSync(src, "abc");
    mkdirSync(path.dirname(dest), { recursive: true });
    const fake = {
      async exists() { return true; },
      async listFiles() { return []; },
      async stat(p: string) { return { sizeBytes: p === src ? 3 : 2, mtimeMs: 0 }; },
      async mkdirp() {},
      async copy() { writeFileSync(dest, "ab"); },
      async rename() {},
    };
    await expect(copyVerified(fake, src, dest)).rejects.toThrow(/Size mismatch/);
  });
});

describe("PowerShell command builders", () => {
  it("builds list/stat/copy/rename commands using LiteralPath", () => {
    expect(buildPsListFilesCommand("Z:\\video\\shows", ".mp4")).toContain("Get-ChildItem -LiteralPath $p -File -Filter '*.mp4'");
    expect(buildPsStatCommand("Z:\\a.mp4")).toContain("Get-Item -LiteralPath $p");
    expect(buildPsCopyFileCommand("C:\\a.mp4", "Z:\\a.mp4")).toContain("Copy-Item -LiteralPath $src -Destination $dest -Force");
    expect(buildPsRenameCommand("Z:\\.a.tmp", "Z:\\a.mp4", true)).toContain("Move-Item -LiteralPath $src -Destination $dest -Force");
  });
});
