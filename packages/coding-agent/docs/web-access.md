---
title: "Web access"
sidebarTitle: "Web access"
description: "Search the web, fetch webpages, PDFs, GitHub repos, and videos, query public repos with DeepWiki, and configure ~/.atomic/web-search.json."
---

Atomic bundles four web-access tools—`web_search`, `fetch_content`, `get_search_content`, and `code_search`—enabled by default. Both `web_search` and `code_search` work out of the box with no API key setup.

| Tool | What it does | Auth required |
| --- | --- | --- |
| [`web_search`](#search-the-web) | Search the web with Exa, Perplexity, Gemini API, or Gemini Web. | None by default (uses keyless Exa); optional API keys or browser cookies. |
| [`fetch_content`](#fetch-pages-and-media) | Read webpages as Markdown, PDFs, GitHub repos, YouTube videos, and local videos. | None for webpages/PDFs; optional `gh` for private/large repos; Gemini/Perplexity for video analysis. |
| [`get_search_content`](#retrieve-stored-results) | Retrieve full stored content from a prior `fetch_content` or `web_search` call. | None. |
| [`code_search`](#code_search) | Query code and architecture of public GitHub repositories via DeepWiki. | None. |

Interactive commands: run `/websearch <query>` to search in your browser curator directly, `/curator on` to review search results before the agent sees them, or `/search` to inspect stored session results.

## Search the web (`web_search`) {#search-the-web}

Pass `query` for a single search, or `queries` (an array of 2 to 4 varied angles) for broader research. If both are supplied, `queries` wins and `query` is ignored. Multiple queries run sequentially.

Optional parameters: `numResults` (default `5`), `includeContent` (boolean; fetches full page text), `recencyFilter` (`"day"`, `"week"`, `"month"`, or `"year"`), `domainFilter` (array of domains; prefix with `-` to exclude), and `provider` (`"auto"`, `"exa"`, `"perplexity"`, or `"gemini"`).

### Provider order and parameter support

With `provider: "auto"` (the default), Atomic tries providers in order: **Exa → Perplexity → Gemini API → Gemini Web**. Parameter support and limits differ by provider:

| Provider | Per-query timeout | `numResults` | `recencyFilter` / `domainFilter` | `includeContent: true` | Notes |
| --- | --- | --- | --- | --- | --- |
| **Exa (API key)** | 60s | Passed through (not clamped to 20) | Supported | Returns full page text inline synchronously | Local counter in `~/.atomic/exa-usage.json` warns at 800 and stops at 1,000 requests/month. Explicit `provider: "exa"` fails directly on error. |
| **Exa (keyless MCP)** | 60s | Passed through (not clamped to 20) | Supported | Returns full page text inline synchronously | Uses `mcp.exa.ai` with no local monthly cap. Falls back to Perplexity or Gemini on failure. |
| **Perplexity** | None | Clamped to `20` | Supported (invalid domains ignored) | Fetches full pages in the background | Client-side rate limit of 10 requests per 60 seconds. |
| **Gemini API** | 60s | Ignored | Ignored | Fetches full pages in the background | Uses `searchModel` (default `"gemini-3-flash-preview"`). |
| **Gemini Web** | 60s | Ignored | Added to search prompt | Fetches full pages in the background | Always uses `"gemini-3-flash-preview"` (ignores `searchModel`). Disabled by default; macOS/Linux only. |

**Gemini Web browser cookies.** Disabled by default. Enable with `"allowBrowserCookies": true` in `~/.atomic/web-search.json` or `ATOMIC_ALLOW_BROWSER_COOKIES=1` (exact string `1`; `true` does not enable it). On **macOS**, Atomic checks Helium, Chrome, and Arc in order; on **Linux**, Chromium and Chrome. **Windows is not supported**, and Edge, Brave, Vivaldi, and Opera are not checked. Override the `"Default"` profile directory with `chromeProfile`.

Environment variables override fields in `~/.atomic/web-search.json`. JSON keys use camelCase (`geminiApiKey`, not `GEMINI_API_KEY`):

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

When no provider can be reached, the error lists the relevant environment variables, JSON config fields, and cookie opt-in setting.

### The search curator

By default (`workflow: "none"`), `web_search` returns raw results. Run `/curator on` or `/curator summary-review` (or set `"workflow": "summary-review"` in `~/.atomic/web-search.json`) to open an interactive browser window where you filter results and approve a summary draft before the agent sees them. Run `/curator off` or `/curator none` to return to raw results, or `/curator` alone to toggle. Switching providers inside the curator saves `provider` and updates active search settings immediately.

On macOS, if optional `glimpseui` is installed locally or globally, the curator opens in a native Glimpse window instead of the default browser. The curator's query-rewrite button uses the first available of `anthropic/claude-haiku-4-5`, `google/gemini-2.5-flash`, or `openai/gpt-4.1-mini`.

The curator requires an interactive session with a browser. Subagents and non-interactive runs skip it and return raw results; on headless machines where a browser cannot open, `web_search` falls back to raw results with a note pointing to `/curator off`.

## Fetch pages and media (`fetch_content`) {#fetch-pages-and-media}

`fetch_content` reads webpages as Markdown, PDFs, GitHub repositories, YouTube videos, and local video files. Always pass lowercase `urls` as a non-empty array of strings, even for one URL (singular `url` belongs to `get_search_content`):

```json
{"urls": ["https://example.com/article"]}
```

```json
{"urls": ["https://example.com/one", "https://example.com/two"]}
```

```json
{"urls": ["/path/to/recording.mp4"], "prompt": "What error appears on screen?"}
```

### Webpages, PDFs, and fallbacks

- **Inline output vs. batches.** Single-URL fetches return up to **30,000 characters** inline and store full text for `get_search_content`. Multi-URL batches (fetched up to 3 concurrently) return titles and character counts inline only—read full text per URL with `get_search_content`.
- **HTTP limits.** Direct fetches use a 30-second timeout, up to 20 redirects, a **5 MiB** limit for HTML and text, and a **20 MiB** limit for PDFs. Binary MIME types (`application/octet-stream`, `image/*`, `audio/*`, `video/*`, `application/zip`) are rejected. Non-HTML text responses return verbatim without a minimum character threshold.
- **Public webpage fallbacks.** On HTML pages where Readability fails, `fetch_content` tries Next.js RSC extraction first. When a direct fetch of a public URL fails or extracts fewer than 500 characters, `fetch_content` falls back to **Jina Reader (`https://r.jina.ai/`)**, then **Gemini URL Context API**, then **Gemini Web**. `Unsupported content type` and `Response too large` errors never trigger fallbacks.
- **Local and private URLs.** Unlike [`read`](/tools#documents-and-urls) (which blocks localhost and private IPs by default), `fetch_content` allows direct HTTP fetches of localhost and private-network URLs, but skips third-party Jina Reader and Gemini fallbacks whenever the URL or any redirect hop is private, single-label, `.localhost`/`.local`/`.internal`/`.lan`/`.home.arpa`, or carries embedded credentials.

<Note>
**PDF side effect.** Fetching a PDF URL downloads up to 20 MiB, extracts up to 100 pages, **writes the extracted Markdown into `~/Downloads`** (never overwriting existing files—collisions append `-2.md`, `-3.md`, etc.), and returns the saved file path, page count, and character count.
</Note>

### GitHub repositories

- **Cloning vs. GitHub API.** Code repository URLs are shallow-cloned unless the repository exceeds `githubClone.maxRepoSizeMB` (default `350` MB) or targets a full 40-hex commit SHA URL:
  - **Oversized repos:** Uses the GitHub API by default; pass `forceClone: true` to force a shallow clone anyway.
  - **Full 40-hex commit SHA URLs:** **Always** use the GitHub API and never clone, even when `forceClone: true` is passed.
  - **Private repos and `gh` CLI:** When an authenticated `gh` CLI is available, cloning and GitHub API access work on **private repositories** as well as public ones. Without `gh`, Atomic cannot check repo size or call the GitHub API, so `maxRepoSizeMB` enforcement and API fallback do not run.
  - **Non-code GitHub URLs** (`issues`, `pull`, `discussions`, `releases`, `wiki`, `actions`, `commits`, `compare`, and similar) bypass repository cloning and go through standard HTTP extraction.
- **Limits and cache cleanup.** Skips binary files and dependency/build directories (`node_modules`, `vendor`, `dist`, `build`, etc.), caps inline files at 100,000 characters, and caps directory listings at 200 entries. Atomic clears every Atomic-marked clone directory created during the session on session start, branch switch (`/tree`), and session shutdown—including under a custom `githubClone.clonePath`.

### Videos and frame extraction

- **Local videos.** Accepts absolute paths (including Windows drive and UNC paths—escape backslashes in JSON), `./` or `../` relative paths, and `file://` URLs for `.mp4`, `.mov`, `.webm`, `.avi`, `.mpeg`, `.mpg`, `.wmv`, `.flv`, `.3gp`, and `.3gpp`. Analysis tries **Gemini API first, then Gemini Web** (with browser cookies enabled). `video.maxSizeMB` (`50` by default) is measured in binary MiB. Setting `"video": { "enabled": false }` rejects local video paths for both analysis and frame extraction.
- **YouTube videos.** Analysis tries **Gemini Web first, then Gemini API, then Perplexity**. `/playlist` URLs are not treated as videos. Setting `"youtube": { "enabled": false }` disables both YouTube analysis and frame extraction.
- **Thumbnails, `prompt`, and `model`.** `prompt` and `model` apply only to video analysis (not webpages). Single-video analysis automatically attaches a thumbnail (`ffmpeg` frame at 1 second for local videos, or YouTube's thumbnail).
- **Frame extraction (`frames` and `timestamp`).** Extracts images from YouTube or local videos only (omit both for text/transcripts). `frames` accepts `1`–`12`; `timestamp` accepts seconds (`"85"`), `MM:SS` (`"1:25"`), `H:MM:SS`, or a `start-end` range (`"1:25-2:00"`):
  - `frames` alone samples evenly across the whole video (requires `ffprobe` for local files).
  - Single `timestamp` alone extracts 1 frame; single `timestamp` + `frames` extracts `N` frames at 5-second intervals.
  - Range `timestamp` alone extracts 6 frames; range `timestamp` + `frames` extracts up to `N` frames with at least 5-second spacing.
  - Requires `ffmpeg` (and `ffprobe` for whole-video local sampling), plus `yt-dlp` for YouTube.

```json
{"urls": ["/path/to/recording.mp4"], "timestamp": "1:25-2:00", "frames": 3}
```

<Warning>
**Fetch videos one URL at a time for frames.** Extracted frames and thumbnails are attached only when `urls` contains a **single** entry. In a multi-URL batch (`urls` with 2 or more entries), extracted frames and thumbnails are stripped and cannot be recovered with `get_search_content`.
</Warning>

### Fetch troubleshooting

If argument validation fails, confirm the field is lowercase `urls`, its value is a non-empty string array, and no unknown fields are present. If every URL in a batch fails, the error lists each URL and cause; retry transient failures individually with `fetch_content({ urls: ["<failed URL>"] })`, or try an alternate URL or `web_search`. `get_search_content` cannot recover failed fetches.

## Retrieve stored results (`get_search_content`) {#retrieve-stored-results}

`fetch_content` prints a `responseId` whenever single-URL output exceeds 30,000 characters or when fetching multiple URLs. `web_search` prints full summaries inline without truncating and prints a `[fetchId]` when `includeContent: true` stores page content (retrieve those pages with `url` or `urlIndex`). Stored `web_search` summaries are browsable in `/search` and accessible programmatically via `query` or `queryIndex`.

Pass `responseId` plus **at least one selector** (`url` / `urlIndex` for fetched pages; `query` / `queryIndex` for search results). Omitting selectors returns an error listing available queries or URLs. `query` and `url` take precedence over indices and match exact, case-sensitive strings.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `responseId` | string | Yes | ID returned by `fetch_content` or `web_search`. |
| `query` | string | One of `query` / `queryIndex` (search) | Exact case-sensitive search query from a stored `web_search` entry. |
| `queryIndex` | number | One of `query` / `queryIndex` (search) | Zero-based query index in a stored `web_search` entry. |
| `url` | string | One of `url` / `urlIndex` (fetch) | Exact case-sensitive URL from a stored fetch entry. |
| `urlIndex` | number | One of `url` / `urlIndex` (fetch) | Zero-based URL index in a stored fetch entry. |

<Note>
**1-hour retention on session resume.** When resuming a session or switching branches, `get_search_content` and `/search` restore only entries newer than **1 hour**. Older `responseId` values return `No stored results`.
</Note>

## Query GitHub repositories (`code_search`) {#code_search}

`code_search` asks DeepWiki (`https://mcp.deepwiki.com/mcp`) about code, architecture, and APIs in a public GitHub repository. It requires no API key or MCP setup and does not fall back to web search.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `repoName` | string | Yes | Public GitHub repository in `owner/repo` format (not a URL). |
| `query` | string | Yes | Question sent verbatim to DeepWiki. |
| `maxTokens` | integer | No | Best-effort output limit (`1000`–`50000`, default `5000`, ~4 chars/token). |

Requests have a 60-second deadline. See [`code_search` in Built-in tools](/tools#code_search) for an example.

## Slash commands and shortcuts {#slash-commands-and-shortcuts}

| Command | Action |
| --- | --- |
| `/curator [on\|off\|none\|summary-review]` | Set the search curator workflow and save it to `~/.atomic/web-search.json`. Omitting the argument toggles between `none` and `summary-review`. |
| `/websearch [query1, query2, ...]` | Open the interactive search curator directly without an agent round-trip. Splits arguments on commas into separate queries. Closing/cancelling sends nothing; timing out submits collected results as a summary-review follow-up. |
| `/search` | Browse, inspect, or delete stored `web_search` and `fetch_content` results from the current session. |
| `/google-account` | Print the active Google account used for Gemini Web when browser cookie access is enabled, without starting a model turn. |

| Shortcut | Config key | Action |
| --- | --- | --- |
| `Ctrl+Shift+S` | `shortcuts.curate` | Open the curator while a `workflow: "summary-review"` search is running (where the curator already opens automatically on start). Has no effect under the default `workflow: "none"`; use `/curator on` or `/websearch` instead. |
| `Ctrl+Shift+W` | `shortcuts.activity` | Toggle the web search activity widget. |

Customize shortcuts in `~/.atomic/web-search.json` under `"shortcuts"`. Shortcut changes take effect after restarting Atomic.

## Configure `web-search.json`

All fields in `~/.atomic/web-search.json` are optional. If `~/.atomic/web-search.json` does not exist, Atomic falls back to `~/.pi/web-search.json` without merging the two files; interactive saves always write `~/.atomic/web-search.json`. (Legacy `searchProvider` is still accepted as a fallback for `provider`.)

| Field | Type | Default | Applies | Description |
| --- | --- | --- | --- | --- |
| `provider` | `"auto" \| "exa" \| "perplexity" \| "gemini"` | `"auto"` | `/reload` (curator switch is immediate) | Default `web_search` provider. |
| `workflow` | `"none" \| "summary-review"` | `"none"` | Immediate | `"none"` returns raw results; `"summary-review"` opens the browser curator. |
| `curatorTimeoutSeconds` | number (`1`–`600`) | `20` | Immediate | Curator wait timeout in seconds (floored; `< 1` falls back to `20`; `> 600` clamps to `600`). |
| `summaryModel` | string | auto | Immediate | `"provider/model"` for curator summary drafts (prefers `anthropic/claude-haiku-4-5` or `openai-codex/gpt-6.1-sol`). |
| `searchModel` | string | `"gemini-3-flash-preview"` | `/reload` | Gemini API model used for Gemini search queries (ignored by Gemini Web). |
| `shortcuts` | `{ curate?, activity? }` | `ctrl+shift+s` / `ctrl+shift+w` | Restart | Keyboard shortcuts for the curator and activity widget. |
| `exaApiKey` | string | unset | `/reload` | Exa API key (overridden by `EXA_API_KEY`). |
| `perplexityApiKey` | string | unset | `/reload` | Perplexity API key (overridden by `PERPLEXITY_API_KEY`). |
| `geminiApiKey` | string | unset | `/reload` | Gemini API key (overridden by `GEMINI_API_KEY`). |
| `allowBrowserCookies` | boolean | `false` | `/reload` | Allow Gemini Web cookie reading on macOS and Linux (overridden by `ATOMIC_ALLOW_BROWSER_COOKIES=1`). |
| `chromeProfile` | string | `"Default"` | `/reload` | Browser profile directory name for Gemini Web cookies. |
| `githubClone` | object | `enabled: true`, `maxRepoSizeMB: 350`, `cloneTimeoutSeconds: 30` | `/reload` | GitHub clone settings and optional `clonePath` (account-private temp folder by default; Atomic-marked clones under any `clonePath` clear on session switch/shutdown). |
| `youtube` | object | `enabled: true`, `preferredModel: "gemini-3-flash-preview"` | `/reload` | YouTube analysis and frame extraction settings (`enabled: false` disables both). |
| `video` | object | `enabled: true`, `preferredModel: "gemini-3-flash-preview"`, `maxSizeMB: 50` | `/reload` | Local video settings (`enabled: false` disables both analysis and frame extraction; `maxSizeMB` is binary MiB). |

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

<Note>
**Helper binary lookup.** Helper binaries (`gh`, `git`, `ffmpeg`, `ffprobe`, `yt-dlp`, `npm`, browser openers, and OS keychain helpers) resolve only from absolute directories in `PATH`. The current project directory is searched only when `PATH` explicitly lists it.
</Note>

## Enable and disable web access

Web access is enabled by default in both the CLI and the SDK.

- **CLI:** Disable web-access tools for one run with `--exclude-tools`:

```bash
atomic --exclude-tools web_search,fetch_content,get_search_content,code_search
```

- **SDK:** Disable the bundled `web-access` integration completely in `createAgentSession()`:

```typescript
import { createAgentSession } from "@bastani/atomic";

const { session } = await createAgentSession({
  builtins: { "web-access": false },
});
```

## Related docs

<Columns cols={2}>
  <Card title="Built-in tools" href="/tools">
    Compare `read` URL fetching and `code_search`, and configure default tools.
  </Card>
  <Card title="Environment variables" href="/environment-variables">
    Atomic environment variables, browser cookie opt-in, and provider credentials.
  </Card>
  <Card title="CLI reference" href="/reference/cli#tool-options">
    Filter tools with `--tools`, `--exclude-tools`, and `--no-tools`.
  </Card>
  <Card title="SDK tools" href="/sdk/reference#tools">
    Configure `builtins`, `tools`, and `excludedTools` programmatically.
  </Card>
</Columns>
