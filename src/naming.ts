const INVALID_CHARS = /[:*?"<>|/\\]/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const RESERVED_NAMES = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

const MAX_TITLE_LEN = 120;

/**
 * Sanitize an untrusted title string (TMDb metadata or TOML override) for
 * safe use in a Windows filename.
 */
export function sanitizeTitle(input: string): string {
  let s = input.replace(CONTROL_CHARS, " ").replace(INVALID_CHARS, " ");
  s = s.replace(/\s+/g, " ").trim().replace(/\.+$/, "").trim();
  if (s.length > MAX_TITLE_LEN) {
    s = s.slice(0, MAX_TITLE_LEN).trimEnd().replace(/\.+$/, "");
  }
  const bare = (s.split(".")[0] ?? "").toLowerCase();
  if (RESERVED_NAMES.has(bare)) {
    s = `_${s}`;
  }
  return s || "Untitled";
}

export function formatEpisode(season: number, episode: number): string {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

export function seasonFolderName(season: number): string {
  return `Season ${String(season).padStart(2, "0")}`;
}

/** Full destination-relative folder: `{Show}/Season XX`. */
export function showSeasonDir(showName: string, season: number): string {
  return `${sanitizeTitle(showName)}/${seasonFolderName(season)}`;
}

/** Destination filename: `{Show} - S01E01 - Title.mp4`. */
export function outputFileName(showName: string, season: number, episode: number, title: string): string {
  return `${sanitizeTitle(showName)} - ${formatEpisode(season, episode)} - ${sanitizeTitle(title)}.mp4`;
}
