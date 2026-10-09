import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export interface ProbeStream {
  index: number;
  codecType: string;
  codecName: string;
}

export interface MediaProbe {
  durationSec: number | null;
  streams: ProbeStream[];
}

export interface ChapterSpan {
  startSec: number;
  endSec: number;
}

export class FfmpegError extends Error {}

const VIDEO_OK = new Set(["mpeg2video", "h264", "hevc", "mpeg4", "vc1"]);
const AUDIO_OK = new Set(["aac", "ac3", "eac3", "mp3", "opus"]);
const SUBTITLE_TEXT = new Set(["subrip", "srt", "mov_text", "ass"]);

export interface StreamPlan {
  video: ProbeStream;
  audio: ProbeStream[];
  subtitles: { stream: ProbeStream; outCodec: string }[];
  skipped: { codecType: string; codecName: string; reason: string }[];
  errors: string[];
}

/**
 * Run ffprobe and parse streams + duration.
 * `ffprobeBin` is the runtime (spawn) path; `filePath` must already be in
 * the form the Windows media binary understands.
 */
export async function probeMedia(ffprobeBin: string, filePath: string): Promise<MediaProbe> {
  const args = [
    "-v", "error",
    "-show_entries", "stream=index,codec_type,codec_name:format=duration",
    "-of", "json",
    filePath,
  ];
  const out = await runCapture(ffprobeBin, args);
  let doc: {
    streams?: { index: number; codec_type: string; codec_name: string }[];
    format?: { duration?: string };
  };
  try {
    doc = JSON.parse(out);
  } catch {
    throw new FfmpegError(`ffprobe returned invalid JSON for ${filePath}: ${out.slice(0, 200)}`);
  }
  const durationSec = doc.format?.duration ? Number(doc.format.duration) : null;
  return {
    durationSec: durationSec !== null && Number.isFinite(durationSec) ? durationSec : null,
    streams: (doc.streams ?? []).map((s) => ({
      index: s.index,
      codecType: String(s.codec_type),
      codecName: String(s.codec_name),
    })),
  };
}

/**
 * Run ffprobe and return chapter spans (empty array when the file has no
 * chapters). Sibling of probeMedia so the remux path's probe stays lean.
 */
export async function probeChapters(ffprobeBin: string, filePath: string): Promise<ChapterSpan[]> {
  const args = ["-v", "error", "-show_entries", "chapter=start_time,end_time", "-of", "json", filePath];
  const out = await runCapture(ffprobeBin, args);
  let doc: { chapters?: { start_time?: string | number; end_time?: string | number }[] };
  try {
    doc = JSON.parse(out);
  } catch {
    throw new FfmpegError(`ffprobe returned invalid JSON for ${filePath}: ${out.slice(0, 200)}`);
  }
  return (doc.chapters ?? []).map((c) => ({
    startSec: Number(c.start_time),
    endSec: Number(c.end_time),
  }));
}

function runCapture(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new FfmpegError(`${path.basename(bin)} exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

/**
 * Decide which streams go into the MP4 under the v1 policy:
 * main video + all compatible audio + text-based subtitles (converted to
 * mov_text). Everything else is skipped with a reason.
 */
export function planStreams(probe: MediaProbe): StreamPlan {
  const errors: string[] = [];
  const skipped: StreamPlan["skipped"] = [];

  const videos = probe.streams.filter((s) => s.codecType === "video");
  if (videos.length === 0) {
    errors.push("no video stream found in source");
  } else if (videos.length > 1) {
    errors.push(`${videos.length} video streams found; v1 expects exactly one (source may be a multi-angle rip)`);
  }

  const audio: ProbeStream[] = [];
  for (const s of probe.streams.filter((x) => x.codecType === "audio")) {
    if (AUDIO_OK.has(s.codecName)) audio.push(s);
    else skipped.push({ codecType: "audio", codecName: s.codecName, reason: `codec ${s.codecName} is not MP4-compatible` });
  }

  const subtitles: StreamPlan["subtitles"] = [];
  for (const s of probe.streams.filter((x) => x.codecType === "subtitle")) {
    if (SUBTITLE_TEXT.has(s.codecName)) {
      subtitles.push({ stream: s, outCodec: s.codecName === "ass" ? "copy" : "mov_text" });
    } else {
      skipped.push({ codecType: "subtitle", codecName: s.codecName, reason: `${s.codecName} subtitles cannot be stored in MP4` });
    }
  }

  const video = videos[0] ?? { index: -1, codecType: "video", codecName: "none" };
  if (video.index >= 0 && !VIDEO_OK.has(video.codecName)) {
    errors.push(`video codec ${video.codecName} is not in the v1 MP4 allowlist (${[...VIDEO_OK].join(", ")})`);
  }

  return { video, audio, subtitles, skipped, errors };
}

/** Per-type stream ordinal (0-based) for ffmpeg -map expressions. */
function typeOrdinal(probe: MediaProbe, target: ProbeStream): number {
  let n = -1;
  for (const s of probe.streams) {
    if (s.codecType !== target.codecType) continue;
    n++;
    if (s.index === target.index) return n;
  }
  return -1;
}

export function buildRemuxArgs(input: string, outputTmp: string, probe: MediaProbe, plan: StreamPlan): string[] {
  const args = ["-y", "-i", input, "-map", "0:v:0", "-c:v", "copy"];
  for (const a of plan.audio) {
    args.push("-map", `0:a:${typeOrdinal(probe, a)}`);
  }
  if (plan.audio.length > 0) args.push("-c:a", "copy");
  // Group subtitles by output codec so each -c:s applies to its mapped group.
  const groups = new Map<string, number[]>();
  for (const sub of plan.subtitles) {
    const ord = typeOrdinal(probe, sub.stream);
    groups.set(sub.outCodec, [...(groups.get(sub.outCodec) ?? []), ord]);
  }
  for (const [codec, ords] of groups) {
    for (const ord of ords) args.push("-map", `0:s:${ord}`);
    args.push("-c:s", codec);
  }
  args.push(outputTmp);
  return args;
}

export interface RemuxResult {
  skipped: StreamPlan["skipped"];
  durationSec: number | null;
}

/** Probe, plan, and remux input -> outputTmp. Throws FfmpegError on failure. */
export async function remuxToTmp(opts: {
  ffmpegBin: string;
  ffprobeBin: string;
  mediaToolPath: (p: string) => string;
  input: string;
  outputTmp: string;
}): Promise<RemuxResult> {
  const probe = await probeMedia(opts.ffprobeBin, opts.mediaToolPath(opts.input));
  const plan = planStreams(probe);
  if (plan.errors.length > 0) {
    throw new FfmpegError(`Stream policy violations for ${opts.input}:\n${plan.errors.map((e) => `  - ${e}`).join("\n")}`);
  }

  const args = buildRemuxArgs(opts.mediaToolPath(opts.input), opts.mediaToolPath(opts.outputTmp), probe, plan);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(opts.ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new FfmpegError(`ffmpeg exited ${code} for ${opts.input}: ${stderr.slice(-800)}`));
    });
  });

  return { skipped: plan.skipped, durationSec: probe.durationSec };
}

/** Remove a zero-byte temp file left behind by a failed conversion. */
export async function cleanupTempIfEmpty(tmpPath: string): Promise<void> {
  try {
    const st = await fs.stat(tmpPath);
    if (st.size === 0) await fs.unlink(tmpPath);
  } catch {
    /* already gone */
  }
}
