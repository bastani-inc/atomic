---
title: "Web access"
sidebarTitle: "Web access"
description: "Search the web, fetch webpages, PDFs, GitHub repos, and videos, query public repos with DeepWiki, and configure ~/.atomic/web-search.json."
---

Atomic bundles four web-access tools: `web_search` for searching the web, `fetch_content` for reading pages and media, `get_search_content` for retrieving full stored results, and `code_search` for querying public GitHub repositories. Both `web_search` and `code_search` work out of the box with no API key setup.

## Quick start

- **Zero-config defaults.** Ask Atomic to search the web (`web_search` uses keyless Exa by default), read a URL or PDF (`fetch_content`), or query a public GitHub repository (`code_search` via DeepWiki).
- **Optional API keys.** Set `EXA_API_KEY`, `PERPLEXITY_API_KEY`, or `GEMINI_API_KEY`, or store camelCase keys in `~/.atomic/web-search.json` to raise limits or pick a specific provider.
- **Interactive commands.** Run `/websearch <query>` to search directly, `/curator on` to review results in your browser before the agent sees them, or `/search` to inspect stored session results.

## Searching with `web_search`

Pass `query` for a single search, or `queries` (an array of 2 to 4 varied angles) for broader research. If both `query` and `queries` are supplied, `queries` wins and `query` is ignored. Multiple queries run sequentially (with a 60-second timeout per query on Exa and Gemini API).

Optional parameters are `numResults` (default `5`, max `20`), `includeContent` (boolean; fetches full page text in the background), `recencyFilter` (`"day"`, `"week"`, `"month"`, or `"year"`), `domainFilter` (array of domains; prefix with `-` to exclude; on Perplexity, entries that are not valid domains are ignored), and `provider` (`"auto"`, `"exa"`, `"perplexity"`, or `"gemini"`).

With `provider: "auto"` (the default), Atomic tries providers in this order:

1. **Exa.** Uses your Exa API key when configured, or falls back to Exa's free keyless MCP endpoint (`mcp.exa.ai`). Atomic tracks monthly Exa usage locally in `~/.atomic/exa-usage.json`, warning at 800 requests and stopping at 1,000 requests per month. When `provider: "exa"` is explicitly selected with an API key, errors fail directly; keyless Exa falls back to Perplexity or Gemini on failure.
2. **Perplexity.** Used when a key is set. Client-side rate limiting caps requests at 10 per 60 seconds.
3. **Gemini API.** Used when a key is set (`GEMINI_API_KEY` or `geminiApiKey` in `web-search.json`).
4. **Gemini Web.** Reads cookies from a signed-in browser. Disabled by default; enable it with `"allowBrowserCookies": true` in `~/.atomic/web-search.json` or `ATOMIC_ALLOW_BROWSER_COOKIES=1` (the environment variable must be the exact string `1`; `true` does not enable it).
   - **Supported platforms and browsers:** On **macOS**, Atomic checks Helium, Chrome, and Arc (in that order). On **Linux**, Atomic checks Chromium and Chrome (in that order). **Windows is not supported.** Edge, Brave, Vivaldi, and Opera are not checked on any OS. The default profile directory is `"Default"` (override with `chromeProfile`).

Environment variables override fields in `~/.atomic/web-search.json`. Note that JSON config keys use camelCase (`geminiApiKey`, not `GEMINI_API_KEY`):

| Provider | Environment variable | `web-search.json` field |
| --- | --- | --- |
| Exa | `EXA_API_KEY` | `exaApiKey` |
| Perplexity | `PERPLEXITY_API_KEY` | `perplexityApiKey` |
| Gemini API | `GEMINI_API_KEY` | `geminiApiKey` |

```json
{
  "exaApiKey": "your-key",
  "geminiApiKey": "your-gemini-key",
  "provider": "auto"
}
```

When no provider can be reached, the error names the relevant environment variables, JSON config fields, and cookie opt-in setting.

### The search curator

By default, `web_search` returns raw results. Run `/curator on` or `/curator summary-review` (or set `"workflow": "summary-review"` in `~/.atomic/web-search.json`) to open an interactive browser window where you filter results and approve a summary draft before the agent sees them. Run `/curator off` or `/curator none` to return to raw results, or run `/curator` with no argument to toggle between modes. Switching providers inside the curator saves `provider` and updates active search configuration immediately.

