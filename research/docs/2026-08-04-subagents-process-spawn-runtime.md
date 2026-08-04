## Analysis: `packages/subagents` process-spawn runtime (for issue #2188)

> Note on artifacts: my role constraints are read-only (no file writes), and the follow-up asks for the markdown as the final response, so the complete document is inline below rather than written to `research/docs/`. Every claim below is backed by a file:line I read in this session.

### Overview

Every bundled subagent child today is an **OS process running the Atomic CLI itself** in `--mode json -p` (headless JSON-stream print mode). There are two distinct process layers:

1. **Foreground path** — the parent extension process spawns one child CLI per model attempt directly and supervises it in-process (`packages/subagents/src/runs/foreground/execution-attempt.ts:159`).
2. **Background/async path** — the parent spawns a *detached* Node process running `subagent-runner.ts` via `jiti` (`packages/subagents/src/runs/background/async-execution-common.ts:101-110`); that runner process then spawns one child CLI per step/attempt (`packages/subagents/src/runs/background/subagent-runner-streaming.ts:70`). So async work is **two** process hops from the parent.

Both layers converge on the same three helpers: `buildPiArgs` (argv + env), `buildSubagentSpawnEnv` (env layering + scrub), `getPiSpawnCommand` (which executable), plus `validatePiSpawnCwd`.

---

### Entry Points

- `packages/subagents/src/runs/foreground/subagent-executor.ts:210` — `createSubagentExecutor(...)`, the tool surface. `execute` dispatches management actions, depth check, then async/chain/parallel/single paths (`:233-265`).
- `packages/subagents/src/runs/foreground/subagent-executor.ts:290-305` — `executeWithSingleDispatchGuard`: one non-action subagent call per turn; a second concurrent call is rejected (`:197-208`, text "Rejected: a subagent call is already in progress.").
- `packages/subagents/src/runs/foreground/subagent-executor-async.ts:77` — `runAsyncPath`, returns `null` when not async so foreground paths continue.
- `packages/subagents/src/runs/foreground/execution-run-sync.ts:27` — `runSync`, the foreground model-candidate loop.
- `packages/subagents/src/runs/foreground/execution-attempt.ts:42` — `runSingleAttempt`, one child process per model attempt.
- `packages/subagents/src/runs/background/async-execution-single.ts:49` / `async-execution-chain.ts:65` — build the runner config and call `spawnRunner`.
- `packages/subagents/src/runs/background/subagent-runner.ts:13` — `runSubagent`, the detached runner entry (config file argv[2] or stdin, `:61-90`).
- `packages/subagents/src/runs/background/subagent-runner-step.ts:31` — `runSingleStep`, per-step candidate loop in the runner.
- `packages/subagents/src/runs/background/subagent-runner-streaming.ts:25` — `runPiStreaming`, the actual child spawn inside the runner.
- `packages/subagents/src/runs/background/result-watcher.ts:57` — `createResultWatcher`, the parent-side delivery loop.

---

### Core Implementation

#### 1. What CLI is spawned, and how it is resolved

`getPiSpawnCommand(args, deps)` (`pi-spawn.ts:155-165`) returns either:
- `{ command: process.execPath, args: [cliPath, ...args] }` when a runnable CLI script is resolvable, or
- `{ command: APP_NAME, args }` — bare `atomic` on `PATH` — as fallback (`:164`).

`resolvePiCliScript` (`pi-spawn.ts:102-149`) tries, in order:
1. `process.argv[1]` (or injected `deps.argv1`), normalized to absolute (`:110-115`).
2. The `bin` field of the resolved `@bastani/atomic` `package.json`, preferring `bin[APP_NAME]`, then `bin.pi`, then the first value (`:133-142`).

`isRunnableCliScript` (`:86-95`) accepts `.mjs/.cjs/.js` always, and `.ts` **only when `process.execPath` basename is `bun`/`bun.exe`** (`isGenericBunRuntime`, `:80-84`). Package-root discovery walks parent directories looking for a `package.json` whose `name === PACKAGE_NAME` (`findPiPackageRootFromEntry`, `:9-20`); `resolvePiPackageRoot()` does this from `fs.realpathSync(process.argv[1])` and swallows errors (`:26-34`).

`validatePiSpawnCwd(cwd)` (`pi-spawn.ts:50-64`) stats the cwd before spawning and produces distinct messages: `cwd does not exist:` (ENOENT), `cwd path contains a non-directory component:` (ENOTDIR), `cwd is not a directory:`, `cwd is not accessible:`. `formatPiSpawnError` (`:66-73`) prefixes all spawn failures with `failed to spawn subagent runtime '<command>' from cwd '<cwd>':` and special-cases ENOENT with "runtime executable was not found or could not be launched".

#### 2. Args (`buildPiArgs`, `pi-args.ts:127-328`)

Base args are always `["--mode", "json", "-p"]` (`execution-attempt.ts:67`, `subagent-runner-step.ts:126`). On top:

- Session: `--session <file>` when `sessionFile` is set (parent dir created, `:130-133`); otherwise `--no-session` when sessions are disabled and/or `--session-dir <dir>` (`:134-141`).
- `--model <model>` with `applyThinkingSuffix` appending `:level` unless a known level suffix is already present (`:106-111`, `:143-146`).
- `--tools <csv>` only when a builtin allowlist exists; path-like entries (`/`, `.ts`, `.js`) become `--extension` instead (`:148-181`). MCP direct tools are appended to the builtin allowlist via `resolveMcpDirectToolNames` (`:172-178`).
- Extensions: the prompt runtime extension is always injected first, plus `fanout-child.ts` when the tools list includes `subagent` (`fanoutAuthorized`, `:150`, `:185-197`). An explicit `extensions` field emits `--no-extensions` first, switching the child to allowlist mode (`:189`).
- `--no-skills` when `inheritSkills` is false (`:199-201`).
- System prompt is written to a `0600` file in a `mkdtemp` dir and passed as `--system-prompt` or `--append-system-prompt` (`:203-210`).
- Task: inline `Task: <task>` argv, or, above `TASK_ARG_LIMIT = 8000` chars (`:21`), written to `task.md` and passed as `@<path>` (`:212-221`).
- The temp dir is removed by `cleanupTempDir` after the child settles (`:332-339`; called at `execution-attempt.ts:462`/`:504`, `subagent-runner-step.ts:169`).

