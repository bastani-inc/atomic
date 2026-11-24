# @bastani/web-access

`@bastani/web-access` is Atomic's bundled extension for web search, webpage and PDF extraction, GitHub repository cloning, DeepWiki code search, and YouTube and local video analysis.

See the [web access guide](https://docs.bastani.ai/web-access) for usage examples and fetch troubleshooting.

## Setup

Atomic bundles `@bastani/web-access` with `@bastani/atomic`. No separate installation is required.

`web_search` works with no API keys through Exa's keyless MCP endpoint. For direct API access or additional providers, export environment variables (`EXA_API_KEY`, `PERPLEXITY_API_KEY`, `GEMINI_API_KEY`) or add keys to `~/.atomic/web-search.json`:

```json
{
  "exaApiKey": "exa-...",
  "perplexityApiKey": "pplx-...",
  "geminiApiKey": "AIza..."
}
```

When `~/.atomic/web-search.json` is absent, Atomic checks legacy `~/.pi/web-search.json` without merging the two files.

In `auto` mode (the default), `web_search` tries Exa first (direct API if keyed, keyless MCP if not), then Perplexity, then Gemini API, and then Gemini Web when browser cookie access is enabled.

Optional binaries for video frame extraction:

```bash
brew install ffmpeg   # frame extraction, video thumbnails, local video duration
brew install yt-dlp   # YouTube stream URLs for frame extraction
```

Video analysis (transcripts and visual descriptions through Gemini) works without these binaries. Only frame image extraction requires them.

## Quick start

```typescript
// Search the web
web_search({ query: "TypeScript 5.8 release notes" })

// Fetch a page
fetch_content({ urls: ["https://docs.example.com/guide"] })

// Ask DeepWiki about a public GitHub repository
code_search({ repoName: "facebook/react", query: "How does useEffect cleanup work?" })

// Clone a GitHub repository
fetch_content({ urls: ["https://github.com/owner/repo"] })

// Analyze a YouTube video
fetch_content({ urls: ["https://youtube.com/watch?v=abc"], prompt: "What libraries are shown?" })

// Analyze a local screen recording
fetch_content({ urls: ["/path/to/recording.mp4"], prompt: "What error appears on screen?" })
```

## Tools

All four tools register at startup and initialize on first use. In batch search and fetch calls, partial successes remain usable alongside per-item errors; if every item in a batch fails, the tool returns an error with diagnostics for each item. Cancelling inside the browser curator returns `{ cancelled: true, cancelReason: "user" }`.

### `web_search`

Search the web through Exa, Perplexity AI, or Gemini. Each query returns a synthesized answer with source citations. The browser curator UI is off by default; enable it with `/curator on` or `"workflow": "summary-review"` in `~/.atomic/web-search.json`.

```typescript
web_search({ query: "rust async programming" })
web_search({ queries: ["query 1", "query 2"] })
web_search({ query: "latest news", numResults: 10, recencyFilter: "week" })
web_search({ query: "release notes", domainFilter: ["github.com"] })
web_search({ query: "release notes", provider: "exa" })
web_search({ query: "release notes", includeContent: true })
```

| Parameter | Description |
| --- | --- |
| `query` / `queries` | Single query or array of queries searched in sequence. |
| `numResults` | Results per query (default `5`, max `20`). |
| `recencyFilter` | `day`, `week`, `month`, or `year`. |
| `domainFilter` | Limit to domains, or prefix a domain with `-` to exclude it. |
| `provider` | `auto` (default), `exa`, `perplexity`, or `gemini`. |
| `includeContent` | Fetch full page content from returned sources in the background. |

### `code_search`

Ask questions about code, architecture, and APIs in a public GitHub repository through DeepWiki MCP at `https://mcp.deepwiki.com/mcp`. No API key or local MCP configuration is required. DeepWiki availability and repository indexing determine which repositories it can answer.

```typescript
code_search({ repoName: "facebook/react", query: "How does useEffect cleanup work?" })
code_search({ repoName: "expressjs/express", query: "How is middleware error handling implemented?", maxTokens: 10000 })
```

| Parameter | Description |
| --- | --- |
| `repoName` | Required single public GitHub repository in `owner/repo` format, not a URL or list. |
| `query` | Required nonempty question about that repository, sent verbatim to DeepWiki's `ask_question`. |
| `maxTokens` | Optional best-effort local output bound, roughly four characters per token, with a truncation notice (default `5000`, range `1000` to `50000`). |

Requests have a 60-second deadline and honor caller cancellation. Errors and empty responses are reported directly without falling back to `web_search`. Use `web_search` for broader discovery or unindexed repositories.

### `fetch_content`

Fetch URLs or local video paths and return readable Markdown. The tool detects GitHub repositories, YouTube videos, PDFs, local video files, and regular webpages automatically.

Always pass the lowercase `urls` field as a nonempty array of strings, even for one target. Legacy `{ url: "..." }` calls, empty arrays, empty strings, object entries, and unrecognized fields are rejected before fetching.

```typescript
fetch_content({ urls: ["https://example.com/article"] })
fetch_content({ urls: ["https://example.com/one", "https://example.com/two"] })
fetch_content({ urls: ["https://github.com/owner/repo"] })
fetch_content({ urls: ["https://youtube.com/watch?v=abc"], prompt: "What libraries are shown?" })
fetch_content({ urls: ["/path/to/recording.mp4"], prompt: "What error appears on screen?" })
fetch_content({ urls: ["https://youtube.com/watch?v=abc"], timestamp: "23:41-25:00", frames: 4 })
```

| Parameter | Description |
| --- | --- |
| `urls` | Required nonempty array of URL or local video path strings. |
| `prompt` | Question for YouTube or local video analysis. Ignored for webpages. |
| `timestamp` | Video frame extraction time: seconds (`"85"`), a single time (`"23:41"`), or a range (`"23:41-25:00"`). Ignored for non-video inputs. |
| `frames` | Number of video frames to extract (`1` to `12`). Alone, samples the whole video; with a range, defaults to `6` unless set; with a single timestamp, uses 5-second intervals. Ignored for non-video inputs. |
| `model` | Gemini model override for YouTube or local video analysis only. Does not change webpage extraction. |
| `forceClone` | Allow cloning a GitHub repository that exceeds `githubClone.maxRepoSizeMB` (default `350` MB). |

### `get_search_content`

Retrieve stored content from earlier `web_search` or `fetch_content` calls. Inline content longer than 30,000 characters is truncated in tool responses and stored in full for retrieval here.

```typescript
get_search_content({ responseId: "abc123", urlIndex: 0 })
get_search_content({ responseId: "abc123", url: "https://example.com/article" })
get_search_content({ responseId: "abc123", query: "original query" })
get_search_content({ responseId: "abc123", queryIndex: 0 })
```

| Parameter | Description |
| --- | --- |
| `responseId` | Required response ID from a previous `web_search` or `fetch_content` result. |
| `query` | Retrieve the stored result for a specific `web_search` query string. |
| `queryIndex` | Retrieve the stored `web_search` query result by zero-based index. |
| `url` | Retrieve the stored page content for a specific URL. |
| `urlIndex` | Retrieve the stored page content by zero-based index. |

## Capabilities

### GitHub repositories

GitHub repository URLs are cloned locally instead of scraped, giving the agent file contents and a local path for `read` and `bash`. Root URLs return the repository tree and README, `/tree/` paths return directory listings, and `/blob/` paths return file contents.

Repositories larger than 350 MB receive an API-based view unless `forceClone: true` is passed. Full commit SHA URLs also use the GitHub API. Clones are cached for the session and cleared on session change. Private repositories require an authenticated `gh` CLI.

By default, clones go to an owner-only `github-repos` directory under `$XDG_RUNTIME_DIR/atomic` when set, else under `cache/tmp` in the agent directory, else under `atomic-<uid>` in the system temp directory. Set `githubClone.clonePath` to choose another location.

### YouTube videos

YouTube URLs use Gemini for visual descriptions, timestamped transcripts, and chapter markers. Pass `prompt` to ask a specific question about the video. Results include the video thumbnail when available. Setting `youtube.enabled: false` disables both YouTube analysis and YouTube frame extraction.

Fallback order is Gemini Web (when browser cookies are enabled), then Gemini API, and then Perplexity (text summary only). Supported URL formats include `/watch?v=`, `youtu.be/`, `/shorts/`, `/live/`, `/embed/`, and `/v/`.

### Local video files

Pass a native absolute path (including Windows drive and UNC paths), a `./` or `../` relative path, or a `file://` URL to analyze a local video file through Gemini. Common formats such as MP4, MOV, WebM, and AVI are supported up to 50 MB by default (`video.maxSizeMB`). If `ffmpeg` is installed, a thumbnail frame is included alongside the analysis.

Fallback order is Gemini API (Files API upload), then Gemini Web when browser cookies are enabled.

### Video frame extraction

Pass `timestamp`, `frames`, or both on a YouTube URL or local video file to extract frames as images:

```typescript
fetch_content({ urls: ["https://youtube.com/watch?v=abc"], timestamp: "23:41" })
fetch_content({ urls: ["https://youtube.com/watch?v=abc"], timestamp: "23:41-25:00" })
fetch_content({ urls: ["https://youtube.com/watch?v=abc"], timestamp: "23:41-25:00", frames: 3 })
fetch_content({ urls: ["https://youtube.com/watch?v=abc"], timestamp: "23:41", frames: 5 })
fetch_content({ urls: ["/path/to/recording.mp4"], frames: 6 })
```

Frame extraction requires `ffmpeg`, plus `yt-dlp` for YouTube. Timestamps accept `H:MM:SS`, `MM:SS`, or bare seconds.

### PDFs

PDF URLs up to 20 MB are extracted as text (up to 100 pages) and saved to `~/Downloads/` as Markdown files with unique names so concurrent fetches do not overwrite existing files. The agent can then inspect sections with `read` without loading the whole file into context. Extraction is text-only and does not perform OCR.

### Blocked pages

When Readability fails or returns only a cookie notice, the extension tries the Next.js RSC flight data parser, Jina Reader (server-side JS rendering with no API key), Gemini URL Context API, and then Gemini Web when browser cookies are enabled. Text responses are capped at 5 MB and 20 redirects.

Only `http` and `https` URLs are fetched. URLs with embedded credentials, local or private addresses (including redirects to them), and intranet host names are never sent to remote fallbacks ([Security](https://docs.bastani.ai/security), [Tools](https://docs.bastani.ai/tools#documents-and-urls)).

## Routing

`web_search` tries providers in this order in `auto` mode:

1. Exa (direct API with a key, keyless MCP without).
2. Perplexity.
3. Gemini API.
4. Gemini Web when browser cookies are enabled.

`fetch_content` routes each target by type:

- Local video paths use Gemini API (Files API), then Gemini Web when browser cookies are enabled.
- GitHub repository URLs clone locally, or use the GitHub API for large repositories and full commit SHAs.
- YouTube URLs use Gemini Web when browser cookies are enabled, then Gemini API, and then Perplexity.
- HTTP and HTTPS URLs branch by content type. PDFs extract text to Markdown in `~/Downloads/`. HTML runs Readability, the RSC parser, Jina Reader, and then Gemini fallback. Plain text, JSON, and Markdown return directly.

## Commands

### `/websearch`

Open the browser search curator directly. You can run searches, add queries, select results, and approve a summary before sending results into the conversation.

```text
/websearch
/websearch react hooks, next.js caching
```

Passing comma-separated terms pre-fills the curator queries. On timeout, the curator submits automatically and falls back to a deterministic summary if no approved draft exists.

### `/curator`

Toggle or configure the curator workflow at runtime:

```text
/curator
/curator on
/curator off
/curator none
/curator summary-review
```

This command saves `workflow` to `~/.atomic/web-search.json` and takes effect on the next `web_search` call. When disabled (`none`, the default), `web_search` returns raw results without opening a browser window. Subagents and non-interactive sessions always skip the curator and return raw results.

### `/search`

Browse stored search and fetch results from the current session interactively, inspect their response IDs, or delete entries.

### `/google-account`

Show the Google account currently authenticated for Gemini Web locally without triggering a model turn. This helps verify the active account when multiple Chromium profiles exist or `chromeProfile` is set.

## Keyboard shortcuts and activity monitor

| Shortcut | Default | Action |
| --- | --- | --- |
| `shortcuts.curate` | `Ctrl+Shift+S` | Open the browser search curator while a search is running. |
| `shortcuts.activity` | `Ctrl+Shift+W` | Toggle the live request and response activity monitor. |

```text
─── Web Search Activity ────────────────────────────────────
  API  "typescript best practices"     200    2.1s ✓
  GET  docs.example.com/article        200    0.8s ✓
  GET  blog.example.com/post           404    0.3s ✗
────────────────────────────────────────────────────────────
```

Override shortcuts in `~/.atomic/web-search.json` using Atomic keybinding syntax (`ctrl+s`, `ctrl+shift+s`, `alt+r`). Shortcut changes take effect on the next Atomic restart.

## Configuration

Store settings in `~/.atomic/web-search.json`. Every field is optional. Environment variables (`EXA_API_KEY`, `PERPLEXITY_API_KEY`, `GEMINI_API_KEY`) take precedence over keys in the JSON file.

```json
{
  "exaApiKey": "exa-...",
  "perplexityApiKey": "pplx-...",
  "geminiApiKey": "AIza...",
  "provider": "auto",
  "chromeProfile": "Profile 2",
  "allowBrowserCookies": false,
  "searchModel": "gemini-3-flash-preview",
  "summaryModel": "anthropic/claude-haiku-4-5",
  "workflow": "none",
  "curatorTimeoutSeconds": 20,
  "githubClone": {
    "enabled": true,
    "maxRepoSizeMB": 350,
    "cloneTimeoutSeconds": 30,
    "clonePath": "/path/to/github-repos"
  },
  "youtube": {
    "enabled": true,
    "preferredModel": "gemini-3-flash-preview"
  },
  "video": {
    "enabled": true,
    "preferredModel": "gemini-3-flash-preview",
    "maxSizeMB": 50
  },
  "shortcuts": {
    "curate": "ctrl+shift+s",
    "activity": "ctrl+shift+w"
  }
}
```

| Setting | Default | Description |
| --- | --- | --- |
| `exaApiKey`, `perplexityApiKey`, `geminiApiKey` | unset | Provider API keys. Matching environment variables take precedence. |
| `provider` | `"auto"` | Default search provider (`"auto"`, `"exa"`, `"perplexity"`, or `"gemini"`). Switching the provider in the curator UI updates the active config immediately. |
| `workflow` | `"none"` | Curator mode: `"none"` (raw results) or `"summary-review"` (opens the curator with a generated summary draft). |
| `searchModel` | `"gemini-3-flash-preview"` | Gemini API model used by `web_search` without changing URL, YouTube, or video extraction defaults. |
| `summaryModel` | built-in preference list | Preferred model for curator summary drafts (must be available in your model registry). |
| `curatorTimeoutSeconds` | `20` | Initial curator idle timeout in seconds (max `600`). |
| `allowBrowserCookies` | `false` | Enable Chromium cookie extraction for Gemini Web (also controllable per process with `ATOMIC_ALLOW_BROWSER_COOKIES=1`; see [Environment variables](https://docs.bastani.ai/environment-variables)). |
| `chromeProfile` | auto-detected | Override Chromium profile directory for Gemini Web cookie lookup. |
| `githubClone.enabled` | `true` | Enable local GitHub repository cloning in `fetch_content`. |
| `githubClone.maxRepoSizeMB` | `350` | Size threshold above which `fetch_content` falls back to the GitHub API unless `forceClone: true`. |
| `githubClone.cloneTimeoutSeconds` | `30` | Timeout in seconds for `git clone`. |
| `githubClone.clonePath` | system cache dir | Override directory for cloned repositories. |
| `youtube.enabled` | `true` | Enable YouTube analysis and frame extraction. |
| `youtube.preferredModel` | `"gemini-3-flash-preview"` | Preferred Gemini model for YouTube analysis. |
| `video.enabled` | `true` | Enable local video analysis. |
| `video.preferredModel` | `"gemini-3-flash-preview"` | Preferred Gemini model for local video analysis. |
| `video.maxSizeMB` | `50` | Maximum local video file size in MB. |
| `shortcuts.curate` / `shortcuts.activity` | `ctrl+shift+s` / `ctrl+shift+w` | Keyboard shortcuts for curator and activity monitor. |

Most config file edits require restarting Atomic to take effect (switching provider or `/curator` in a running session updates active config immediately).

### Rate limits and concurrency

Perplexity requests are rate-limited on the client to 10 requests per minute. `fetch_content` runs up to 3 concurrent fetches with a 30-second timeout per URL.

## Limitations

- Chromium cookie extraction for Gemini Web is opt-in through `allowBrowserCookies: true` or `ATOMIC_ALLOW_BROWSER_COOKIES=1`. On macOS, enabling it may trigger a Keychain dialog. On Linux, Atomic uses `secret-tool` when available and falls back to Chromium's default password otherwise.
- Private or age-restricted YouTube videos may fail on every extraction path.
- Gemini processes videos up to about one hour; longer videos may be truncated.
- PDFs are text-extracted only, with no OCR for scanned documents.
- GitHub branch names containing slashes may misresolve file paths inside `/tree/` or `/blob/` URLs. The local clone still works and the agent can inspect files directly.
- Non-code GitHub URLs (issues, pull requests, discussions, releases, and wikis) fall through to regular webpage extraction.

## License

MIT. See [LICENSE](LICENSE).
