# video-steward

Steward for DVD-rip archives. Scans extracted DVD folders, maps ripped titles
to TV episodes via a TOML manifest, enriches metadata from TMDb, remuxes
`.mkv` → `.mp4` with ffmpeg stream copy (no re-encoding), stages results
locally, then copies finished files to a media share.

## Workflow

```text
rip DVD -> .mkv folder   (MakeMKV or your ripper of choice)
video-steward append-disc <folder>     # starter [disc.NAME] section, episodes = 0 TODO
edit archive-dvd.toml                  # assign episode numbers, move extras to [ignore.*]
npm run dry-run                        # review evidence table: size, duration, streams, titles
npm run archive                        # convert + copy (safe to rerun)
```

## Setup

```bash
npm install
# put your TMDb key in .env (next to this file):
#   TMDB_API_KEY=...
npm run archive -- search "Aaahh Real Monsters"   # find the show ID
# set show.tmdb_id in archive-dvd.toml
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run archive` | Validate, convert mapped files, copy to destination |
| `npm run dry-run` | Print the evidence table + planned paths, change nothing |
| `npm run archive -- scan <folder>` | Print starter TOML for a newly extracted disc folder |
| `npm run archive -- append-disc <folder>` | Append starter `[disc.NAME]` section to the manifest |
| `npm run archive -- search <query>` | Search TMDb shows and print candidate IDs |

Flags: `--config <path>`, `--only <disc>`, `--force`, `--skip-copy`, `--fail-fast`.

## Manifest (`archive-dvd.toml`)

```toml
[show]
tmdb_id = 12345          # from `search`
name = "Aaahh Real Monsters"   # folder/filename prefix (stable, your choice)
season = 1

[paths]
source_root = "C:/Users/rd/Videos"        # contains the disc folders
local_output = "C:/Users/rd/Videos/_converted"
destination_root = "Z:/video/shows"

# auto    = native fs when the destination is reachable (mounted share / Windows),
#           otherwise PowerShell under WSL (uses Windows' saved share credentials)
# native  = always Node fs (share must be mounted at destination_root)
# windows = always PowerShell via WSL interop (Z: drive as mapped in Windows)
[share]
backend = "auto"

[disc.ARM_S1_D1]
"B3_t09.mkv" = 1          # 0 = unmapped TODO (blocks conversion)

[ignore.ARM_S1_D1]
"B7_t11.mkv" = "bonus feature"

[title_override.ARM_S1_D1]
"B3_t09.mkv" = "Manual Title If TMDb Is Wrong"
```

Windows-style paths work from both Windows and WSL; under WSL they are
translated to `/mnt/...` automatically.

## v1 stream policy

- Video: first (only) video stream, copied. Allowlist: mpeg2video, h264, hevc, mpeg4, vc1.
- Audio: every stream with a MP4-compatible codec (aac, ac3, eac3, mp3, opus) is copied.
- Subtitles: text-based tracks (subrip/srt/mov_text/ass) are preserved; DVD
  graphics (PGS) and other non-MP4 subtitle codecs are dropped with a logged warning.
- Anything the policy cannot handle fails the item before conversion — no silent
  lossy or partial output.

## Safety

- Dry-run changes nothing.
- Conversions write to `.tmp.mp4` and rename on success; zero-byte temps are removed.
- Destination copies go to a hidden `.tmp` file first, then rename (same under
  the PowerShell backend). Under WSL with `share.backend = "auto"`/`"windows"`,
  copies run through `powershell.exe`, so the share does not need a Linux mount —
  Windows' own saved credentials are used.
- Existing local/destination files are skipped unless `--force`.
- Unmapped or TODO-mapped `.mkv` files block the run until you map or ignore them.

## Tests

```bash
npm test
npm run typecheck
```
