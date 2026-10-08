import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildManifestView, ConfigError, loadConfig, validateManifest } from "../src/config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "vs-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(name: string, toml: string): string {
  const p = path.join(dir, name);
  writeFileSync(p, toml, "utf8");
  return p;
}

const validToml = `
[show]
tmdb_id = 12345
name = "Aaahh Real Monsters"
season = 1

[paths]
source_root = "."
local_output = "./_converted"
destination_root = "Z:/tm_share/videos/shows"

[disc.ARM_S1_D1]
"B3_t09.mkv" = 1
"B5_t08.mkv" = 2
`;

describe("loadConfig", () => {
  it("parses a valid TOML manifest", () => {
    const p = writeConfig("ok.toml", validToml);
    const { config, configDir } = loadConfig(p);
    expect(config.show.tmdb_id).toBe(12345);
    expect(config.paths.destination_root).toBe("Z:/tm_share/videos/shows");
    expect(config.disc.ARM_S1_D1?.["B3_t09.mkv"]).toBe(1);
    expect(configDir).toBe(dir);
  });

  it("fails with a clear error when the file is missing", () => {
    expect(() => loadConfig(path.join(dir, "nope.toml"))).toThrow(ConfigError);
  });

  it("reports invalid TOML", () => {
    const p = writeConfig("bad.toml", "this is [ not toml");
    expect(() => loadConfig(p)).toThrow(/Invalid TOML/);
  });

  it("fails when [show] is missing", () => {
    const p = writeConfig(
      "no-show.toml",
      `[paths]\nsource_root = "."\nlocal_output = "./o"\ndestination_root = "Z:/x"`,
    );
    expect(() => loadConfig(p)).toThrow(/\[?show|show/);
  });

  it("fails when [paths] is missing", () => {
    const p = writeConfig(
      "no-paths.toml",
      `[show]\ntmdb_id = 1\nname = "X"\nseason = 1`,
    );
    expect(() => loadConfig(p)).toThrow(/paths/);
  });

  it("rejects non-integer episode numbers", () => {
    const p = writeConfig(
      "bad-ep.toml",
      validToml.replace('"B3_t09.mkv" = 1', '"B3_t09.mkv" = 1.5'),
    );
    expect(() => loadConfig(p)).toThrow(ConfigError);
  });
});

describe("validateManifest", () => {
  function viewFor(toml: string) {
    const p = writeConfig(`v-${Math.random().toString(36).slice(2)}.toml`, toml);
    return buildManifestView(loadConfig(p).config);
  }

  it("accepts a clean mapping", () => {
    expect(validateManifest(viewFor(validToml))).toEqual([]);
  });

  it("blocks episode 0 TODO entries", () => {
    const v = viewFor(validToml.replace('"B5_t08.mkv" = 2', '"B5_t08.mkv" = 0'));
    expect(validateManifest(v)).toEqual([
      expect.stringContaining("still 0 (TODO)"),
    ]);
  });

  it("rejects absolute mapped filenames", () => {
    const v = viewFor(validToml.replace('"B3_t09.mkv"', '"/etc/passwd"'));
    expect(validateManifest(v)).toEqual([expect.stringContaining("relative")]);
  });

  it("rejects .. traversal in mapped filenames", () => {
    const v = viewFor(validToml.replace('"B3_t09.mkv"', '"../evil.mkv"'));
    expect(validateManifest(v)).toEqual([expect.stringContaining('".."')]);
  });

  it("detects duplicate episode numbers across discs", () => {
    const toml = validToml + `
[disc.ARM_S1_D2]
"C2_t00.mkv" = 1
`;
    expect(validateManifest(viewFor(toml))).toEqual([
      expect.stringContaining("mapped twice"),
    ]);
  });

  it("tracks ignored files and title overrides", () => {
    const toml =
      validToml +
      `
[ignore.ARM_S1_D1]
"B7_t11.mkv" = "bonus feature"

[title_override.ARM_S1_D1]
"B3_t09.mkv" = "Manual Title"
`;
    const v = viewFor(toml);
    expect(v.ignored.get("ARM_S1_D1")?.has("B7_t11.mkv")).toBe(true);
    expect(v.ignoredReasons.get("ARM_S1_D1/B7_t11.mkv")).toBe("bonus feature");
    expect(v.overrides.get("ARM_S1_D1")?.get("B3_t09.mkv")).toBe("Manual Title");
  });
});
