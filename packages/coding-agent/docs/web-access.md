---
title: "Web access"
description: "Built-in web_search, fetch_content, get_search_content, and code_search tools, slash commands, shortcuts, and ~/.atomic/web-search.json settings."
---

# Web access

Atomic bundles four web-access tools: `web_search` for searching the web, `fetch_content` for reading pages and media, `get_search_content` for retrieving full stored results, and `code_search` for querying public GitHub repositories. `web_search` and `code_search` both work with no API key setup.

## Searching with `web_search`

Pass `query` for a single lookup, or `queries` (an array of 2 to 4 varied angles) for broader research. Optional parameters are `numResults` (default `5`, max `20`), `includeContent` (boolean, fetches full page text in the background), `recencyFilter` (`"day"`, `"week"`, `"month"`, or `"year"`), `domainFilter` (array of domains; prefix with `-` to exclude), and `provider` (`"auto"`, `"exa"`, `"perplexity"`, or `"gemini"`).

With `provider: "auto"` (the default), Atomic uses the first provider that works:

1. **Exa.** Calls the Exa API when a key is set, or uses Exa's free keyless MCP endpoint (`mcp.exa.ai`) when unconfigured.
2. **Perplexity.** Used when a key is set.
3. **Gemini API.** Used when a key is set.
4. **Gemini Web.** Uses your signed-in Chromium-based browser. Browser cookie access is off by default; enable it with `"allowBrowserCookies": true` in `~/.atomic/web-search.json` or `ATOMIC_ALLOW_BROWSER_COOKIES=1`.

Environment variables take precedence over keys in `~/.atomic/web-search.json`:

| Provider | Environment variable | `web-search.json` field |
| --- | --- | --- |
| Exa | `EXA_API_KEY` | `exaApiKey` |
| Perplexity | `PERPLEXITY_API_KEY` | `perplexityApiKey` |
| Gemini API | `GEMINI_API_KEY` | `geminiApiKey` |

```json
{
  "exaApiKey": "your-key",
  "provider": "auto"
}
```

When no provider can be reached, the error names these environment variables and config fields.

### The search curator

By default, `web_search` returns raw results. Run `/curator on` (or set `"workflow": "summary-review"` in `~/.atomic/web-search.json`) to open an interactive browser review window where you filter results and approve a summary draft before the agent sees them. Run `/curator off` to return to raw results.

The curator requires an interactive session with a browser. Subagents and non-interactive runs skip it and return raw results. If the browser cannot open (for example on a headless machine), `web_search` falls back to raw results with a note pointing to `/curator off`.

## Fetching with `fetch_content`

`fetch_content` reads webpages (as markdown), PDFs, GitHub repositories, YouTube videos, and local video files.

### Arguments

Always pass the lowercase `urls` field as a nonempty array of strings, even for one URL:

```json
{"urls": ["https://example.com/article"]}
```

For multiple pages (fetched in parallel):

```json
{"urls": ["https://example.com/one", "https://example.com/two"]}
```

For video analysis, include your question in `prompt`:

```json
{"urls": ["/path/to/recording.mp4"], "prompt": "What error appears on screen?"}
```

Local videos accept absolute paths (including Windows drive and UNC paths), `./` or `../` relative paths, and `file://` URLs. Escape Windows backslashes in JSON, for example `{"urls": ["C:\\Videos\\recording.mp4"], "frames": 1}`.

- `prompt` and `model` apply only to YouTube and local video analysis, not webpage extraction.
- `forceClone` applies only to GitHub repositories and allows cloning repositories above `githubClone.maxRepoSizeMB`.
- `frames` (`1` to `12`) and `timestamp` (seconds such as `"85"`, a time such as `"1:25"`, or a range such as `"1:25-2:00"`, which defaults to 6 frames) extract images from YouTube or local videos only. Omit both for text or transcripts. Non-video inputs ignore them even inside mixed batches.

```json
{"urls": ["/path/to/recording.mp4"], "timestamp": "1:25-2:00", "frames": 3}
```

Frame extraction requires `ffmpeg`, plus `yt-dlp` for YouTube.

Pass `{"urls": ["..."]}`, not the retired singular `{"url": "..."}` field (the singular `url` selector still belongs to `get_search_content`). Although Atomic can normalize a scalar `urls` string into a one-item array, always pass an array in prompts and integrations.

### Troubleshooting

If argument validation fails, check that:

- The field is `urls`, not `URLs` or `url`.
- Its value is a nonempty array of strings.
- No unrecognized fields are present.

If every URL in a batch fails, the error lists each URL and its cause; partial excerpts may still appear as incomplete content. Retry transient failures individually with `fetch_content({ urls: ["<failed URL>"] })`, or try an alternate URL or `web_search`. `get_search_content` cannot recover content from a failed fetch.

## Retrieving full results with `get_search_content`