#### 3. Env bridging (`buildPiArgs` env map + `buildSubagentSpawnEnv`)

`buildPiArgs` returns an env patch (`pi-args.ts:223-325`) with `ATOMIC_`-prefixed keys (`ENV_PREFIX = APP_NAME.toUpperCase()`, `:27`):

| Key | Behavior |
|---|---|
| `..._SUBAGENT_CHILD` | always `"1"` (`:224`) |
| `..._SUBAGENT_FANOUT_CHILD` | `"1"`/`"0"` by `fanoutAuthorized` (`:225`) |
| `WORKFLOW_SESSION_METADATA_ENV` | JSON stage metadata when present (`:226-228`) |
| `ENV_CODEX_FAST_MODE` | `chat=<0/1>;workflow=<0/1>`, chat mapped from the caller's scope (`:113-125`, `:229-233`) |
| `..._SUBAGENT_PARENT_{EVENT_SINK,CONTROL_INBOX,ROOT_RUN_ID,RUN_ID,CHILD_INDEX,DEPTH,PATH,CAPABILITY_TOKEN}` | set to real values **only** when `fanoutAuthorized`, otherwise explicitly `""` (`:273-286`) |
| `..._SUBAGENT_INHERIT_{PROJECT_CONTEXT,SKILLS}` | `"1"`/`"0"` (`:287-288`) |
| `..._SUBAGENT_INTERCOM_SESSION_NAME`, `..._SUBAGENT_ORCHESTRATOR_TARGET` | set when present (`:289-294`) |
| `..._SUBAGENT_SUPERVISOR_CAPABILITY` / `..._SUPERVISOR_SESSION_ID` | **always overwritten**, `""` when absent, so a child never forwards its own grant (`:295-298`) |
| `ATOMIC_INTERCOM_GROUP` | cleared to `""` when the child has no intercom access; set to the resolved group otherwise (`:299-306`) |
| `..._SUBAGENT_RUN_ID`, `_CHILD_AGENT`, `_CHILD_INDEX` | run identity (`:307-315`) |
| `MCP_DIRECT_TOOLS` | csv, or the sentinel `"__none__"` (`:316-321`) |
| `STRUCTURED_OUTPUT_CAPTURE_ENV` / `_SCHEMA_ENV` | output/schema paths (`:322-325`) |

Nested-path depth is clamped: `parentDepth = min(max(1, unclamped), SUBAGENT_PARENT_MAX_DEPTH)` where the max is `MAX_SUBAGENT_NESTING_DEPTH = 5` (`pi-args.ts:255-258`, `types-runtime.ts:90`). `inheritedNestedRoute` requires event sink + root run id + capability token together (`:242`).

`buildSubagentSpawnEnv(...layers)` (`spawn-env.ts:13-21`) merges layers left-to-right with `Object.assign` and then runs `scrubInteractiveEngineEnv(merged)` **last**, so no layer can reintroduce interactive-engine control variables. Callers pass `(process.env, envPatch, getSubagentDepthEnv(...))` (`execution-attempt.ts:135-141`, `subagent-runner-streaming.ts:61-65`).

`getSubagentDepthEnv` (`types-depth.ts:141-156`) increments `ATOMIC_SUBAGENT_DEPTH`, writes `ATOMIC_SUBAGENT_MAX_DEPTH`, and propagates `WORKFLOW_STAGE_SUBAGENT_GUARD_ENV=1` when either the caller or the inherited env says so. `checkSubagentDepth` (`:134-139`) blocks when `depth >= maxDepth`.

#### 4. Foreground spawn and supervision (`execution-attempt.ts`)

```
spawn(spawnSpec.command, spawnSpec.args, {
  cwd: runCwd, env: spawnEnv, stdio: ["ignore","pipe","pipe"], windowsHide: true })
```
(`:159-164`). cwd is `options.cwd ?? runtimeCwd` (`:51`), validated first (`:142-156`) — a bad cwd short-circuits to `finalizeSingleAttempt` with exitCode 1 without spawning.

stdout is line-split and each line is JSON-parsed into events (`processLine`, `:271-405`); it is simultaneously mirrored to the artifact `.jsonl` via `createJsonlWriter` (`:165`, `jsonl-writer.ts:27-83`, capped at 50 MB and applying backpressure via `source.pause()/resume()`).

Event handling: `tool_execution_start` bumps `progress.toolCount`, records tool/args/path (`:286-305`); `tool_execution_end` clears them and pushes into `recentTools` (`:307-320`); `message_end` accumulates usage/turns/tokens and detects failure stop reasons (`:322-359`); `tool_result_end` feeds the mutating-failure guard (`:361-404`).

Termination machinery in one attempt:
- **Final drain**: on a clean terminal assistant stop, wait `FINAL_STOP_GRACE_MS = 1000`, then SIGTERM, then `HARD_KILL_MS = 3000` later SIGKILL (`:190-226`).
- **Watchdog**: SIGTERM then SIGKILL after grace (below).
- **Abort signal**: SIGTERM, SIGKILL after 3000 ms (`:509-522`).
- **Interrupt signal**: SIGINT, SIGTERM after 1000 ms; sets `result.interrupted` (`:524-545`).
- **Post-exit stdio guard**: `attachPostExitStdioGuard(proc, { idleMs: 2000, hardMs: 8000 })` destroys unended stdio after exit (`:420`, `post-exit-stdio-guard.ts:26-86`).

