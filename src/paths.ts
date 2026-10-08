import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type Runtime = "windows" | "wsl" | "posix";

export class PathError extends Error {}

const DRIVE_RE = /^([A-Za-z]):[\\/]/;

/** Detect which filesystem world Node is running in. */
export function detectRuntime(): Runtime {
  if (process.platform === "win32") return "windows";
  if (process.platform !== "linux") return "posix";
  const release = os.release().toLowerCase();
  if (release.includes("microsoft") || existsSync("/proc/sys/fs/binfmt_misc/WSLInterop")) {
    return "wsl";
  }
  return "posix";
}

/** Convert `C:/foo` -> `/mnt/c/foo` (WSL view of a Windows drive path). */
export function windowsToPosix(p: string): string {
  const m = p.match(DRIVE_RE);
  if (!m || !m[1]) return p;
  return `/mnt/${m[1].toLowerCase()}/${p.slice(3).replace(/\\/g, "/")}`;
}

/** Convert `/mnt/c/foo` -> `C:/foo` (Windows view of a mounted drive path). */
export function posixToWindows(p: string): string {
  const m = p.match(/^\/mnt\/([a-z])(\/.*)?$/i);
  if (!m || !m[1]) return p;
  return `${m[1].toUpperCase()}:${m[2] ?? "/"}`;
}

/**
 * Resolve a configured path (absolute or relative to the config file's
 * directory) into an absolute POSIX-style path usable by Node fs on this
 * runtime. Windows drive paths are translated when running under WSL.
 */
export function resolveConfiguredPath(p: string, configDir: string, runtime: Runtime = detectRuntime()): string {
  const P = runtime === "windows" ? path.win32 : path.posix;
  let candidate = p;
  if (DRIVE_RE.test(candidate)) {
    if (runtime === "wsl") {
      candidate = windowsToPosix(candidate);
    } else if (runtime !== "windows") {
      throw new PathError(`Cannot use Windows drive path "${p}" on this runtime`);
    }
  }
  const abs = P.isAbsolute(candidate) ? candidate : P.resolve(configDir, candidate);
  return P.normalize(abs);
}

/**
 * Convert a runtime path into the form ffmpeg/ffprobe (Windows binaries
 * under WSL, native on Windows) will accept.
 */
export function toMediaToolPath(p: string, runtime: Runtime = detectRuntime()): string {
  if (runtime === "wsl") return posixToWindows(p);
  return p.replace(/\//g, "\\");
}

/** Throw unless child is root itself or lives underneath it. */
export function assertContained(child: string, root: string, label: string): void {
  const c = path.normalize(child);
  const r = path.normalize(root);
  if (c !== r && !c.startsWith(r + path.sep)) {
    throw new PathError(`${label} "${c}" escapes its approved root "${r}"`);
  }
}

/** Resolve a bare executable name against PATH, or pass through a path. */
export function resolveBinary(name: string): string | null {
  if (name.includes("/") || name.includes("\\") || DRIVE_RE.test(name)) return name;
  const exts = process.platform === "win32" ? ["", ".exe"] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export interface PreflightResult {
  ok: boolean;
  problems: string[];
  info: Record<string, string>;
}

/**
 * Verify the environment before any conversion work: source readable,
 * local output writable/creatable, media tools present, destination
 * writable unless skipping copy.
 */
export function runPreflight(opts: {
  sourceRoot: string;
  localOutput: string;
  destinationRoot: string;
  ffmpegBin: string;
  ffprobeBin: string;
  skipCopy: boolean;
  dryRun: boolean;
}): PreflightResult {
  const problems: string[] = [];
  const info: Record<string, string> = {};

  if (!existsSync(opts.sourceRoot) || !statSync(opts.sourceRoot).isDirectory()) {
    problems.push(`Source root is not a readable directory: ${opts.sourceRoot}`);
  } else {
    info.source_root = opts.sourceRoot;
  }

  const outDir = existsSync(opts.localOutput) ? opts.localOutput : null;
  if (outDir && !statSync(outDir).isDirectory()) {
    problems.push(`Local output path exists but is not a directory: ${opts.localOutput}`);
  } else if (!outDir) {
    try {
      // Do not create it during pure checks; just verify the parent allows it.
      const parent = path.dirname(opts.localOutput);
      if (!existsSync(parent)) throw new Error("missing parent");
    } catch {
      problems.push(`Local output cannot be created: ${opts.localOutput}`);
    }
  }

  for (const [label, requested] of [
    ["ffmpeg", opts.ffmpegBin],
    ["ffprobe", opts.ffprobeBin],
  ] as const) {
    const resolved = resolveBinary(requested);
    if (!resolved || !existsSync(resolved)) {
      problems.push(`${label} not found: "${requested}" (not on PATH). Set paths.${label} in the manifest or fix PATH.`);
    } else {
      info[label] = resolved;
    }
  }

  if (!opts.skipCopy && !opts.dryRun) {
    if (!existsSync(opts.destinationRoot)) {
      problems.push(
        `Destination root is not accessible: ${opts.destinationRoot}. Mount the share (e.g. /mnt/z under WSL), run from Windows, or use --skip-copy.`,
      );
    } else {
      info.destination_root = opts.destinationRoot;
    }
  }

  return { ok: problems.length === 0, problems, info };
}
