# Torii 鳥居

Anime from [nyaa.si](https://nyaa.si) straight into your Plex library, from any device on your LAN.

Browse the season's charts, tap an episode, and it lands in Plex renamed and organized - or pin a show to your watchlist and new episodes download themselves as fansub groups release them.

![Torii home screen](docs/screenshot.png)

## What it does

- Search and browse anime via AniList: posters, airing schedules, synopses, and MAL-style charts (this season, trending, top rated, all-time popular, upcoming, movies, any past season).
- Browse a show episode by episode - every episode with its title and air date (via AniZip), releases fetched on demand per episode with seeder-sorted targeted searches, so even a 15-year-old One Piece episode is one tap away.
- Release rows show subs group, quality, size, seeders, and trusted flags; mixed numbering schemes (seasonal, cour continuation, absolute) resolve to the same episode.
- One tap downloads into your library folder, renamed Plex-style (`Show/Season 01/Show - S01E01 [Group][1080p].mkv`), then triggers a partial Plex scan.
- Completed media files can also be downloaded through the browser to the phone or computer currently accessing Torii; interrupted transfers support resuming.
- Watchlist: pin a subs group + quality per show; new episodes auto-download as they appear on nyaa (polls every 30 min, every 10 min around the AniList air time). Adding starts with future releases; use Catch up to queue every currently available matching episode.
- Files are hardlinked into the library so the torrent seeds back with zero extra disk use (ratio/time limits configurable, including "Don't seed").
- Keeps Plex alive (restarts it if it stops), can create the Plex "Anime" library itself, and starts at login.
- Mobile-first PWA: open it on your phone and Add to Home Screen.

## Setup

One command, even on a machine with nothing installed:

```sh
curl -fsSL https://raw.githubusercontent.com/shadohead/torii/main/install.sh | bash
```

That fetches the source to `~/.torii/app`, provisions a private Node.js runtime under `~/.torii/node` if your system has none (no Homebrew, no sudo), installs dependencies, registers the background service (starts at login), builds a double-clickable `Torii.app`, and opens the UI.
It also prints the URL to open on your phone.
On macOS, Torii advertises itself over Bonjour at **http://torii.local**, so the
same memorable address works on the Mac, iPhone, and other devices on the local
network. The numbered LAN URL remains available as a fallback.

From a git checkout instead: `npm run setup` does the same for the checkout (or `bash scripts/setup.sh` if you don't have Node yet).
Prefer minimal? `npm install && npm start` runs it in the foreground with no system integration.
macOS is the primary target; Linux runs fine minus the launchd/app conveniences.
A Plex Media Server on the same machine completes the picture, but Torii runs without one.

Then open **Setup** in the UI and:

1. Point the library folder somewhere your Plex server watches (Torii can also create an "Anime" library in Plex for you).
2. Check the Plex row: on macOS the token is auto-discovered; elsewhere paste your Plex URL and token.

## Uninstall

```sh
curl -fsSL https://raw.githubusercontent.com/shadohead/torii/main/uninstall.sh | bash
```

Or `npm run uninstall` from a checkout.
This stops and removes the background service, deletes `Torii.app`, clears partial downloads (`.incoming`), and removes the program files including the private Node runtime.
Your media library is never touched - everything already organized into Plex stays.
Settings and watchlist survive for a future reinstall; add `--purge` (`... | bash -s -- --purge`) to remove those too.

## Configuration

Everything lives in the Setup tab: library folder (with Plex-coverage detection), Plex URL and token, default quality, download/upload speed limits, peer connections, seed ratio/time, watchlist poll interval, preferred subs groups, start-at-login, keep-Plex-running, and global auto-download.

Environment variables for non-default layouts, read at startup and baked into the service definition when set during `npm run setup`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TORII_PORT` | `3939` | HTTP port |
| `TORII_DATA_DIR` | `~/.torii` | Database, log, poster cache |
| `TORII_LIBRARY_DIR` | `~/Movies/Anime` | Initial library folder (before first run) |

Service management: `npm run service install | uninstall | status`.
Logs live at `~/.torii/torii.log`.

## Remote access

The web UI has no authentication - it trusts your LAN.
Never port-forward it.
If you want it away from home, put your devices on a [Tailscale](https://tailscale.com) tailnet and open the Mac's tailnet address; that keeps it private without exposing anything.
Remote streaming is Plex's job, not Torii's - enable Plex Remote Access and use the Plex apps.

## Design notes

- Node 22-era ESM, zero-framework HTTP server, two dependencies: `webtorrent` (pinned to v2 - v3 has a piece-accounting regression) and `better-sqlite3`.
- Data sources: AniList (search, charts, schedules), AniZip (episode titles and numbering maps), nyaa.si RSS (releases); all responses cached in sqlite.
- `scripts/patch-webtorrent.mjs` (postinstall) null-guards a piece/bitfield race in webtorrent.
- Idle footprint ~0% CPU / ~75 MB RSS; the torrent client is created lazily and destroyed when no torrents are active. DHT off (nyaa is tracker-based), upload capped at 512 KB/s by default.
- On macOS the service runs under launchd with `Nice 10` + `LowPriorityBackgroundIO`, so downloads never fight your foreground work.

## Known limits

- Long-running shows with absolute numbering (One Piece, Re:Zero on SubsPlease) get filed as `S0xE<absolute>`; Plex metadata matching for those episodes can be off even though playback is fine.
- Torrent and usenet indexers other than nyaa.si are out of scope; this is an anime-first tool.

## License

MIT