Exit-code computation on `close` (`:452-497`): `forcedDrainAfterFinalSuccess → 0`; otherwise if forced-termination or a signal was seen, `code ?? 1`; else `code ?? 0`.

#### 5. Background spawn (`async-execution-common.ts` + `subagent-runner*.ts`)

`spawnRunner(cfg, suffix, cwd, env)` (`async-execution-common.ts:88-127`):
1. `validatePiSpawnCwd(cwd)` (`:89-90`).
2. Requires a resolved `jiti` CLI (`:92-96`), located by four probes: `require.resolve("jiti/package.json")`, resolution from the pi package root, resolution from `realpath(process.argv[1])`, then `<piRoot>/node_modules/jiti/package.json` (`:31-56`). `isAsyncAvailable()` is just `jitiCliPath !== undefined` (`:74-76`) and gates the async tool path (`subagent-executor-async.ts:123-134`).
3. Writes the whole run config as JSON to `TEMP_ROOT_DIR/async-cfg-<id>.json` with mode `0600` (`:81-86`, `types-runtime.ts:125-127`).
4. Spawns `process.execPath [jitiCliPath, subagent-runner.ts, cfgPath]` **detached, `stdio: "ignore"`, `windowsHide: true`** and `proc.unref()` (`:101-126`). A missing pid is reported as a spawn error (`:118-124`).

The runner deletes its config file at startup (`subagent-runner.ts:64-70`), registers `SIGUSR2` (`SIGBREAK` on win32) as the interrupt signal (`:11`, `:17`), appends `subagent.run.started` with its own `pid` (`:18-28`), iterates steps (dynamic/parallel/sequential, `:31-43`) and calls `finalizeRun` (`:44`).

Each step spawn (`subagent-runner-streaming.ts:70-75`) uses the same `stdio: ["ignore","pipe","pipe"]` shape. Its stdout drives a `createChildEventJournal` writing `events.jsonl` (`:76-80`), a per-step `output-<i>.log` write stream whose `error` handler degrades instead of crashing (`:50-60`), and `onChildEvent` callbacks that update `status.json`.

---

### Data Flow

Parent tool call → `prepareExecutionContext` → (async? `spawnRunner` detached runner : direct `spawn` per attempt) → child CLI JSON stdout → parsed events → progress/status/artifacts → result file → result watcher → parent event bus.

**Foreground:** `runSync` builds candidates → per candidate `runSingleAttemptWithStructuredOutputRetries` → `runSingleAttempt` spawns, streams, finalizes → `finalizeSingleAttempt` computes exit code/output/structured output (`execution-attempt-finalize.ts:8-107`) → `persistArtifacts` writes `_output.md` + `_meta.json` (`execution-run-sync.ts:123-148`) → `runSinglePath` records history and returns tool result (`subagent-executor-single.ts:241-316`).

**Background:** `executeAsyncSingle/Chain` → `spawnRunner` → runner writes `status.json`/`events.jsonl` continuously (`subagent-runner-state.ts:81-133`, `:476-480`) → `finalizeRun` writes `subagent-log-<id>.md` and the atomic result JSON (`subagent-runner-finalize.ts:84-146`) → parent `result-watcher` claims and delivers.

Material transformations worth naming:
- Task text: `"Do X"` → `Task: Do X` argv, or `@/tmp/atomic-subagent-XXXX/task.md` past 8000 chars (`pi-args.ts:212-221`).
- Model: `openai/gpt-5.5` + `thinking: xhigh` → `openai/gpt-5.5:xhigh` (`pi-args.ts:106-111`).
- Detached foreground result: `exitCode` forced to `-2` with `finalOutput = "Detached for intercom coordination; awaiting the child's eventual result."` (`execution-attempt-finalize.ts:35-39`, set by `finish(-2, true)` at `execution-attempt.ts:188`).
- Fail-fast skip: `exitCode: -1`, `error: "Skipped due to fail-fast"` (background `subagent-runner-parallel.ts:109-130`; foreground `chain-execution-parallel-runner.ts:62-71`).

---

### Attempt watchdog (`runs/shared/attempt-watchdog.ts`)

Defaults (`:4-6`): `DEFAULT_IDLE_MS = 5 * 60_000` (**5 min**), `DEFAULT_WALL_MS = 60 * 60_000` (60 min), `DEFAULT_KILL_GRACE_MS = 3_000`.

`resolveAttemptTimeoutConfig()` (`:35-45`):
- `idleMs` ← `ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS`, else 300000. `envMs` (`:22-28`) ignores non-finite values (default applies) and clamps `<= 0` to `0`, which means **disabled** (`:101`).
- `wallMs` ← `ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS`, else 3600000; `0` disables (`:115`).
- `killGraceMs` ← `ATOMIC_SUBAGENT_ATTEMPT_KILL_GRACE_MS` but **only positive values**; escalation cannot be disabled (`:30-33`, `:40-43`).

**What counts as activity** — only two things call `attemptWatchdog.activity()`:
1. a `stdout` `data` chunk, and
2. a `stderr` `data` chunk.

Foreground: `execution-attempt.ts:437-447`. Background: `subagent-runner-streaming.ts:213-225`. `activity()` merely re-arms the idle timer, and only if not tripped/settled (`attempt-watchdog.ts:121-123`).

Plus one deferral hook, `isToolActive()`, checked *at the moment the idle timer fires*: if a tool is in flight, the idle window is re-armed instead of tripping (`:102-108`).
- Foreground defines it as `progress.currentTool !== undefined` (`execution-attempt.ts:430`).
- Background defines it as `activeToolExecutions > 0`, incremented on `tool_execution_start` and decremented on `tool_execution_end` (`subagent-runner-streaming.ts:132-133`, `:207`).
- Both files carry the same caveat comment: a tool that ends abnormally without its end event defers idle **indefinitely**, leaving the wall cap as the only backstop (`execution-attempt.ts:424-429`, `subagent-runner-streaming.ts:202-206`).

