import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { assignEpisodes, emitDraft, renderDraftTOML, renderReport, type ClassifyResult } from "../src/classify.js";
import { buildManifestView, loadConfig, validateManifest, type AppConfig } from "../src/config.js";
import type { DiscEvidence, EvidenceRow } from "../src/evidence.js";

function row(file: string, tNumber: number | null, category: EvidenceRow["classification"]["category"]): EvidenceRow {
  return {
    file,
    tNumber,
    durationSec: 1400,
    sizeBytes: 1e9,
    fresh: false,
    classification: { category, confidence: "high", evidence: `${category} evidence` },
  };
}

function ev(discName: string, rows: EvidenceRow[], gapWarnings: string[] = []): DiscEvidence {
  return { discName, rows, gapWarnings };
}

const S1_D1 = ev("ARM_S1_D1", [
  row("D2_t00.mkv", 0, "full"),
  row("D3_t01.mkv", 1, "no-theme"),
  row("B9_t02.mkv", 2, "possible-half"),
]);
const S1_D2 = ev("ARM_S1_D2", [
  row("E2_t00.mkv", 0, "full"),
  row("menu.mkv", null, "extra"),
]);

describe("assignEpisodes", () => {
  it("numbers full/no-theme rows in t-order across discs in CLI order", () => {
    const episodes = assignEpisodes([S1_D1, S1_D2]);
    expect(episodes.get("ARM_S1_D1/D2_t00.mkv")).toBe(1);
    expect(episodes.get("ARM_S1_D1/D3_t01.mkv")).toBe(2);
    // possible-half and extra rows are never numbered
    expect(episodes.get("ARM_S1_D1/B9_t02.mkv")).toBeUndefined();
    expect(episodes.get("ARM_S1_D2/menu.mkv")).toBeUndefined();
    // numbering continues across discs
    expect(episodes.get("ARM_S1_D2/E2_t00.mkv")).toBe(3);
  });

  it("returns an empty map when nothing classifies as an episode", () => {
    expect(assignEpisodes([ev("X", [row("a.mkv", 0, "unknown")])]).size).toBe(0);
  });
});

describe("renderReport", () => {
  it("lists needs-review files, gap warnings, and the TMDb cross-check", () => {
    const result: ClassifyResult = {
      evidences: [S1_D1, S1_D2],
      episodes: assignEpisodes([S1_D1, S1_D2]),
      seasonCheck: { classified: 3, tmdbEpisodes: 3, verdict: "match", hint: "" },
      seasonCheckNote: null,
    };
    const report = renderReport(result, { freshWindowMin: 10 });
    expect(report).toContain("-> Ep 01");
    expect(report).toContain("Needs review (not numbered):");
    expect(report).toContain("[ARM_S1_D1] B9_t02.mkv — possible-half (high)");
    expect(report).toContain("[ARM_S1_D2] menu.mkv — extra (high)");
    expect(report).toContain("TMDb cross-check: 3 classified vs 3 episode(s) — MATCH");
  });

  it("surfaces gap warnings and mismatch notes", () => {
    const result: ClassifyResult = {
      evidences: [ev("D", [row("a.mkv", 0, "full"), row("c.mkv", 2, "full")], ["[D] missing t01 in t-number sequence"])],
      episodes: assignEpisodes([ev("D", [row("a.mkv", 0, "full"), row("c.mkv", 2, "full")])]),
      seasonCheck: { classified: 2, tmdbEpisodes: 4, verdict: "mismatch-low", hint: "" },
      seasonCheckNote: "TMDb lists 4 episodes but only 2 were classified — 2 unaccounted for. Check the needs-review list and t-gap warnings.",
    };
    const report = renderReport(result, { freshWindowMin: 10 });
    expect(report).toContain("WARNING: [D] missing t01 in t-number sequence");
    expect(report).toContain("MISMATCH-LOW");
    expect(report).toContain("2 unaccounted for");
  });

  it("prints a skipped cross-check note when TMDb is unavailable", () => {
    const result: ClassifyResult = {
      evidences: [],
      episodes: new Map(),
      seasonCheck: null,
      seasonCheckNote: "TMDb cross-check failed: network down",
    };
    expect(renderReport(result, { freshWindowMin: 10 })).toContain("TMDb cross-check failed: network down");
  });
});

