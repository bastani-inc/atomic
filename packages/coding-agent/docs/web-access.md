# Fetching web content

Atomic's bundled `fetch_content` tool reads webpages, PDFs, GitHub repositories, YouTube videos, and local video files.

## Arguments

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

For webpages, `urls` is enough. `prompt` and `model` apply to video analysis, not webpage filtering or extraction. `forceClone` applies only to GitHub repositories.

Use `frames` and `timestamp` only when you want images from YouTube or local video files. Omit both for readable text or transcripts. `frames` alone samples the whole video; `timestamp` accepts seconds, a time such as `1:25`, or a range such as `1:25-2:00`.

```json
{"urls": ["/path/to/recording.mp4"], "timestamp": "1:25-2:00", "frames": 3}
```

Frame extraction requires ffmpeg, plus yt-dlp for YouTube. Non-video inputs ignore `frames` and `timestamp` and are fetched normally, even in a batch containing videos. Video inputs still validate timestamps and report extraction errors.

Existing prompts or integrations using `{"url": "..."}` must change to `{"urls": ["..."]}`. The singular `url` field is no longer accepted by `fetch_content`. This does not change the `url` selector on `get_search_content`.

Atomic can normalize a scalar `urls` string into a one-item array. Always use the documented array form in prompts and integrations; the legacy `url` field is not normalized.

## Troubleshooting

If argument validation fails, check that:

- The field is `urls`, not `URLs` or `url`.
- Its value is an array, not a string or an object.
- The array contains at least one nonempty string.
- The call has no unrecognized fields.

If every URL in a batch fails, the error lists each URL and its cause. Extraction errors may still include partial content, shown as incomplete excerpts. Check the URLs and retry transient failures individually with `fetch_content({ urls: ["<failed URL>"] })`. For blocked pages or repeated extraction failures, try an accessible alternate URL or use `web_search`. `get_search_content` cannot recover missing content from a failed fetch.

When fetched content is truncated, follow the returned `get_search_content` call to retrieve the stored content.