**What is NOT counted as activity:** there is no heartbeat, no timer-based keepalive, no model-stream/"thinking" signal that the watchdog observes independently of bytes on stdout/stderr. Model streaming only counts to the extent the child *writes JSON event bytes* — a long model turn (extended thinking, a slow provider response) that emits nothing for `idleMs` and is not inside a `tool_execution_start` window trips the watchdog. Note also:
- The separate control/activity timers (`setInterval(..., 1000)` at `execution-attempt.ts:407-417` and `subagent-runner-state.ts:541-548`) update `progress.lastActivityAt`/`status.json` and emit `needs_attention`, but they never call `attemptWatchdog.activity()`.
- `progress.lastActivityAt` is updated on every parsed stdout line (`execution-attempt.ts:281-284`), which is again byte-driven.
- The background runner additionally derives step activity from `output-<i>.log` mtime (`subagent-runner-state.ts:257-265`, `:490`) — again for status only, not for the watchdog.

**Kill path** (`trip`, `attempt-watchdog.ts:88-98`): guard on `tripped || isSettled()` → set `tripped` → clear idle timer → `onTimeout(message)` → `trySignalChild(child, "SIGTERM")` → `setTimeout(killGraceMs)` → `trySignalChild(child, "SIGKILL")` if still unsettled. `trySignalChild` swallows throws and returns false (`post-exit-stdio-guard.ts:18-24`). All timers are `unref()`-ed (`:97`, `:111`, `:117`).

Messages: `Subagent model attempt timed out after ${idleMs}ms without child activity.` (`:47-49`) and `Subagent model attempt timed out after ${wallMs}ms.` (`:51-53`).

`onTimeout` sets `forcedTerminationSignal = true` and records the message as the attempt error (foreground also sets `progress.error`): `execution-attempt.ts:431-435`, `subagent-runner-streaming.ts:208-211`. Because `forcedTerminationSignal` is set, the close handler maps the exit to `code ?? 1` (`execution-attempt.ts:472-476`; `subagent-runner-streaming.ts:283-288`) — and since the CLI's own SIGTERM handler exits **143** (`packages/coding-agent/src/modes/print-mode.ts:117-133`; RPC mode mirrors it at `rpc-mode.ts:143-157`, both using `signal === "SIGHUP" ? 129 : 143`), a watchdog-killed attempt that honors SIGTERM surfaces as exit 143 with the timeout message. The CLI signal handler also calls `killTrackedDetachedChildren()` before exiting (`print-mode.ts:125`).

The timeout error is a *retryable* signal: `/timed? out/i` and `/timeout/i` are in `RETRYABLE_MODEL_FAILURE_PATTERNS` (`model-fallback.ts:99-100`), so the killed attempt advances to the next fallback candidate rather than failing the run.

---

### Result plumbing

**Artifact paths** (`shared/artifacts.ts:21-31`): base `${runId}_${safeAgent}${index !== undefined ? "_"+index : ""}` where `safeAgent = agent.replace(/[^\w.-]/g, "_")`, producing `_input.md`, `_output.md`, `.jsonl`, `_meta.json`. Directory is `<sessionDir>/subagent-artifacts` when a session file exists, else `TEMP_ARTIFACTS_DIR` (`:13-19`, `types-runtime.ts:80`).

- Foreground writes `_input.md` up front (`execution-run-sync.ts:118-120`), routes child stdout into the `.jsonl` (`:121` + `execution-attempt.ts:165`), then `_output.md` and `_meta.json` in `persistArtifacts` (`:126-147`). Metadata fields: `runId, agent, task, exitCode, usage, model, fastMode, attemptedModels, modelAttempts, durationMs, toolCount, error, skills, skillsWarning, timestamp`. Artifacts are **skipped for detached results** (`:259`) but written via the detached-exit callback later (`:159-174`).
- Background writes the same four via `subagent-runner-step.ts:65-73` and `:284-310`; its `_meta.json` set is `runId, agent, task, exitCode, model, fastMode, attemptedModels, modelAttempts, skills, timestamp` (`:292-303`).

**run-history.jsonl** (`runs/shared/run-history.ts`): path is `getAgentConfigPaths("run-history.jsonl")[0]` falling back to `~/.atomic/agent/run-history.jsonl` (`:15-17`). `recordRun` appends `{agent, task: task.slice(0,200), ts: seconds, status: exit===0?"ok":"error", duration, exit?}` and never throws (`:21-36`). It is called **only from foreground paths**: single (`subagent-executor-single.ts:241`), parallel (`subagent-executor-parallel.ts:236-238`), chain sequential (`chain-execution-sequential-step.ts:202`), chain parallel (`chain-execution-parallel-runner.ts:214`). Reads rotate at 1200 lines down to the last 1000 (`:18-19`, `:49-54`).

**Run directory files** (background): `status.json`, `events.jsonl`, `subagent-log-<id>.md`, `output-<i>.log` under `asyncDir` (`subagent-runner-state.ts:81-83`, `:132`). `asyncDir` is `ASYNC_DIR/<id>` or `NESTED_RUNS_DIR/<rootRunId>/<id>` for nested runs (`async-execution-single.ts:91-93`). Result path is `RESULTS_DIR/<id>.json` or the nested equivalent (`:182-184`).

**Terminal result JSON** (`subagent-runner-finalize.ts:104-146`): `id, agent (`chain:a->b` / `parallel:a+b` naming at `:26-31`), mode, success, state (`paused` when interrupted), summary, results[], outputs, workflowGraph, exitCode, timestamp, durationMs, truncated, artifactsDir, cwd, asyncDir, sessionId, sessionFile, intercomTarget, share fields`, written with `writeAtomicJson` (`:104`).

