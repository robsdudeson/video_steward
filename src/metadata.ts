import { config as loadDotenv } from "dotenv";
import path from "node:path";

export class MetadataError extends Error {}

const TMDB_BASE = "https://api.themoviedb.org/3";

export interface EpisodeMeta {
  number: number;
  name: string;
  airDate: string | null;
}

export interface SeasonMeta {
  tmdbId: number;
  season: number;
  episodes: Map<number, EpisodeMeta>;
}

export function loadApiKey(configDir: string): string {
  loadDotenv({ path: path.join(configDir, ".env") });
  const key = process.env.TMDB_API_KEY?.trim();
  if (!key) {
    throw new MetadataError(
      `TMDB_API_KEY is not set. Add it to .env next to the manifest: TMDB_API_KEY=<your key>`,
    );
  }
  return key;
}

async function tmdbGet(apiKey: string, route: string): Promise<unknown> {
  // Routes may already carry query strings (e.g. /search/tv?query=...), so
  // append api_key through URLSearchParams instead of a second "?".
  const url = new URL(`${TMDB_BASE}${route}`);
  url.searchParams.set("api_key", apiKey);
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new MetadataError(`TMDb request failed (network): ${(err as Error).message}`);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new MetadataError(`TMDb API error ${res.status} for ${route}: ${body || res.statusText}`);
  }
  return (await res.json()) as unknown;
}

/** Fetch all episodes for a season. */
export async function fetchSeason(apiKey: string, tmdbId: number, season: number): Promise<SeasonMeta> {
  const doc = (await tmdbGet(apiKey, `/tv/${tmdbId}/season/${season}`)) as {
    episodes?: { episode_number?: number; name?: string; air_date?: string | null }[];
  };
  const episodes = new Map<number, EpisodeMeta>();
  for (const ep of doc.episodes ?? []) {
    if (typeof ep.episode_number !== "number" || !ep.name) continue;
    episodes.set(ep.episode_number, {
      number: ep.episode_number,
      name: ep.name,
      airDate: ep.air_date ?? null,
    });
  }
  return { tmdbId, season, episodes };
}

export interface ResolvedTitle {
  title: string;
  source: "override" | "tmdb";
}

/**
 * Resolve the display title for an episode. A manifest override wins;
 * otherwise TMDb must have the episode. Missing metadata is an error —
 * v1 never invents placeholder titles.
 */
export function resolveEpisodeTitle(opts: {
  seasonMeta: SeasonMeta;
  episode: number;
  override?: string | undefined;
}): ResolvedTitle {
  if (opts.override && opts.override.trim()) {
    return { title: opts.override.trim(), source: "override" };
  }
  const ep = opts.seasonMeta.episodes.get(opts.episode);
  if (!ep) {
    throw new MetadataError(
      `TMDb has no episode ${opts.episode} for show ${opts.seasonMeta.tmdbId} season ${opts.seasonMeta.season}. ` +
        `Add a [title_override] entry or fix the mapping.`,
    );
  }
  return { title: ep.name, source: "tmdb" };
}

export interface ShowSearchHit {
  id: number;
  name: string;
  year: string | null;
  voteAverage: number;
}

/** Search TMDb shows by name — used to resolve show.tmdb_id. */
export async function searchShows(apiKey: string, query: string): Promise<ShowSearchHit[]> {
  const doc = (await tmdbGet(apiKey, `/search/tv?query=${encodeURIComponent(query)}&page=1`)) as {
    results?: { id: number; name: string; first_air_date?: string | null; vote_average?: number }[];
  };
  return (doc.results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    year: r.first_air_date ? r.first_air_date.slice(0, 4) : null,
    voteAverage: r.vote_average ?? 0,
  }));
}