describe("renderDraftTOML", () => {
  it("emits numbered entries and comments for needs-review files; output parses as TOML", () => {
    const evidences = [S1_D1, S1_D2];
    const result: ClassifyResult = {
      evidences,
      episodes: assignEpisodes(evidences),
      seasonCheck: null,
      seasonCheckNote: null,
    };
    const toml = renderDraftTOML(result);
    expect(toml).toContain('[disc.ARM_S1_D1]');
    expect(toml).toContain('"D2_t00.mkv" = 1');
    expect(toml).toContain('# "B9_t02.mkv" — possible-half (high)');
    // Needs-review files must not appear as active mapping entries.
    const doc = parse(toml) as { disc: Record<string, Record<string, number>> };
    expect(doc.disc["ARM_S1_D1"]).toEqual({ "D2_t00.mkv": 1, "D3_t01.mkv": 2 });
    expect(doc.disc["ARM_S1_D2"]).toEqual({ "E2_t00.mkv": 3 }); // numbering continues across discs
    // Needs-review files must not appear as active mapping entries.
    expect(Object.keys(doc.disc["ARM_S1_D1"] ?? {})).not.toContain("B9_t02.mkv");
    expect(Object.keys(doc.disc["ARM_S1_D2"] ?? {})).not.toContain("menu.mkv");
  });

  const sampleConfig: AppConfig = {
    show: { tmdb_id: 2429, name: "Aaahh Real Monsters", season: 1 },
    paths: {
      source_root: "C:/Users/rd/Videos",
      local_output: "C:/Users/rd/Videos/_converted",
      destination_root: "Z:/video/shows",
      ffmpeg: "ffmpeg.exe",
      ffprobe: "ffprobe.exe",
    },
    disc: {},
    ignore: {},
    title_override: {},
    share: { backend: "auto" },
  };

  it("carries show/paths from the config so the draft loads as a valid manifest", async () => {
    const evidences = [S1_D1, S1_D2];
    const result: ClassifyResult = { evidences, episodes: assignEpisodes(evidences), seasonCheck: null, seasonCheckNote: null };
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "classify-draft-"));
    try {
      const target = path.join(dir, "draft.toml");
      await emitDraft(result, { target, force: false, config: sampleConfig });

      const { config } = loadConfig(target);
      expect(config.show.tmdb_id).toBe(2429);
      expect(config.paths.destination_root).toBe("Z:/video/shows");
      expect(config.disc.ARM_S1_D1).toEqual({ "D2_t00.mkv": 1, "D3_t01.mkv": 2 });
      // No blocking validation errors (no TODOs, no duplicate episodes).
      expect(validateManifest(buildManifestView(config))).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("applies the season override to the carried show section", () => {
    const result: ClassifyResult = { evidences: [S1_D1], episodes: assignEpisodes([S1_D1]), seasonCheck: null, seasonCheckNote: null };
    const toml = renderDraftTOML(result, { config: sampleConfig, seasonOverride: 3 });
    expect(toml).toContain("season = 3");
  });

  it("emits a commented show/paths template when no config is supplied", () => {
    const result: ClassifyResult = { evidences: [S1_D1], episodes: assignEpisodes([S1_D1]), seasonCheck: null, seasonCheckNote: null };
    const toml = renderDraftTOML(result);
    expect(toml).toContain("# tmdb_id = 0");
    expect(toml).toContain("# source_root");
    // Template sections are commented out, not active table headers.
    expect(toml).not.toMatch(/^\[show\]/m);
    expect(toml).not.toMatch(/^\[paths\]/m);
  });
});

describe("emitDraft", () => {
  const result: ClassifyResult = { evidences: [S1_D1], episodes: assignEpisodes([S1_D1]), seasonCheck: null, seasonCheckNote: null };

  it("writes the draft and refuses to overwrite without force", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "classify-emit-"));
    try {
      const target = path.join(dir, "draft.toml");
      await emitDraft(result, { target, force: false });
      expect((await fs.readFile(target, "utf8")).length).toBeGreaterThan(0);

      await expect(emitDraft(result, { target, force: false })).rejects.toThrow(/already exists/);
      await emitDraft(result, { target, force: true }); // overwrites with --force
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("creates parent directories for the target", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "classify-emit-"));
    try {
      const target = path.join(dir, "nested", "drafts", "d.toml");
      await emitDraft(result, { target, force: false });
      expect(await fs.stat(target)).toBeTruthy();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
