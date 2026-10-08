import { describe, expect, it } from "vitest";
import { buildRemuxArgs, planStreams, type MediaProbe } from "../src/ffmpeg.js";

const dvdRip: MediaProbe = {
  durationSec: 1420.685,
  streams: [
    { index: 0, codecType: "video", codecName: "mpeg2video" },
    { index: 1, codecType: "audio", codecName: "ac3" },
    { index: 2, codecType: "audio", codecName: "ac3" },
    { index: 3, codecType: "subtitle", codecName: "subrip" },
  ],
};

describe("planStreams", () => {
  it("accepts a typical DVD rip (mpeg2/ac3/subrip)", () => {
    const plan = planStreams(dvdRip);
    expect(plan.errors).toEqual([]);
    expect(plan.video.codecName).toBe("mpeg2video");
    expect(plan.audio.map((a) => a.index)).toEqual([1, 2]);
    expect(plan.subtitles).toEqual([{ stream: dvdRip.streams[3]!, outCodec: "mov_text" }]);
    expect(plan.skipped).toEqual([]);
  });

  it("fails when there is no video stream", () => {
    const plan = planStreams({ durationSec: null, streams: [{ index: 0, codecType: "audio", codecName: "ac3" }] });
    expect(plan.errors).toEqual(["no video stream found in source"]);
  });

  it("fails on multiple video streams", () => {
    const plan = planStreams({
      durationSec: null,
      streams: [
        { index: 0, codecType: "video", codecName: "mpeg2video" },
        { index: 1, codecType: "video", codecName: "h264" },
      ],
    });
    expect(plan.errors[0]).toMatch(/exactly one/);
  });

  it("fails on a video codec outside the allowlist", () => {
    const plan = planStreams({ durationSec: null, streams: [{ index: 0, codecType: "video", codecName: "av1" }] });
    expect(plan.errors[0]).toMatch(/allowlist/);
  });

  it("drops PGS subtitles with a reason but keeps text ones", () => {
    const plan = planStreams({
      durationSec: null,
      streams: [
        { index: 0, codecType: "video", codecName: "h264" },
        { index: 1, codecType: "subtitle", codecName: "hdmv_pgs_subtitle" },
        { index: 2, codecType: "subtitle", codecName: "subrip" },
      ],
    });
    expect(plan.errors).toEqual([]);
    expect(plan.subtitles.map((s) => s.outCodec)).toEqual(["mov_text"]);
    expect(plan.skipped).toEqual([
      { codecType: "subtitle", codecName: "hdmv_pgs_subtitle", reason: "hdmv_pgs_subtitle subtitles cannot be stored in MP4" },
    ]);
  });

  it("drops non-MP4 audio codecs with a reason", () => {
    const plan = planStreams({
      durationSec: null,
      streams: [
        { index: 0, codecType: "video", codecName: "h264" },
        { index: 1, codecType: "audio", codecName: "dts" },
        { index: 2, codecType: "audio", codecName: "aac" },
      ],
    });
    expect(plan.audio.map((a) => a.index)).toEqual([2]);
    expect(plan.skipped[0]).toMatchObject({ codecType: "audio", codecName: "dts" });
  });

  it("copies ass subtitles without re-encoding", () => {
    const plan = planStreams({
      durationSec: null,
      streams: [
        { index: 0, codecType: "video", codecName: "h264" },
        { index: 1, codecType: "subtitle", codecName: "ass" },
      ],
    });
    expect(plan.subtitles[0]?.outCodec).toBe("copy");
  });
});

describe("buildRemuxArgs", () => {
  it("maps video + all compatible audio + text subtitles, all stream copy", () => {
    const plan = planStreams(dvdRip);
    const args = buildRemuxArgs("in.mkv", "out.tmp.mp4", dvdRip, plan);
    expect(args).toEqual([
      "-y", "-i", "in.mkv",
      "-map", "0:v:0", "-c:v", "copy",
      "-map", "0:a:0", "-map", "0:a:1", "-c:a", "copy",
      "-map", "0:s:0", "-c:s", "mov_text",
      "out.tmp.mp4",
    ]);
  });

  it("uses per-type ordinals, not global stream indices", () => {
    const probe: MediaProbe = {
      durationSec: null,
      streams: [
        { index: 0, codecType: "subtitle", codecName: "subrip" }, // subtitle first
        { index: 1, codecType: "video", codecName: "h264" },
        { index: 2, codecType: "audio", codecName: "aac" },
      ],
    };
    const plan = planStreams(probe);
    const args = buildRemuxArgs("in.mkv", "out.tmp.mp4", probe, plan);
    expect(args).toContain("-map");
    expect(args.join(" ")).toContain("0:s:0");
    expect(args.join(" ")).toContain("0:a:0");
  });
});