The curator requires an interactive session with a browser. Subagents and non-interactive runs skip it and return raw results. If the browser cannot open (for example on a headless server), `web_search` falls back to raw results with a note pointing to `/curator off`.

## Fetching with `fetch_content`

`fetch_content` reads webpages (as markdown), PDFs, GitHub repositories, YouTube videos, and local video files.

### Arguments

Always pass the lowercase `urls` field as a nonempty array of strings, even for one URL (do not pass a singular `url` field, which belongs to `get_search_content`):

```json
{"urls": ["https://example.com/article"]}
```

For multiple pages (fetched up to 3 at a time):

```json
{"urls": ["https://example.com/one", "https://example.com/two"]}
```

For video analysis, include your question in `prompt`:

```json
{"urls": ["/path/to/recording.mp4"], "prompt": "What error appears on screen?"}
```

- **Local videos.** Accepts absolute paths (including Windows drive and UNC paths), `./` or `../` relative paths, and `file://` URLs for `.mp4`, `.mov`, `.webm`, `.avi`, `.mpeg`, `.mpg`, `.wmv`, `.flv`, `.3gp`, and `.3gpp` files (escape Windows backslashes in JSON, such as `{"urls": ["C:\\Videos\\recording.mp4"], "frames": 1}`). Analysis requires Gemini API or Gemini Web (with browser cookies enabled); `video.maxSizeMB` (`50` by default) is measured in binary MiB.
- **YouTube videos.** Tries Gemini Web first, then Gemini API, then Perplexity. `/playlist` URLs are not treated as videos. Setting `"youtube": { "enabled": false }` in `~/.atomic/web-search.json` disables both YouTube analysis and YouTube frame extraction.
- **`prompt` and `model`.** Apply only to YouTube and local video analysis, not webpage extraction.
- **Frame extraction (`frames` and `timestamp`).** Extract images from YouTube or local videos only (ignored for webpages and other inputs, including in mixed batches). Omit both for text or transcripts. `frames` accepts `1` to `12`; `timestamp` accepts bare seconds (`"85"`), `MM:SS` (`"1:25"`), `H:MM:SS`, or a `start-end` range (`"1:25-2:00"`):
  - `frames` alone samples evenly across the whole video (requires `ffprobe` for local videos).
  - Single `timestamp` alone extracts 1 frame at that time.
  - Single `timestamp` plus `frames` extracts `N` frames at 5-second intervals starting at `timestamp`.
  - Range `timestamp` alone extracts 6 frames across the range.
  - Range `timestamp` plus `frames` extracts up to `N` frames with a 5-second minimum spacing (short ranges may return fewer frames).
  - Requires `ffmpeg` (and `ffprobe` for whole-video sampling of local files), plus `yt-dlp` for YouTube.

```json
{"urls": ["/path/to/recording.mp4"], "timestamp": "1:25-2:00", "frames": 3}
```

- **GitHub repositories (`forceClone`).** Clones public repositories shallowly unless the repository exceeds `githubClone.maxRepoSizeMB` or targets a full commit SHA URL, in which case Atomic uses the GitHub API unless `forceClone: true` is passed. Skips binary files and common build or dependency directories (`node_modules`, `vendor`, `dist`, `build`, and similar), caps inline files at 100,000 characters, and caps directory listings at 200 entries. The default clone cache clears automatically when you switch sessions.

### Extraction fallbacks, PDFs, and limits

- **Inline output and batches.** Single-URL fetches return up to 30,000 characters inline and store the full text for `get_search_content`. Multi-URL batches return titles and character counts inline only; read the full text for each URL with `get_search_content`.
- **HTTP limits.** Direct fetches run up to 3 concurrently with a 30-second timeout, up to 20 redirects, a 5 MiB limit for HTML and text, and a 20 MiB limit for PDFs. Binary MIME types (`application/octet-stream`, `image/*`, `audio/*`, `video/*`, and `application/zip`) are rejected.
- **Public webpage fallbacks.** When a direct fetch of a public URL fails or extracts fewer than 500 characters (excluding private-network URLs and URLs with embedded credentials), `fetch_content` forwards the URL to **Jina Reader (`https://r.jina.ai/`)** first, then **Gemini URL Context API**, then **Gemini Web**.
- **PDF downloads.** Fetching a PDF URL downloads up to 20 MiB, extracts up to 100 pages, **writes the extracted Markdown file into `~/Downloads`**, and returns the saved file path, page count, and character count.

