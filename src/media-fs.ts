import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { detectRuntime, posixToWindows } from "./paths.js";
import { psQuote } from "./copy.js";

export interface MediaFileEntry {
  name: string;
  fullPath: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface MediaFs {
  exists(p: string): Promise<boolean>;
  listFiles(dir: string, ext?: string): Promise<MediaFileEntry[]>;
  stat(p: string): Promise<{ sizeBytes: number; mtimeMs: number }>;
  mkdirp(dir: string): Promise<void>;
  copy(src: string, dest: string): Promise<void>;
  rename(src: string, dest: string, opts?: { force?: boolean }): Promise<void>;
}

export class MediaFsError extends Error {}

const DRIVE_PATH_RE = /^[A-Za-z]:[\\/]/;

export function isWindowsDrivePath(p: string): boolean {
  return DRIVE_PATH_RE.test(p);
}

export function shouldUsePowerShellMediaFs(p: string, runtime = detectRuntime()): boolean {
  return runtime === "wsl" && isWindowsDrivePath(p) && !existsSync(p);
}

export function windowsPath(p: string): string {
  return posixToWindows(p).replace(/\//g, "\\");
}

export function buildPsListFilesCommand(dirWin: string, ext?: string): string {
  const filter = ext ? ` -Filter ${psQuote(`*${ext.startsWith(".") ? ext : `.${ext}`}`)}` : "";
  return [
    `$p = ${psQuote(dirWin)}`,
    `if (!(Test-Path -LiteralPath $p)) { throw "Path not found: $p" }`,
    `Get-ChildItem -LiteralPath $p -File${filter} | Sort-Object Name | Select-Object Name,FullName,Length,@{Name='MtimeMs';Expression={[DateTimeOffset]$_.LastWriteTimeUtc | ForEach-Object { $_.ToUnixTimeMilliseconds() }}} | ConvertTo-Json -Depth 3`,
  ].join("; ");
}

export function buildPsStatCommand(pathWin: string): string {
  return [
    `$p = ${psQuote(pathWin)}`,
    `if (!(Test-Path -LiteralPath $p)) { throw "Path not found: $p" }`,
    `$i = Get-Item -LiteralPath $p`,
    `$i | Select-Object FullName,Length,@{Name='MtimeMs';Expression={[DateTimeOffset]$_.LastWriteTimeUtc | ForEach-Object { $_.ToUnixTimeMilliseconds() }}} | ConvertTo-Json -Depth 3`,
  ].join("; ");
}

export function buildPsCopyFileCommand(srcWin: string, destWin: string): string {
  return [
    `$src = ${psQuote(srcWin)}`,
    `$dest = ${psQuote(destWin)}`,
    `New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null`,
    `Copy-Item -LiteralPath $src -Destination $dest -Force`,
  ].join("; ");
}

export function buildPsRenameCommand(srcWin: string, destWin: string, force = false): string {
  return [
    `$src = ${psQuote(srcWin)}`,
    `$dest = ${psQuote(destWin)}`,
    `New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null`,
    `Move-Item -LiteralPath $src -Destination $dest${force ? " -Force" : ""}`,
  ].join("; ");
}

async function runPowerShell(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new MediaFsError(`powershell failed: ${stderr.trim() || err.message}`));
        else resolve(stdout);
      },
    );
  });
}

class NativeMediaFs implements MediaFs {
  async exists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  async listFiles(dir: string, ext?: string): Promise<MediaFileEntry[]> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      throw new MediaFsError(`Cannot read media folder ${dir}: ${(err as Error).message}`);
    }
    const files = entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((name) => !ext || name.toLowerCase().endsWith(ext.toLowerCase()))
      .sort();
    const out: MediaFileEntry[] = [];
    for (const name of files) {
      const fullPath = path.join(dir, name);
      const st = await fs.stat(fullPath);
      out.push({ name, fullPath, sizeBytes: st.size, mtimeMs: st.mtimeMs });
    }
    return out;
  }

  async stat(p: string): Promise<{ sizeBytes: number; mtimeMs: number }> {
    try {
      const st = await fs.stat(p);
      return { sizeBytes: st.size, mtimeMs: st.mtimeMs };
    } catch (err) {
      throw new MediaFsError(`Cannot stat ${p}: ${(err as Error).message}`);
    }
  }

  async mkdirp(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
  }

  async copy(src: string, dest: string): Promise<void> {
    await this.mkdirp(path.dirname(dest));
    await fs.copyFile(src, dest);
  }

  async rename(src: string, dest: string, opts?: { force?: boolean }): Promise<void> {
    await this.mkdirp(path.dirname(dest));
    if (opts?.force && (await this.exists(dest))) await fs.unlink(dest);
    await fs.rename(src, dest);
  }
}

class PowerShellMediaFs implements MediaFs {
  async exists(p: string): Promise<boolean> {
    const out = await runPowerShell(`if (Test-Path -LiteralPath ${psQuote(windowsPath(p))}) { Write-Output 1 }`);
    return out.trim() === "1";
  }

  async listFiles(dir: string, ext?: string): Promise<MediaFileEntry[]> {
    const raw = (await runPowerShell(buildPsListFilesCommand(windowsPath(dir), ext))).trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((r) => {
      const row = r as { Name: string; FullName: string; Length: number; MtimeMs: number };
      return { name: row.Name, fullPath: row.FullName, sizeBytes: Number(row.Length), mtimeMs: Number(row.MtimeMs) };
    });
  }

  async stat(p: string): Promise<{ sizeBytes: number; mtimeMs: number }> {
    const raw = (await runPowerShell(buildPsStatCommand(windowsPath(p)))).trim();
    const row = JSON.parse(raw) as { Length: number; MtimeMs: number };
    return { sizeBytes: Number(row.Length), mtimeMs: Number(row.MtimeMs) };
  }

  async mkdirp(dir: string): Promise<void> {
    await runPowerShell(`New-Item -ItemType Directory -Force -Path ${psQuote(windowsPath(dir))} | Out-Null`);
  }

  async copy(src: string, dest: string): Promise<void> {
    await runPowerShell(buildPsCopyFileCommand(windowsPath(src), windowsPath(dest)));
  }

  async rename(src: string, dest: string, opts?: { force?: boolean }): Promise<void> {
    await runPowerShell(buildPsRenameCommand(windowsPath(src), windowsPath(dest), !!opts?.force));
  }
}

export function mediaFsForPath(p: string, runtime = detectRuntime()): MediaFs {
  return shouldUsePowerShellMediaFs(p, runtime) ? new PowerShellMediaFs() : new NativeMediaFs();
}

export async function copyVerified(fsLike: MediaFs, src: string, dest: string): Promise<void> {
  await fsLike.copy(src, dest);
  const [s, d] = await Promise.all([fsLike.stat(src), fsLike.stat(dest)]);
  if (s.sizeBytes !== d.sizeBytes) {
    throw new MediaFsError(`Size mismatch after copy: ${src} (${s.sizeBytes}) -> ${dest} (${d.sizeBytes})`);
  }
}