**Result watcher / claims** (`runs/background/`):
- `createResultWatcher` (`result-watcher.ts:57`) uses `fs.watch` with a 50 ms coalescer (`:166-173`, `:263`), a 50 ms directory rescan (`:187-195`), restart at 3000 ms (`:11`, `:213-233`), and a 3000 ms **polling fallback** for `EMFILE`/`ENOSPC`/unsafe-watch-path errors (`:52-55`, `:197-211`). Epoch counters invalidate stale work on stop/restart (`:84`, `:292-318`).
- Ownership: a result is owned only if its `sessionId` matches the current session, or (absent sessionId) its `cwd` matches `state.baseCwd` (`:91-94`).
- `processResultEntry` (`result-delivery-processor.ts:186-300`): requires terminal status first — `modernResultHasTerminalStatus` re-reads `<asyncDir>/status.json` under a canonical-root containment check, symlink refusal, `O_NOFOLLOW`, and a 1 MiB cap (`result-status.ts:41-87`), returning `status-pending` for retry (`:209-215`) with capped backoff 250 ms→30 s (`result-watcher.ts:14-15`).
- Claiming: `claimPublicResult` creates `.claims/<uuid>/` and **renames** the public result into `result.json` beside a `claim.json` (`result-file-claims.ts:93-130`); claim state is `active|delivered|undelivered` (`:18`), updated atomically via temp-file rename (`:140-150`).
- Delivery has two phases tracked independently — intercom then local — with progress-preserving retries and an exhaustion cap (`completion-claims.ts:96-196`, default `MAX_NO_PROGRESS_FAILURES = 8` at `:50`). Signature mismatch or dedupe conflict quarantines the payload into `.undelivered/` under a content-hashed collision-resistant name (`result-quarantine.ts:47-77`, `result-delivery-processor.ts:179-184`).

**Stale-run reconciliation** (`stale-run-reconciler.ts`): `checkPidLiveness(pid)` uses `kill(pid, 0)` mapping `ESRCH→dead`, `EPERM→unknown` (`:389-402`). `reconcileAsyncRun` (`:404-457`) repairs a running status from an existing result file, otherwise, for a dead pid, writes a failed repair whose message is `Async runner process <pid> exited or disappeared before writing a result...` (`:255-257`); a live-but-24h-stale pid produces the "PID ownership cannot be verified" variant (`:450-454`). Repairs are staged then published atomically (`:315-343`, `:107-120`).

---

### Parent-facing tool surface and process-dependent semantics

- **Async job launch**: `executeAsyncSingle/Chain` emit `SUBAGENT_ASYNC_STARTED_EVENT` carrying the **runner pid** (`async-execution-single.ts:262-273`, `async-execution-chain.ts:501-526`), and the launch text is `formatAsyncStartedMessage` ("Launched: …", "detached", "Do not run sleep timers or polling loops") (`async-execution-common.ts:60-69`).
- **Job tracker**: `createAsyncJobTracker` polls every `POLL_INTERVAL_MS = 250` (`types-runtime.ts:88`, `async-job-tracker.ts:245-390`), reconciles each run using the tracked pid (`:287-302`), tails `events.jsonl` by byte cursor to re-emit control events (`:177-243`), and schedules widget cleanup 10 s after terminal state (`:141`, `:165-176`).
- **Interrupt**:
  - async: `process.kill(status.pid, SIGUSR2|SIGBREAK)` — requires `status.state === "running"` and a numeric pid (`subagent-executor-resume.ts:47`, `:236-271`). The runner converts that into `interruptRunner` → status `paused`, steps `paused`, `subagent.run.paused` event, and forwards to the active child interrupt (`subagent-runner-state.ts:550-570`), which sends SIGINT then SIGTERM to the child CLI (`subagent-runner-streaming.ts:226-234`).
  - foreground: an in-process `AbortController` per child (`subagent-executor-single.ts:145-159`) whose `interrupt` sends SIGINT/SIGTERM (`execution-attempt.ts:524-545`).
  - nested: a file-based control request with a 1 s wait, falling back to a direct `process.kill` of the nested runner (`subagent-executor-resume.ts:352-434`).
- **Status**: foreground status is served from in-memory `foregroundControls`/`foregroundRuns` (`subagent-executor.ts:85-118`, `subagent-executor-status.ts:70-113`); async status is read from `status.json` + reconciliation and prints Dir/Output/Log/Events paths and per-step intercom targets (`run-status.ts:217-311`).
- **Resume**: live async children are reached by intercom message delivery (`subagent-executor-resume.ts:508-546`); terminal ones are *revived* as a brand-new async run seeded with the old `sessionFile` (`:592-648`). Session files must be `.jsonl`, exist, and for nested runs be a non-symlink regular file under a trusted root that contains the run id (`:287-310`).
- **Parallel fan-out and fail-fast**: concurrency defaults to `MAX_CONCURRENCY = 4` (`types-runtime.ts:75`, `parallel-utils.ts:146`), max tasks 50 (`types-runtime.ts:74`, `:116-119`), executed by `mapConcurrent` (`parallel-utils.ts:87-105`). Fail-fast marks later tasks `exitCode: -1`, and group success treats `-1` as non-fatal for the "did anything fail" check (`subagent-runner-parallel.ts:220`, `:302`, `:305`).
- **Exit `-2` / detach packs**: intercom detach settles foreground supervision while the process keeps running (`execution-attempt.ts:175-189`), the recovered result is delivered later through `onDetachedExit` (`:477-494`), sibling parallel tasks are skipped with `exitCode: -1, error: "Skipped after foreground group detached for intercom coordination"` (`subagent-executor-parallel-task.ts:66-75`, `chain-execution-parallel-runner.ts:52-61`), and worktree cleanup is deferred until detached children recover (`subagent-executor-parallel.ts:146-150`, `:267-269`).
- **Worktree isolation**: `createWorktrees` requires a git repo and a clean tree (`worktree.ts:110-121`, `:164-172`), creates `<mainRoot>/.atomic/worktrees/<runId>-<i>` on branch `worktree-<runId>-<i>` (`:150-158`), gitignores the root (`:159-163`), and can run a setup hook as its own `spawnSync` child with JSON stdin/stdout, a 30 s default timeout, and EPIPE tolerance (`:73`, `:263-304`). Task-level `cwd` overrides conflict with worktree mode and are rejected (`:130-146`).
- **Foreground vs background choice**: `runAsyncPath` returns `null` unless `effectiveAsync` (`subagent-executor-async.ts:99`), and hard-fails when jiti is missing (`:123-134`).

