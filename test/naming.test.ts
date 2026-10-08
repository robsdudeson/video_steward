import { describe, expect, it } from "vitest";
import { formatEpisode, outputFileName, sanitizeTitle, seasonFolderName, showSeasonDir } from "../src/naming.js";

describe("sanitizeTitle", () => {
  it("removes Windows-invalid characters", () => {
    expect(sanitizeTitle('Monsters: Get Real?')).toBe("Monsters Get Real");
    expect(sanitizeTitle('a<b>c"d|e*f/g\\h')).toBe("a b c d e f g h");
  });

  it("removes forward and back slash", () => {
    expect(sanitizeTitle("season/episode")).toBe("season episode");
    expect(sanitizeTitle("season\\episode")).toBe("season episode");
  });

  it("strips control characters", () => {
    // Control chars become spaces, then whitespace is collapsed.
    expect(sanitizeTitle("ab\u0000cd\u001fe")).toBe("ab cd e");
  });

  it("collapses repeated whitespace and trims", () => {
    expect(sanitizeTitle("  The   Long   Title  ")).toBe("The Long Title");
  });

  it("trims trailing periods", () => {
    expect(sanitizeTitle("Ends with dots...")).toBe("Ends with dots");
  });

  it("avoids reserved Windows names", () => {
    expect(sanitizeTitle("CON")).toBe("_CON");
    expect(sanitizeTitle("com1.txt")).toBe("_com1.txt");
  });

  it("caps length", () => {
    const long = "x".repeat(300);
    expect(sanitizeTitle(long).length).toBeLessThanOrEqual(120);
  });

  it("falls back to Untitled for empty input", () => {
    expect(sanitizeTitle("")).toBe("Untitled");
    expect(sanitizeTitle('***')).toBe("Untitled");
  });
});

describe("formatting", () => {
  it("formats episode codes zero-padded", () => {
    expect(formatEpisode(1, 1)).toBe("S01E01");
    expect(formatEpisode(12, 3)).toBe("S12E03");
  });

  it("formats season folder names", () => {
    expect(seasonFolderName(1)).toBe("Season 01");
  });

  it("builds show/season directories", () => {
    expect(showSeasonDir("Aaahh Real Monsters", 1)).toBe("Aaahh Real Monsters/Season 01");
    expect(showSeasonDir('Weird:Name?', 2)).toBe("Weird Name/Season 02");
  });

  it("builds destination filenames", () => {
    expect(outputFileName("Aaahh Real Monsters", 1, 1, "Monsters, Get Real")).toBe(
      "Aaahh Real Monsters - S01E01 - Monsters, Get Real.mp4",
    );
  });
});