When `web_search` or `fetch_content` truncates output or stores background fetches, it returns a `responseId`. Pass that ID to `get_search_content` to read the complete stored result:

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `responseId` | string | Yes | ID returned by a previous `web_search` or `fetch_content` call |
| `query` | string | No | Exact search query to retrieve from a stored `web_search` response |
| `queryIndex` | number | No | Zero-based query index in a stored `web_search` response |
| `url` | string | No | Exact URL to retrieve from a stored `fetch_content` response |
| `urlIndex` | number | No | Zero-based URL index in a stored `fetch_content` response |

## `code_search`

`code_search` asks DeepWiki (`https://mcp.deepwiki.com/mcp`) about code, architecture, and APIs in a public GitHub repository. It requires no API key or MCP setup and does not fall back to web search.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `repoName` | string | Yes | Public GitHub repository in `owner/repo` format (not a URL) |
| `query` | string | Yes | Question sent verbatim to DeepWiki |
| `maxTokens` | integer | No | Best-effort output limit (`1000` to `50000`, default `5000`, about 4 chars per token) |

Requests have a 60-second deadline. See [`code_search` in Built-in tools](/tools#code_search) for examples and fallback guidance.

## Slash commands and shortcuts

| Command | Action |
| --- | --- |
| `/curator [on\|off\|none\|summary-review]` | Toggle or set the search curator workflow and save it to `~/.atomic/web-search.json` |
| `/websearch [query1, query2, ...]` | Open the interactive search curator directly without an agent round-trip, optionally running comma-separated queries |
| `/search` | Browse, inspect, or delete stored `web_search` and `fetch_content` results from the current session |
| `/google-account` | Show the active Google account used for Gemini Web when browser cookie access is enabled |

| Shortcut | Config key | Action |
| --- | --- | --- |
| `Ctrl+Shift+S` | `shortcuts.curate` | Open the search curator while a search is running |
| `Ctrl+Shift+W` | `shortcuts.activity` | Toggle the web search activity widget |

Customize shortcuts in `~/.atomic/web-search.json` under `"shortcuts"`. Shortcut changes take effect after restarting Atomic.

## Configuration (`~/.atomic/web-search.json`)

All fields in `~/.atomic/web-search.json` are optional. If `~/.atomic/web-search.json` does not exist, Atomic falls back to legacy `~/.pi/web-search.json` without merging the two files; interactive saves always write `~/.atomic/web-search.json`.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `provider` | `"auto" \| "exa" \| "perplexity" \| "gemini"` | `"auto"` | Default `web_search` provider (also accepts legacy `searchProvider`; switching providers in the curator updates this field) |
| `workflow` | `"none" \| "summary-review"` | `"none"` | `"none"` returns raw results; `"summary-review"` opens the browser curator with a summary draft |
| `curatorTimeoutSeconds` | number (`1` to `600`) | `20` | Curator wait timeout in seconds |
| `summaryModel` | string | auto | Default `"provider/model"` used for curator summary drafts (prefers `anthropic/claude-haiku-4-5` or `openai-codex/gpt-6.1-sol` when available) |
| `searchModel` | string | `"gemini-3-flash-preview"` | Gemini API model used for Gemini search queries |
| `shortcuts` | `{ curate?: string, activity?: string }` | `{ "curate": "ctrl+shift+s", "activity": "ctrl+shift+w" }` | Keyboard shortcuts for opening the curator and toggling the activity widget |
| `exaApiKey` | string | unset | Exa API key (overridden by `EXA_API_KEY`) |
| `perplexityApiKey` | string | unset | Perplexity API key (overridden by `PERPLEXITY_API_KEY`) |
| `geminiApiKey` | string | unset | Gemini API key (overridden by `GEMINI_API_KEY`) |
| `allowBrowserCookies` | boolean | `false` | Allow Gemini Web to read cookies from a Chromium-based browser (overridden by `ATOMIC_ALLOW_BROWSER_COOKIES=1`) |
| `chromeProfile` | string | unset | Chromium profile directory name used for Gemini Web cookie lookup |
| `githubClone` | object | see below | GitHub clone settings: `enabled` (`true`), `maxRepoSizeMB` (`350`), `cloneTimeoutSeconds` (`30`), and `clonePath` (default private account temp directory) |
| `youtube` | object | see below | YouTube analysis settings: `enabled` (`true`) and `preferredModel` (`"gemini-3-flash-preview"`) |
| `video` | object | see below | Local video analysis settings: `enabled` (`true`), `preferredModel` (`"gemini-3-flash-preview"`), and `maxSizeMB` (`50`) |

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

## Helper binary lookup

Helper binaries (`gh`, `git`, `ffmpeg`, `ffprobe`, `yt-dlp`, `npm`, browser openers, and OS keychain helpers) are resolved only from absolute directories in `PATH`. The current project directory is searched only when `PATH` explicitly lists it.