---

### Model fallback and long-running guard

**Pre-spawn filtering** (`model-candidate-filter.ts:26-57`): a candidate whose provider is *known* but has no configured auth is skipped before spawning, recorded as `ModelAttempt{ exitCode: null, error: "Skipped <model>: provider '<p>' has no configured API key/auth in the current session." }`. The current model is never filtered (`:38-41`).

**Candidate list** (`model-fallback.ts:43-64`): primary → fallbacks (with positional `fallbackThinkingLevels`) → current model, normalized and de-duplicated.

**Retry classification** (`model-fallback.ts:145-152`, `:555-559`): only `auth_on_candidate_provider`, `rate_limit`, `provider_unavailable`, `network_timeout`, `model_unavailable`, `request_incompatible` are fallbackable; `cancelled` and `task_failure` are not. `isRetryableModelFailure` normalizes structured signals, HTTP status, error codes, then message patterns (`:337-347`, `:376-394`, `:542-554`).

**Foreground loop** (`execution-run-sync.ts:151-230`): `modelsToTry` is the filtered list, or `[undefined]` when nothing was configured, or `[]` when filtering emptied a non-empty list; break on success or on `result.detached`; otherwise consult `modelFailureSignalByResult` (a WeakMap set at `execution-attempt.ts:465-467`) and continue with `formatModelAttemptNote` (`model-fallback.ts:560-565`).

**Background loop** (`subagent-runner-step.ts:84-244`): mirrors it, with the documented `!== undefined` semantics distinguishing "filtered to empty" from "never configured" (`:75-90`), plus structured-output corrective prompts before model fallback (`:216-228`), and the terminal error `"No spawnable subagent model candidates after pre-spawn filtering."` (`:246-255`).

**Long-running guard** (`runs/shared/long-running-guard.ts` + `subagent-control.ts`): defaults `needsAttentionAfterMs = 60_000`, `activeNoticeAfterMs = 240_000`, `failedToolAttemptsBeforeAttention = 3`, notify channels `event|async|intercom` (`subagent-control.ts:14-21`). `deriveActivityState` returns `needs_attention` when `now - lastActivity > needsAttentionAfterMs` (`:75-86`); `nextLongRunningTrigger` returns `time_threshold|turn_threshold|token_threshold` (`long-running-guard.ts:120-130`). Mutating-tool failures are detected by tool name (`edit`/`write`) or bash patterns/unquoted redirection (`:74-113`), tracked in a 5-minute window (`execution-attempt.ts:251`), and escalate to `needs_attention` at the configured threshold (`:383-399`; background `subagent-runner-state.ts:401-447`). These events are **advisory only** — they never kill a child; only the watchdog, abort, interrupt, and final-drain paths signal.

---

### Intercom group propagation

Precedence is implemented in `resolveChildIntercomGroup` (`intercom-group.ts:27-36`): explicit `group` → inherited session/stage group → undefined (child resolves its own default). `true`/`"true"`/`"auto"` are normalized to the auto sentinel (`:8-12`) and resolve to a **single shared UUID per parallel set** minted by `sharedAutoGroupForSet` (`:43-51`); when no shared group exists, a fresh UUID is minted per child (`:33`).

Inheritance is read from `ctx.orchestrationContext.intercomGroup`, explicitly **not** from `process.env` (`:14-18`). Call sites: async single (`async-execution-single.ts:152`), async chain (`async-execution-chain.ts:239-243`), foreground single (`subagent-executor-single.ts:206`), foreground parallel (`subagent-executor-parallel-task.ts:133-137`), chain sequential/parallel (`chain-execution-sequential-step.ts:140-144`, `chain-execution-parallel-runner.ts:148-152`), resume (`subagent-executor-resume.ts:609`).

The resolved value crosses the process boundary as `ATOMIC_INTERCOM_GROUP` — and only when the child has intercom access (`intercomSessionName || orchestratorIntercomTarget`); otherwise the variable is explicitly blanked (`pi-args.ts:299-306`). On the child side `resolveHomeGroup` reads orchestration context → env → config → `"default"` (`packages/intercom/group.ts:30-46`).

Child intercom identity is deterministic: `subagent-<agent>-<runId>[-<index+1>]` (`intercom-bridge.ts:99-102`), and supervisor authorization is requested per child before spawn (`subagent-executor-async.ts:36-75`, `execution-attempt.ts:58-61`), with the capability env always overwritten so it cannot leak to descendants (`pi-args.ts:295-298`).

---

### Configuration

| Setting | Where |
|---|---|
| `ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS` (default 300000; `0` disables) | `attempt-watchdog.ts:38` |
| `ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS` (default 3600000; `0` disables) | `attempt-watchdog.ts:39` |
| `ATOMIC_SUBAGENT_ATTEMPT_KILL_GRACE_MS` (default 3000; positive only) | `attempt-watchdog.ts:43` |
| `ATOMIC_SUBAGENT_DEPTH` / `_MAX_DEPTH`, hard max 5 | `types-depth.ts:15-16`, `types-runtime.ts:90` |
| `ATOMIC_INTERCOM_GROUP` | `pi-args.ts:55`, `packages/intercom/group.ts:18` |
| `TEMP_ROOT_DIR`, `RESULTS_DIR`, `ASYNC_DIR`, `TEMP_ARTIFACTS_DIR` | `types-runtime.ts:76-80` |
| `parallel.maxTasks` (≤50), `parallel.concurrency` (default 4) | `types-runtime.ts:74-75`, `:116-123` |
| control thresholds (`needsAttentionAfterMs`, `activeNoticeAfterMs`, `activeNoticeAfterTurns/Tokens`, `failedToolAttemptsBeforeAttention`, `notifyOn`, `notifyChannels`) | `subagent-control.ts:37-73` |
| `worktreeSetupHook` + `worktreeSetupHookTimeoutMs` (default 30000) | `worktree.ts:73`, `:181-216` |
| `TASK_ARG_LIMIT = 8000`, JSONL cap 50 MB, status read cap 1 MiB | `pi-args.ts:21`, `jsonl-writer.ts:15`, `result-status.ts:8` |

