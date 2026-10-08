import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";

export const episodeMapSchema = z.record(z.string(), z.number().int());

const stringMapSchema = z.record(z.string(), z.string());

export const configSchema = z.object({
  show: z.object({
    tmdb_id: z.number().int().min(0),
    name: z.string().min(1),
    season: z.number().int().positive(),
  }),
  paths: z.object({
    source_root: z.string().min(1),
    local_output: z.string().min(1),
    destination_root: z.string().min(1),
    ffmpeg: z.string().min(1).default("ffmpeg.exe"),
    ffprobe: z.string().min(1).default("ffprobe.exe"),
  }),
  disc: z.record(z.string(), episodeMapSchema).default({}),
  ignore: z.record(z.string(), stringMapSchema).default({}),
  title_override: z.record(z.string(), stringMapSchema).default({}),
});

export type AppConfig = z.infer<typeof configSchema>;

export interface DiscItem {
  disc: string;
  file: string;
  episode: number; // 0 means unmapped TODO
}

export interface ManifestView {
  items: DiscItem[];
  ignored: Map<string, Set<string>>; // disc -> files with ignore reasons
  overrides: Map<string, Map<string, string>>; // disc -> file -> title
  ignoredReasons: Map<string, string>; // `${disc}/${file}` -> reason
}

export class ConfigError extends Error {}

/** Read + parse + validate the TOML manifest. */
export function loadConfig(configPath: string): { config: AppConfig; configDir: string } {
  const resolved = path.resolve(configPath);
  let raw: string;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch (err) {
    throw new ConfigError(`Cannot read config file: ${resolved} (${(err as Error).message})`);
  }

  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (err) {
    throw new ConfigError(`Invalid TOML in ${resolved}: ${(err as Error).message}`);
  }

  const result = configSchema.safeParse(doc);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  - ${[...i.path].map(String).join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid config shape in ${resolved}:\n${problems}`);
  }

  return { config: result.data, configDir: path.dirname(resolved) };
}

/** Convert raw disc mappings into a normalized item list. */
export function buildManifestView(config: AppConfig): ManifestView {
  const items: DiscItem[] = [];
  const ignored = new Map<string, Set<string>>();
  const overrides = new Map<string, Map<string, string>>();
  const ignoredReasons = new Map<string, string>();

  for (const [disc, fileMap] of Object.entries(config.disc)) {
    for (const [file, episode] of Object.entries(fileMap)) {
      items.push({ disc, file, episode });
    }
  }
  items.sort((a, b) => a.disc.localeCompare(b.disc) || a.file.localeCompare(b.file));

  for (const [disc, fileMap] of Object.entries(config.ignore)) {
    ignored.set(disc, new Set(Object.keys(fileMap)));
    for (const [file, reason] of Object.entries(fileMap)) {
      ignoredReasons.set(`${disc}/${file}`, reason);
    }
  }

  for (const [disc, fileMap] of Object.entries(config.title_override)) {
    overrides.set(disc, new Map(Object.entries(fileMap)));
  }

  return { items, ignored, overrides, ignoredReasons };
}

/** Pure validation over the manifest: bad filenames, TODO episodes, duplicates. */
export function validateManifest(view: ManifestView): string[] {
  const errors: string[] = [];

  for (const item of view.items) {
    if (path.isAbsolute(item.file)) {
      errors.push(`[${item.disc}] "${item.file}": mapped filenames must be relative to the disc folder`);
      continue;
    }
    if (item.file.split(/[\\/]/).includes("..")) {
      errors.push(`[${item.disc}] "${item.file}": mapped filenames must not contain ".."`);
      continue;
    }
    if (item.episode === 0) {
      errors.push(`[${item.disc}] "${item.file}": episode is still 0 (TODO). Assign an episode number or move it to [ignore.${item.disc}]`);
    } else if (item.episode < 0) {
      errors.push(`[${item.disc}] "${item.file}": episode must be >= 0`);
    }
  }

  const seen = new Map<number, string>();
  for (const item of view.items) {
    if (item.episode <= 0) continue;
    const prev = seen.get(item.episode);
    if (prev) {
      errors.push(`Episode ${item.episode} is mapped twice: ${prev} and [${item.disc}] "${item.file}"`);
    } else {
      seen.set(item.episode, `[${item.disc}] "${item.file}"`);
    }
  }

  return errors;
}
