import fs from "node:fs/promises";
import path from "node:path";
import { probeMedia } from "./ffmpeg.js";
import { toMediaToolPath } from "./paths.js";

export interface ScannedFile {
  file: string;
  sizeBytes: number;
  durationSec: number | null;
}

const LIKELY_EXTRA_THRESHOLD_SEC = 15 * 60;

/** List top-level .mkv files in a disc folder with size + duration evidence. */
export async function scanDiscFolder(
  folder: string,
  opts?: { ffprobeBin: string },
): Promise<ScannedFile[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(folder);
  } catch (err) {
    throw new Error(`Cannot read disc folder ${folder}: ${(err as Error).message}`);
  }

  const files = entries.filter((f) => f.toLowerCase().endsWith(".mkv")).sort();
  const out: ScannedFile[] = [];
  for (const file of files) {
    const full = path.join(folder, file);
    let sizeBytes = 0;
    try {
      sizeBytes = (await fs.stat(full)).size;
    } catch {
      /* stat failed; keep zero */
    }

    let durationSec: number | null = null;
    if (opts?.ffprobeBin) {
      try {
        // ffprobe runs as a Windows binary under WSL; convert the file path
        // to the form that binary understands.
        const probe = await probeMedia(opts.ffprobeBin, toMediaToolPath(full));
        durationSec = probe.durationSec;
      } catch {
        durationSec = null;
      }
    }
    out.push({ file, sizeBytes, durationSec });
  }
  return out;
}

export function formatDuration(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return "duration unknown";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** Render a starter TOML block for a scanned disc. Episode numbers are 0 (TODO). */
export function renderStarterTOML(discName: string, files: ScannedFile[]): string {
  const lines: string[] = [];
  for (const f of files) {
    const hint =
      f.durationSec !== null && f.durationSec < LIKELY_EXTRA_THRESHOLD_SEC ? " ; likely extra" : "";
    lines.push(
      `  "${f.file}" = 0 # TODO episode; ${formatDuration(f.durationSec)}; ${formatSize(f.sizeBytes)}${hint}`,
    );
  }
  return [`[disc.${discName}]`, ...lines].join("\n");
}

/** Append a starter [disc.NAME] section to an existing manifest without clobbering. */
export async function appendDiscToManifest(configPath: string, discName: string, block: string): Promise<void> {
  const raw = await fs.readFile(configPath, "utf8");
  const sectionRe = new RegExp(`^\\[disc\\s*\\.\\s*${escapeRegex(discName)}\\s*\\]`, "m");
  if (sectionRe.test(raw)) {
    throw new Error(`[disc.${discName}] already exists in ${configPath}; refusing to overwrite`);
  }
  const suffix = raw.endsWith("\n") ? "" : "\n";
  await fs.appendFile(configPath, `${suffix}\n${block}\n`, "utf8");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