---

### Error handling and edge cases

- Bad cwd is reported as a cwd problem, never as a runtime-binary problem (`pi-spawn.ts:50-64`; used at `execution-attempt.ts:142`, `subagent-runner-streaming.ts:38-48`, `async-execution-common.ts:89`).
- `spawn` throw, `error` event, and "no pid assigned" are all normalized through `formatPiSpawnError` (`async-execution-common.ts:111-124`; `execution-attempt.ts:498-507`; `subagent-runner-streaming.ts:301-326`, which deliberately captures the message before awaiting the journal drain so `close` cannot win the race).
- Transcript/journal write failures degrade with a console error rather than crashing the host (`subagent-runner-streaming.ts:56-60`).
- Hidden child errors are detected post-hoc from messages via `detectSubagentError` and can turn exit 0 into a failure (`execution-attempt-finalize.ts:42-50`, `subagent-runner-step.ts:171-195`).
- Interrupted runs normalize to `exitCode 0`, `interrupted: true`, summary "Interrupted./Paused after interrupt." (`execution-attempt-finalize.ts:20-33`, `subagent-runner-streaming.ts:283-294`, `subagent-runner-finalize.ts:108-110`).
- Runner crash paths `console.error` + `process.exit(1)` (`subagent-runner.ts:55-58`, `:72-75`, `:85-88`).
- Result watcher survives ENOENT, malformed JSON, watcher failure, and stale contexts (`result-watcher.ts:155-163`, `async-job-tracker.ts:55-71`).

### Unverified details

- I did not read `subagent-prompt-runtime.ts` or `extension/fanout-child.ts`, so the child-side consumption of the `ATOMIC_SUBAGENT_*` env contract is inferred from the producer only.
- I did not read `nested-events.ts` in full; nested route/registry behavior is cited only where it appears in the files above.
- I did not verify at runtime that a watchdog-killed child actually exits 143; that is inferred from the CLI's SIGTERM handler (`print-mode.ts:127`) combined with the `forcedTerminationSignal → code ?? 1` mapping.

---

## Contracts an in-process replacement must preserve

**Process/lifecycle**
1. Per-model-attempt isolation: one fresh execution context per candidate, torn down before the next (`execution-run-sync.ts:152-230`, `subagent-runner-step.ts:102-244`).
2. Idle watchdog with the same defaults and env overrides, `0` meaning disabled, and an in-flight-tool deferral hook (`attempt-watchdog.ts:35-118`).
3. Wall-clock cap as the unconditional backstop, and a **non-disableable** bounded escalation after the trip (`:40-43`, `:88-98`).
4. The exact timeout messages, since fallback classification matches on `timed out`/`timeout` (`:47-53` vs `model-fallback.ts:99-100`).
5. Graceful-then-forceful termination with the same phases: final drain 1000 ms → SIGTERM → 3000 ms → SIGKILL; abort → SIGTERM → 3000 ms → SIGKILL; interrupt → SIGINT → 1000 ms → SIGTERM (`execution-attempt.ts:190-226`, `:509-545`).
6. Cancellation must be *cooperative and observable*: an equivalent of `interrupted: true` with exit 0 and the "Waiting for explicit next action." summary (`execution-attempt-finalize.ts:20-33`).
7. `exitCode` conventions the parent already branches on: `0` success, `1` generic failure, `-1` skipped (fail-fast / detach-skip), `-2` detached-for-intercom (`subagent-runner-parallel.ts:114`, `execution-attempt-finalize.ts:36`).
8. Detach semantics: settle parent supervision while the child continues, then deliver the recovered result via `onDetachedExit`, defer artifact/progress/worktree cleanup until then (`execution-attempt.ts:175-189`, `:477-494`; `subagent-executor-single.ts:227-228`; `subagent-executor-parallel.ts:146-150`).
9. Stdout backpressure handling equivalent to `pause()/resume()` and the 50 MB JSONL cap (`jsonl-writer.ts:57-74`).

**Isolation and configuration**
10. cwd validation before starting, with cwd-specific error text (`pi-spawn.ts:50-64`).
11. Per-child cwd resolution (`resolveChildCwd`, `shared/utils.ts:34-37`) including worktree-assigned cwds.
12. Depth accounting: increment depth, clamp max at 5, propagate the workflow-stage guard, and block at the ceiling with the existing message variants (`types-depth.ts:134-156`, `:100-125`).
13. Interactive-engine env scrubbing applied *after* all layers (`spawn-env.ts:13-21`).
14. The tools/extensions contract: prompt-runtime extension registered first; explicit `extensions` means allowlist mode; path-like tool entries are extensions, not builtins; `structured_output` auto-allowed only when a builtin allowlist exists or the list is empty (`pi-args.ts:148-197`).
15. Session semantics: `--session`, `--session-dir`, `--no-session`, and the resulting `sessionFile` used by status/resume (`pi-args.ts:130-141`, `execution-run-sync.ts:273-278`).
16. Large-task and system-prompt spillover to `0600` temp files with guaranteed cleanup (`pi-args.ts:203-221`, `:332-339`).
17. `MCP_DIRECT_TOOLS` sentinel semantics: unset = config defaults, `__none__` = force none (`pi-args.ts:316-321`).
18. Structured-output capture path/schema wiring plus stale-file deletion before each attempt, and up to `STRUCTURED_OUTPUT_MAX_CORRECTIVE_PROMPTS` corrective retries before model fallback (`pi-args.ts:322-325`, `execution-attempt.ts:112-118`, `subagent-runner-step.ts:216-228`).

