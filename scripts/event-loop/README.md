# Event-loop check

`npm run check` fails when a call that blocks the thread is reachable from the interactive host's entry points.
Nothing else runs on the event loop while such a call waits: not keystrokes, not rendering, not streaming. The
check is static, so it holds for every path, not only the ones a test happens to drive.

```sh
npm run check:event-loop                                     # findings; exit 1 when there are any
node scripts/event-loop/check-event-loop.ts --paths          # with the call path from an entry point
node scripts/event-loop/check-event-loop.ts --explain 'packages/tui/src/tui.ts#TuiBase.doRender'
node scripts/event-loop/check-event-loop.ts --json
node scripts/event-loop/check-event-loop.ts --deferred       # also list findings owned by other open changes
```

It runs under Node (the TypeScript 7 API it uses cannot run under Bun) and takes about 15 seconds.

## What counts as blocking

`blocking-apis.ts` lists them: `fs` `*Sync` functions, `child_process` `execSync`/`execFileSync`/`spawnSync`,
`Bun.spawnSync`/`Bun.sleepSync`, synchronous `crypto` and `zlib`, `node:sqlite` and `bun:sqlite` statements,
`Atomics.wait`, the `@bastani/atomic-natives` functions that wait on the file system, a lock or another process, any
library function named `*Sync`/`sync`, and loops that only poll a clock (busy-waits).

## What counts as reachable

`call-graph.ts` builds a call graph of the shipped sources with the type checker: resolved calls, `new`, accessors,
callbacks passed or stored as values, interface and base-class dispatch (to every implementing class and every object
literal checked against the interface), functions passed through parameters and stored in properties, and dynamic
`import()` of modules not already loaded at startup.

`check-event-loop.ts` then walks it in two steps (`policy.ts` holds the lists):

1. From the process entries (`PROCESS_ENTRIES`: the CLI and the bundled extensions), everything the process can run.
2. From the interactive entry points: every callback that code registers with an event source (`SINKS`: Node event
   emitters, timers, `fs.watch`, and Atomic's own `on`/`subscribe`/`register*` APIs and `onX` handler properties) and
   every component's `render`/`handleInput`/`handleMouse`/`invalidate` (`INTERFACE_ROOTS`). Whatever this walk reaches
   can run while the user is interacting, and a blocking call there is a finding.

Callbacks registered with `process.on("exit")` are not entry points: they run as the process exits. Listener
removals (`off`, `removeListener`) never call what they are given.

## Regular expressions

The same walk checks every regular expression literal and `new RegExp("…")` in the reachable functions with
`regex-safety.ts`: a pattern whose repetitions can match the same text in more than one way (nested or adjacent
quantifiers over overlapping characters, quantified overlapping alternatives) can backtrack exponentially or
polynomially on a crafted input and freezes the loop as surely as a synchronous read. A finding fails the check.
`node scripts/event-loop/regex-safety.ts [paths…]` scans files on their own.

Not flagged: a leading repetition that an unanchored search retries at each start (`/\s+$/` on a long run of
spaces followed by another character). Its cost is quadratic only in that run, and flagging it would bury the
ambiguous patterns among the many trims that are fine on real input. Patterns built at runtime from data are not
checked statically.

## Fixing a finding

Make the call non-blocking: its `node:fs/promises` or async `child_process` form, an async lock with `await`ed
retries, an async factory that loads state before it is needed and serves it from memory, or an ordered write queue.
A synchronous path that a renderer or key handler needs must read from memory.

Only when a function genuinely runs before the first frame, or only in a non-interactive command, add it to
`STARTUP_ONLY` or `OTHER_MODES` in `policy.ts` with the reason it cannot run later. `EXIT_ONLY` is for writes that
must land as the process exits or fails, `DURABLE_RECORDS` for a small write whose landing before the next step is
a crash-consistency contract, and `SYNCHRONOUS_LOADER_HOOKS` for the extension loader's hooks that a synchronous
module loader calls. The walk does not enter those functions. An entry that no longer names a function,
or one that is no longer reached, fails the check, so the lists cannot go stale. `REVIEWED_REGEXES` accepts a
backtracking pattern whose input is always short, with the reason.

`OWNED_ELSEWHERE` lists areas another open change is making non-blocking; their findings are printed with
`--deferred` and do not fail the check. Remove an entry once its change has landed.

## Known limits

The graph cannot see calls through `any`, through functions kept in collections, or through a callback that only
reaches its caller through a structural type nobody declares. It treats an interface call as able to reach every
implementation, and a parameter as able to hold every function any caller passes, so it can report a path that no
real input takes. When that happens, show the path with `--explain` and fix the analysis or the policy, not the code.
