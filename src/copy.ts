import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { detectRuntime, posixToWindows } from "./paths.js";

export type CopyStatus = "copied" | "skipped-existing" | "skipped-flag";

/** How finished files are written to the destination share. */
export type ShareBackendKind = "native" | "windows";

export interface CopyResult {
  status: CopyStatus;
  finalPath: string;
}

/**
 * Decide how destination files are written.
 * "auto": native when the destination root is reachable from this filesystem
 * (mounted share / native Windows), otherwise PowerShell under WSL.
 */
export function resolveShareBackend(kind: "auto" | "native" | "windows", destRoot: string): ShareBackendKind {
  if (kind === "native") return "native";
  if (kind === "windows") return "windows";
  if (existsSync(destRoot)) return "native";
  return detectRuntime() === "wsl" ? "windows" : "native";
}

/** Single-quote a string for PowerShell, doubling embedded quotes. */
export function psQuote(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

/** PowerShell: mkdir -p, copy to hidden .tmp, rename (same-volume rename is atomic). */
export function buildPsCopyCommand(srcWin: string, destDirWin: string, fileName: string): string {
  const finalWin = path.win32.join(destDirWin, fileName);
  const tmpWin = path.win32.join(destDirWin, `.${fileName}.tmp`);
  return [
    `New-Item -ItemType Directory -Force -Path ${psQuote(destDirWin)} | Out-Null`,
    `Copy-Item -LiteralPath ${psQuote(srcWin)} -Destination ${psQuote(tmpWin)} -Force`,
    `Move-Item -LiteralPath ${psQuote(tmpWin)} -Destination ${psQuote(finalWin)} -Force`,
  ].join("; ");
}

/** PowerShell: print the 1-based index of each path that exists. */
export function buildPsExistsCommand(winPaths: string[]): string {
  if (winPaths.length === 0) return "exit 0";
  return winPaths.map((p, i) => `if (Test-Path -LiteralPath ${psQuote(p)}) { Write-Output ${i + 1} }`).join("; ");
}

function runPowerShell(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`powershell failed: ${stderr.trim() || err.message}`));
        else resolve(stdout);
      },
    );
  });
}

/** Copy a local file to the share via Windows PowerShell (uses Windows' saved share credentials). */
export async function copyFinalWindows(opts: { src: string; destDir: string; fileName: string }): Promise<CopyResult> {
  const toWin = (p: string) => posixToWindows(p).replace(/\//g, "\\");
  const srcWin = toWin(opts.src);
  const destDirWin = toWin(opts.destDir);
  const finalPath = path.join(opts.destDir, opts.fileName);
  try {
    await runPowerShell(buildPsCopyCommand(srcWin, destDirWin, opts.fileName));
  } catch (err) {
    throw new Error(`Copy to ${finalPath} failed: ${(err as Error).message}`);
  }
  return { status: "copied", finalPath };
}

/** Which of the given POSIX paths already exist on the Windows side. */
export async function windowsPathsExist(paths: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  if (paths.length === 0) return found;
  const toWin = (p: string) => posixToWindows(p).replace(/\//g, "\\");
  const out = await runPowerShell(buildPsExistsCommand(paths.map(toWin)));
  for (const line of out.split(/\r?\n/)) {
    const n = Number.parseInt(line.trim(), 10);
    if (Number.isInteger(n) && n >= 1 && n <= paths.length) {
      const p = paths[n - 1];
      if (p) found.add(p);
    }
  }
  return found;
}

/**
 * Copy a finished local MP4 to the destination share:
 * mkdir -p, copy to .tmp.mp4 first, rename to final on success.
 */
export async function copyFinal(opts: {
  src: string;
  destDir: string;
  fileName: string;
  force?: boolean | undefined;
}): Promise<CopyResult> {
  const finalPath = path.join(opts.destDir, opts.fileName);

  if (!opts.force) {
    try {
      await fs.access(finalPath);
      return { status: "skipped-existing", finalPath };
    } catch {
      /* does not exist yet */
    }
  }

  await fs.mkdir(opts.destDir, { recursive: true });
  const tmpPath = path.join(opts.destDir, `.${opts.fileName}.tmp`);
  try {
    await fs.copyFile(opts.src, tmpPath);
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw new Error(`Copy to ${finalPath} failed: ${(err as Error).message}`);
  }
  return { status: "copied", finalPath };
}