### Troubleshooting

If argument validation fails, check that:

- The field is `urls` (lowercase), not `URLs` or `url`.
- Its value is a nonempty array of strings.
- No unrecognized fields are present.

If every URL in a batch fails, the error lists each URL and its cause; partial excerpts may still appear as incomplete content. Retry transient failures individually with `fetch_content({ urls: ["<failed URL>"] })`, or try an alternate URL or `web_search`. `get_search_content` cannot recover content from a failed fetch.

## Retrieving full results with `get_search_content`

When `web_search` or `fetch_content` truncates output or stores background fetches, it returns a `responseId`. Pass that ID plus **at least one selector** (`query` or `queryIndex` for a `web_search` response; `url` or `urlIndex` for a `fetch_content` response). Omitting selectors returns an error listing the available queries or URLs.

`query` and `url` take precedence over `queryIndex` and `urlIndex` and require exact, case-sensitive matches.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `responseId` | string | Yes | ID returned by a previous `web_search` or `fetch_content` call. |
| `query` | string | One of `query` / `queryIndex` (for search) | Exact case-sensitive search query to retrieve from a stored `web_search` response. |
| `queryIndex` | number | One of `query` / `queryIndex` (for search) | Zero-based query index in a stored `web_search` response. |
| `url` | string | One of `url` / `urlIndex` (for fetch) | Exact case-sensitive URL to retrieve from a stored `fetch_content` response. |
| `urlIndex` | number | One of `url` / `urlIndex` (for fetch) | Zero-based URL index in a stored `fetch_content` response. |

## `code_search`

`code_search` asks DeepWiki (`https://mcp.deepwiki.com/mcp`) about code, architecture, and APIs in a public GitHub repository. It requires no API key or MCP setup and does not fall back to web search.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `repoName` | string | Yes | Public GitHub repository in `owner/repo` format (not a URL). |
| `query` | string | Yes | Question sent verbatim to DeepWiki. |
| `maxTokens` | integer | No | Best-effort output limit (`1000` to `50000`, default `5000`, about 4 characters per token). |

