import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertContained,
  PathError,
  posixToWindows,
  resolveBinary,
  resolveConfiguredPath,
  toMediaToolPath,
  windowsToPosix,
} from "../src/paths.js";

describe("drive path translation", () => {
  it("converts Windows drive paths to WSL /mnt form", () => {
    expect(windowsToPosix("C:/Users/rd/Videos")).toBe("/mnt/c/Users/rd/Videos");
    expect(windowsToPosix("Z:\\tm_share\\videos\\shows")).toBe("/mnt/z/tm_share/videos/shows");
  });

  it("leaves non-drive paths alone", () => {
    expect(windowsToPosix("/mnt/c/foo")).toBe("/mnt/c/foo");
    expect(windowsToPosix("./relative")).toBe("./relative");
  });

  it("converts /mnt drive paths back to Windows form", () => {
    expect(posixToWindows("/mnt/c/Users/rd/Videos")).toBe("C:/Users/rd/Videos");
    expect(posixToWindows("/mnt/z/tm_share")).toBe("Z:/tm_share");
  });

  it("leaves non-/mnt paths alone", () => {
    expect(posixToWindows("/home/rd/code")).toBe("/home/rd/code");
  });
});

describe("resolveConfiguredPath", () => {
  it("resolves relative paths against the config directory", () => {
    const p = resolveConfiguredPath("./ARM_S1_D1", "/mnt/c/Users/rd/Videos", "wsl");
    expect(p).toBe("/mnt/c/Users/rd/Videos/ARM_S1_D1");
  });

  it("translates Windows drive paths when running under WSL", () => {
    const p = resolveConfiguredPath("C:/Users/rd/Videos", "/somewhere", "wsl");
    expect(p).toBe("/mnt/c/Users/rd/Videos");
  });

  it("keeps Windows drive paths native on Windows", () => {
    const p = path.normalize(resolveConfiguredPath("C:/Users/rd/Videos", "C:/cfg", "windows"));
    expect(p.toLowerCase()).toBe(path.win32.normalize("C:/Users/rd/Videos").toLowerCase());
  });

  it("preserves spaces in paths", () => {
    const p = resolveConfiguredPath("Ah Real Monsters", "/mnt/c/Users/rd/Videos", "wsl");
    expect(p).toBe("/mnt/c/Users/rd/Videos/Ah Real Monsters");
  });

  it("rejects Windows drive paths on plain posix", () => {
    expect(() => resolveConfiguredPath("C:/x", "/tmp", "posix")).toThrow(PathError);
  });
});

describe("toMediaToolPath", () => {
  it("gives Windows binaries a Windows path under WSL", () => {
    expect(toMediaToolPath("/mnt/c/Users/rd/Videos/a.mkv", "wsl")).toBe("C:/Users/rd/Videos/a.mkv");
  });

  it("normalizes slashes on Windows", () => {
    expect(toMediaToolPath("C:/Users/rd/Videos/a.mkv", "windows")).toBe("C:\\Users\\rd\\Videos\\a.mkv");
  });
});

describe("assertContained", () => {
  const root = "/mnt/c/Users/rd/Videos/_converted";

  it("allows paths under the root", () => {
    assertContained(`${root}/Show/S01E01.mp4`, root, "local output");
    assertContained(root, root, "local output");
  });

  it("rejects sibling prefixes that share the name", () => {
    expect(() => assertContained(`${root}-evil/x.mp4`, root, "local output")).toThrow(PathError);
  });

  it("rejects escapes via ..", () => {
    expect(() => assertContained(path.normalize(`${root}/../elsewhere`), root, "local output")).toThrow(
      /escapes its approved root/,
    );
  });
});

describe("resolveBinary", () => {
  it("resolves an absolute path as-is", () => {
    expect(resolveBinary("/usr/bin/true")).toBe("/usr/bin/true");
  });

  it("finds a PATH executable or returns null", () => {
    const found = resolveBinary(process.platform === "win32" ? "cmd.exe" : "sh");
    if (process.platform === "linux") {
      expect(found).toMatch(/\/sh$/);
    } else {
      expect(found ?? "").not.toBe("");
    }
  });

  it("returns null for a name that is not on PATH", () => {
    expect(resolveBinary("definitely-not-a-real-binary-xyz")).toBeNull();
  });
});
