---
source_urls:
  - https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick
  - https://nodejs.org/api/timers.html
  - https://developer.mozilla.org/en-US/docs/Web/API/HTML_DOM_API/Microtask_guide
  - https://bun.sh/reference/globals/setImmediate
  - https://bun.sh/reference/globals/queueMicrotask
  - https://bun.sh/reference/node/timers/promises/setImmediate
  - https://bun.sh/reference/bun/spawn
  - https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session
  - https://github.com/anomalyco/opentui
fetched_at: 2026-07-08
topic: Bun/TypeScript terminal UI first keyboard input responsiveness
---

Research cache for terminal/TUI first input responsiveness. Key findings: prefer render flush/idleness barriers, then macrotask yield (setImmediate/promisified setImmediate) before nonessential probes; avoid queueMicrotask/process.nextTick for yielding to input; make fs/git/network probes async/cancellable/budgeted; measure first byte/key/submit with performance.now; regression test through mock input/headless renderer and real PTY/ConPTY paths.