**Observability and result plumbing**
19. The four artifact files with today's exact naming, including the `_meta.json` field sets for both foreground and background (`artifacts.ts:21-31`, `execution-run-sync.ts:130-147`, `subagent-runner-step.ts:289-308`).
20. `run-history.jsonl` append semantics (200-char task truncation, second-resolution ts, `exit` only on failure, best-effort, 1200→1000 rotation) (`run-history.ts:21-54`).
21. `status.json` shape and cadence, since the tracker, widget, status tool, and stale reconciler all read it — including `pid`, `state`, `steps[]`, `lastActivityAt`, `currentTool*`, `parallelGroups`, `totalTokens`, `outputFile` (`subagent-runner-state.ts:115-133`, `:476-480`).
22. `events.jsonl` lifecycle/control records (`subagent.run.started/completed/paused/repaired_stale`, `subagent.step.started/completed/failed`, `subagent.parallel.completed`, `subagent.control`) and the byte-cursor tail contract used by the tracker (`subagent-runner.ts:18-28`, `subagent-runner-finalize.ts:74-83`, `async-job-tracker.ts:177-243`).
23. Per-step `output-<i>.log` transcripts, whose mtime also feeds status activity derivation (`subagent-runner-streaming.ts:50`, `subagent-runner-state.ts:257-265`, `async-status.ts:144-165`).
24. The terminal result JSON contract consumed by the watcher, including `asyncDir`, `sessionId`, `cwd`, `intercomTarget`, `results[]`, `outputs`, `workflowGraph` (`subagent-runner-finalize.ts:104-146`).
25. Terminal-status gating before delivery: a result whose `asyncDir` is present must have a matching terminal `status.json`, with root containment, symlink refusal, and byte cap (`result-status.ts:62-87`). An in-process runner still needs an equivalent "not deliverable until terminal" barrier.
26. Claim/dedupe/quarantine invariants: atomic claim, frozen envelope, separate intercom/local delivery phases that are never replayed, signature conflict → `.undelivered/`, exhaustion cap (`result-file-claims.ts:93-150`, `completion-claims.ts:96-196`, `result-quarantine.ts:47-77`).
27. Session/cwd ownership filtering so a result is only delivered to its owning session (`result-watcher.ts:91-94`).
28. A liveness/failure story replacing `checkPidLiveness` + stale repair, so an in-process runner that dies mid-run still produces a terminal status and a failed result rather than a permanently "running" record (`stale-run-reconciler.ts:389-457`).

**Control surface**
29. `status` / `interrupt` / `resume` must keep working for both live and terminal runs, including revive-from-session-file with the `.jsonl`/existence/trusted-root validations (`subagent-executor-resume.ts:287-310`, `:460-648`).
30. An interrupt mechanism replacing `SIGUSR2`/`SIGBREAK`-to-runner-pid that yields the same paused status, `subagent.run.paused` event, and forwarded child interrupt (`subagent-executor-resume.ts:236-271`, `subagent-runner-state.ts:550-570`).
31. Async launch acknowledgement semantics: "launched / completion pending / do not poll" and a job identity the tracker can follow without a pid (`async-execution-common.ts:60-69`, `async-job-tracker.ts:422-465`).
32. Control events remain advisory, deduped by `runId:index:type:reason`, and routed to `event`/`async`/`intercom` channels (`subagent-control.ts:140-160`, `async-job-tracker.ts:214-237`).
33. Foreground live-update contract: `onUpdate` snapshots with merged parallel results/progress and workflow-graph metadata (`subagent-executor-parallel-task.ts:148-185`, `chain-execution-parallel-runner.ts:164-206`).

**Concurrency, isolation, and identity**
34. `mapConcurrent` ordering/limits, 50-task cap, default concurrency 4 (`parallel-utils.ts:87-105`, `types-runtime.ts:74-75`).
35. Fail-fast: skipped siblings as `exitCode -1` with "Skipped due to fail-fast", and `-1` excluded from group failure determination (`subagent-runner-parallel.ts:107-130`, `:302-305`).
36. Worktree isolation guarantees: clean-tree precondition, per-task branch/dir naming, setup-hook contract (JSON stdin/stdout, `syntheticPaths` validation, 30 s timeout, EPIPE tolerance), guaranteed cleanup even on failure (`worktree.ts:110-121`, `:150-158`, `:263-304`, `subagent-runner-parallel.ts:306-308`).
37. Intercom group precedence, one shared auto-group per parallel set, group cleared for children without intercom access, and deterministic `subagent-<agent>-<runId>-<n>` targets (`intercom-group.ts:27-51`, `pi-args.ts:299-306`, `intercom-bridge.ts:99-102`).
38. Supervisor capability is per-child, requested before start, and never inherited by descendants (`pi-args.ts:295-298`, `subagent-executor-async.ts:36-75`).
39. Fanout gating: nested-route env (event sink, control inbox, root run id, capability token, depth, path) is populated **only** for children whose tools include `subagent` (`pi-args.ts:150`, `:273-286`).
40. Model-fallback behavior end to end: pre-spawn auth filtering with recorded skipped attempts, the retryable/non-retryable kind sets, `[undefined]` vs `[]` candidate semantics, `modelAttempts`/`attemptedModels` reporting, and `[fallback] …` attempt notes prefixed onto output (`model-candidate-filter.ts:26-57`, `model-fallback.ts:145-152`, `execution-run-sync.ts:151`, `subagent-runner-step.ts:84-90`, `:268-270`).
41. One-subagent-call-per-turn dispatch guard (`subagent-executor.ts:290-305`).