---
source_url: https://github.com/vadimdemedes/ink
fetched_at: 2026-06-26
fetch_method: fetch_content github clone
commit_sha: 25766aec618bd62030069f57dd081e5ebdd46add
topic: Ink rendering stability, Static, layout sizing, throttling, incremental rendering, testing
---

# Ink rendering stability notes

Authoritative Ink README/source snapshot for issue 1517 research.

Key sections:
- Box `height`, `minHeight`, `maxHeight`: https://github.com/vadimdemedes/ink/blob/25766aec618bd62030069f57dd081e5ebdd46add/readme.md#L452-L502
- `<Static>` for completed/log output while keeping live output below: https://github.com/vadimdemedes/ink/blob/25766aec618bd62030069f57dd081e5ebdd46add/readme.md#L1472-L1542
- `<Static>` root keys: https://github.com/vadimdemedes/ink/blob/25766aec618bd62030069f57dd081e5ebdd46add/readme.md#L1564-L1587
- render options `onRender`, `debug`, `maxFps`, `incrementalRendering`, `concurrent`: https://github.com/vadimdemedes/ink/blob/25766aec618bd62030069f57dd081e5ebdd46add/readme.md#L2640-L2697
- `waitUntilRenderFlush`: https://github.com/vadimdemedes/ink/blob/25766aec618bd62030069f57dd081e5ebdd46add/readme.md#L2895-L2908
- Ink testing with ink-testing-library: https://github.com/vadimdemedes/ink/blob/25766aec618bd62030069f57dd081e5ebdd46add/readme.md#L2964-L2980
