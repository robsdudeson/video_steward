import { describe, expect, it } from "vitest";
import { checkSeasonCount } from "../src/metadata.js";

describe("checkSeasonCount", () => {
  it("reports match for S1 (24 classified = 24 TMDb episodes)", () => {
    const c = checkSeasonCount(24, 24);
    expect(c.verdict).toBe("match");
    expect(c.hint).toBe("");
  });

  it("reports match for S2 (26 = 26)", () => {
    expect(checkSeasonCount(26, 26).verdict).toBe("match");
  });

  it("reports mismatch-low with an actionable hint when fewer files than episodes", () => {
    const c = checkSeasonCount(23, 24);
    expect(c.verdict).toBe("mismatch-low");
    expect(c.hint).toContain("TMDb lists 24 episodes but only 23 were classified");
    expect(c.hint).toContain("1 unaccounted for");
    expect(c.hint).toContain("needs-review");
  });

  it("reports mismatch-high when more files than episodes", () => {
    const c = checkSeasonCount(25, 24);
    expect(c.verdict).toBe("mismatch-high");
    expect(c.hint).toContain("1 extra");
  });
});
