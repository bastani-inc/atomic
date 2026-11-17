# Startup benchmark

Measures how long `atomic` takes to become usable, in every startup mode, on Linux and Windows, for both shipped
forms: the npm package running under Node (how `npm install -g` runs it) and the compiled binary from the release
archive. `../windows-startup` is the stricter Windows-only harness for the settled startup paint; this one reuses its
loopback provider, screen model and agent fixtures.

## Metrics

Every time is measured from just before the process is launched, with `process.hrtime.bigint()`.

| Mode | Metric | Until |
| --- | --- | --- |
| `interactive` | `firstFrameMs` | the first terminal frame with the editor on screen and the cursor in it |
| `interactive` | `inputEchoMs` | a word typed at that frame is visible in the editor |
| `interactive` | `identityMs` | the startup identity (`Atomic v<version>`) is on screen |
| `interactive` | `firstPromptDispatchMs` | from pressing Enter on that word to the first request byte at the provider |
| `typeahead` | `typeaheadDispatchMs` | a prompt typed and submitted before Atomic drew anything reaches the provider |
| `version` | `versionMs` | `atomic --version` exits |
| `print` | `printDispatchMs`, `printExitMs` | `atomic -p <prompt>` sends its request; then exits |
| `rpc` | `rpcReadyMs`, `rpcDispatchMs` | `atomic --mode rpc` answers a `get_state` written at launch; a `prompt` written with it reaches the provider |

Interactive modes run in a real pseudo-terminal (`@bastani/atomic-natives`' PTY: ConPTY on Windows), 120 by 40, and
answer terminal queries as xterm.js does. Every request must carry the typed prompt and the tools of Atomic and of
each bundled extension, so a start that dispatched before its extensions loaded fails; the summary also fails a run
whose samples of one mode sent different tool sets.

## Profiles

- `warm`: one agent directory, Node compile cache and Bun transpiler cache per target, filled by an untimed start of
  each mode before the timed ones.
- `cold`: a fresh agent directory and empty caches for every sample. With `--drop-caches` on Linux, the OS page cache
  is dropped first when `sudo -n` is allowed (`pageCacheDropped` in each sample says whether it was). Windows has no
  equivalent, so a Windows cold start still finds Atomic's files in the OS cache.

Every sample gets a fresh session directory, an empty `HOME`, and `ATOMIC_OFFLINE=1` with telemetry and the version
check off, so nothing outside the run's own directories, and nothing on the network, is measured.

## Run

Build the checkout (`npm run build`), then lay out the two shipped forms and measure them:

```sh
bun run scripts/perf/startup/prepare.ts --npm "$WORK/npm" --binary "$WORK/binary"
bun run scripts/perf/startup/benchmark.ts --output "$WORK/out" \
  --target npm="$WORK/npm/node_modules/.bin" --target binary="$WORK/binary" \
  --repeats 15 --drop-caches
```

To compare two commits, prepare each from its own built checkout (`--repo`) and pass both as targets
(`--target base-npm=... --target head-npm=...`); targets alternate order every round. `--modes` and `--profiles` take
comma-separated subsets. The run writes `samples.jsonl` (one record per start, failures included), `summary.json`
and `summary.md` (median, nearest-rank p95 and minimum per target, profile, mode and metric), and exits nonzero if any
start failed.