Requests have a 60-second deadline. See [`code_search` in Built-in tools](/tools#code_search) for examples and fallback guidance.

## Slash commands and shortcuts

| Command | Action |
| --- | --- |
| `/curator [on\|off\|none\|summary-review]` | Set the search curator workflow and save it to `~/.atomic/web-search.json`. Omitting the argument toggles between `none` and `summary-review`. |
| `/websearch [query1, query2, ...]` | Open the interactive search curator directly without an agent round-trip. Arguments split on commas into separate queries. Closing or cancelling sends nothing; timing out submits collected results as a summary-review follow-up. |
| `/search` | Browse, inspect, or delete stored `web_search` and `fetch_content` results from the current session. |
| `/google-account` | Print the active Google account used for Gemini Web when browser cookie access is enabled, without starting a model turn. |

| Shortcut | Config key | Action |
| --- | --- | --- |
| `Ctrl+Shift+S` | `shortcuts.curate` | Open the search curator while a search is running. |
| `Ctrl+Shift+W` | `shortcuts.activity` | Toggle the web search activity widget. |

Customize shortcuts in `~/.atomic/web-search.json` under `"shortcuts"`. Shortcut changes take effect after restarting Atomic.

## Configure `web-search.json`

All fields in `~/.atomic/web-search.json` are optional. If `~/.atomic/web-search.json` does not exist, Atomic falls back to `~/.pi/web-search.json` from older installations without merging the two files; interactive saves always write `~/.atomic/web-search.json`.

**Reloading changes.** `workflow` and `curatorTimeoutSeconds` are re-read on every call, and switching providers inside the curator updates active search settings immediately. Manual file edits to API keys, `provider`, `searchModel`, `allowBrowserCookies`, `chromeProfile`, `githubClone`, `youtube`, and `video` take effect after `/reload` or restarting Atomic. Shortcut changes require restarting Atomic.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `provider` | `"auto" \| "exa" \| "perplexity" \| "gemini"` | `"auto"` | Default `web_search` provider. Switching providers in the curator updates this field immediately. |
| `workflow` | `"none" \| "summary-review"` | `"none"` | `"none"` returns raw results; `"summary-review"` opens the browser curator with a summary draft. |
| `curatorTimeoutSeconds` | number (`1` to `600`) | `20` | Curator wait timeout in seconds (floored to an integer; values below `1` fall back to `20`, and values above `600` clamp to `600`). |
| `summaryModel` | string | auto | Default `"provider/model"` for curator summary drafts (prefers `anthropic/claude-haiku-4-5` or `openai-codex/gpt-6.1-sol` when available). |
| `searchModel` | string | `"gemini-3-flash-preview"` | Gemini API model used for Gemini search queries. |
| `shortcuts` | `{ curate?: string, activity?: string }` | `{ "curate": "ctrl+shift+s", "activity": "ctrl+shift+w" }` | Keyboard shortcuts for opening the curator and toggling the activity widget. |
| `exaApiKey` | string | unset | Exa API key (overridden by `EXA_API_KEY`). |
| `perplexityApiKey` | string | unset | Perplexity API key (overridden by `PERPLEXITY_API_KEY`). |
| `geminiApiKey` | string | unset | Gemini API key (overridden by `GEMINI_API_KEY`). |
| `allowBrowserCookies` | boolean | `false` | Allow Gemini Web to read cookies from supported browsers on macOS and Linux (overridden by `ATOMIC_ALLOW_BROWSER_COOKIES=1`). Not supported on Windows. |
| `chromeProfile` | string | `"Default"` | Browser profile directory name used for Gemini Web cookie lookup. |
| `githubClone` | object | see below | GitHub clone settings: `enabled` (`true`), `maxRepoSizeMB` (`350`), `cloneTimeoutSeconds` (`30`), and `clonePath` (defaults to an account-private `github-repos` temp folder cleared on session switches). |
| `youtube` | object | see below | YouTube settings: `enabled` (`true`; setting `false` disables both analysis and frame extraction) and `preferredModel` (`"gemini-3-flash-preview"`). |
| `video` | object | see below | Local video settings: `enabled` (`true`), `preferredModel` (`"gemini-3-flash-preview"`), and `maxSizeMB` (`50`, measured in binary MiB). |

Example configuration:

```json
{
  "provider": "auto",
  "workflow": "none",
  "curatorTimeoutSeconds": 30,
  "summaryModel": "anthropic/claude-haiku-4-5",
  "searchModel": "gemini-3-flash-preview",
  "shortcuts": {
    "curate": "ctrl+shift+s",
    "activity": "ctrl+shift+w"
  },
  "allowBrowserCookies": false,
  "githubClone": {
    "enabled": true,
    "maxRepoSizeMB": 350,
    "cloneTimeoutSeconds": 30
  },
  "youtube": {
    "enabled": true,
    "preferredModel": "gemini-3-flash-preview"
  },
  "video": {
    "enabled": true,
    "preferredModel": "gemini-3-flash-preview",
    "maxSizeMB": 50
  }
}
```

## Enabling and disabling

Web access is enabled by default in both the CLI and the SDK.

- **CLI.** Remove web-access tools for one run with `--exclude-tools`:

```bash
atomic --exclude-tools web_search,fetch_content,get_search_content,code_search
```

- **SDK.** Disable the bundled `web-access` package completely in `createAgentSession()`:

```typescript
import { createAgentSession } from "@bastani/atomic";

const { session } = await createAgentSession({
  builtins: { "web-access": false },
});
```

See [CLI tool options](/reference/cli#tool-options) and [SDK tools](/sdk/reference#tools).

## Helper binary lookup

Helper binaries (`gh`, `git`, `ffmpeg`, `ffprobe`, `yt-dlp`, `npm`, browser openers, and OS keychain helpers) are resolved only from absolute directories in `PATH`. The current project directory is searched only when `PATH` explicitly lists it.

## Related docs

- [Built-in tools](/tools) covers `read` URL fetching, `code_search`, and tool selection.
- [SDK tools](/sdk/reference#tools) covers `builtins`, `tools`, and `excludedTools`.
- [CLI reference](/reference/cli) covers `--tools`, `--exclude-tools`, and `--no-tools`.
- [Environment variables](/environment-variables) lists `EXA_API_KEY`, `PERPLEXITY_API_KEY`, `GEMINI_API_KEY`, and `ATOMIC_ALLOW_BROWSER_COOKIES`.
