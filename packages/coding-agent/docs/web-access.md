# Web access

Atomic bundles `web_search` for searching the web and `fetch_content` for reading pages. `web_search` works with no setup; the sections below cover how it picks a provider and how to configure one.

## Searching with `web_search`

Pass `query`, or `queries` for several angles at once. `provider` can be `auto` (the default), `exa`, `perplexity`, or `gemini`.

With `auto`, Atomic uses the first provider that works:

1. **Exa**: with a key it calls the Exa API; without one it uses Exa's free keyless MCP endpoint (`mcp.exa.ai`), so an unconfigured machine with network access still gets results.
2. **Perplexity**, with a key.
3. **Gemini API**, with a key.
4. **Gemini Web**, using your signed-in Chromium-based browser. Browser cookie access is off by default; enable it with `allowBrowserCookies: true` or `ATOMIC_ALLOW_BROWSER_COOKIES=1`.

Keys come from the environment or from `~/.atomic/web-search.json`:

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

`provider` sets the default provider. When no provider can be reached, the error names these settings.

### The search curator

By default `web_search` returns raw results. `/curator on` (or `"workflow": "summary-review"` in `web-search.json`) opens a browser page where you review the results and approve a summary before the agent sees them; `/curator off` turns it back off. The curator changes how results are reviewed, not which provider is used.

It needs an interactive session with a person at a browser. Subagents, workflow stages, and non-interactive runs skip it and return raw results. If the page cannot open, for example on a machine with no desktop browser, `web_search` returns raw results with a note instead of failing; run `/curator off` to stop trying.

## Fetching with `fetch_content`

Atomic's bundled `fetch_content` tool reads webpages, PDFs, GitHub repositories, YouTube videos, and local video files.

### Arguments

Always pass the lowercase `urls` field as a nonempty array of strings, even for one URL:

```json
{"urls": ["https://example.com/article"]}
```

For multiple pages:

```json
{"urls": ["https://example.com/one", "https://example.com/two"]}
```

For a video, include the question in `prompt`:

```json
{"urls": ["/path/to/recording.mp4"], "prompt": "What error appears on screen?"}
```

Local videos accept native absolute paths (including Windows drive and UNC paths), `./` or `../` relative paths, and `file://` URLs. Escape Windows backslashes in JSON, for example `{"urls": ["C:\\Videos\\recording.mp4"], "frames": 1}`.

For webpages, `urls` is enough. `prompt` and `model` apply to video analysis, not webpage filtering or extraction. `forceClone` applies only to GitHub repositories.

Use `frames` and `timestamp` only when you want images from YouTube or local video files. Omit both for readable text or transcripts. `frames` alone samples the whole video; `timestamp` accepts seconds, a time such as `1:25`, or a range such as `1:25-2:00`.

```json
{"urls": ["/path/to/recording.mp4"], "timestamp": "1:25-2:00", "frames": 3}
```

Frame extraction requires ffmpeg, plus yt-dlp for YouTube. Non-video inputs ignore `frames` and `timestamp` and are fetched normally, even in a batch containing videos. Video inputs still validate timestamps and report extraction errors.

Existing prompts or integrations using `{"url": "..."}` must change to `{"urls": ["..."]}`. The singular `url` field is no longer accepted by `fetch_content`. This does not change the `url` selector on `get_search_content`.

Atomic can normalize a scalar `urls` string into a one-item array. Always use the documented array form in prompts and integrations; the legacy `url` field is not normalized.

### Troubleshooting

If argument validation fails, check that:

- The field is `urls`, not `URLs` or `url`.
- Its value is an array, not a string or an object.
- The array contains at least one nonempty string.
- The call has no unrecognized fields.

If every URL in a batch fails, the error lists each URL and its cause. Extraction errors may still include partial content, shown as incomplete excerpts.

Check the URLs and retry transient failures individually with `fetch_content({ urls: ["<failed URL>"] })`. For blocked pages or repeated extraction failures, try an accessible alternate URL or use `web_search`. `get_search_content` cannot recover missing content from a failed fetch.

When fetched content is truncated, follow the returned `get_search_content` call to retrieve the stored content.
