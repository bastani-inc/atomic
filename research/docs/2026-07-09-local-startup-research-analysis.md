I could not write `research/docs/2026-07-09-local-startup-research-analysis.md` directly because this session only has read/search/list/todo tools and no file write/edit tool. Below is the complete content intended for that file.

```markdown
# Local Startup Research Analysis — Lazy/Non-Blocking Startup While Preserving APIs

Date: 2026-07-09  
Scope: Historical/current-context extraction from selected local research/spec documents only.  
Constraint: breaking_changes_allowed=false; preserve public APIs and existing behavior.

## Source Priority / Recency

1. `research/web/2026-07-08-bun-tui-first-input-responsiveness.md` — Recent; most relevant current guidance for first-input responsiveness.
2. `research/docs/2026-05-11-pi-mcp-adapter-and-subagents.md` — Moderate age; useful architectural patterns for lazy MCP/subagent startup.
3. `research/docs/2026-03-03-bun-migration-startup-optimization.md` — Aged; valuable baseline and historical implementation context, likely partially implemented afterward.
4. `specs/2026-03-02-bun-migration-startup-optimization.md` — Aged RFC/spec; superseded in part by the 2026-03-03 research/post-migration benchmark notes.
5. `research/docs/2026-02-14-mcp-tool-discovery-startup-bugs.md` — Aged; important warning about MCP discovery/session timing and why eager startup probes can be harmful.

---

## Analysis of: `research/web/2026-07-08-bun-tui-first-input-responsiveness.md`

### Document Context
- **Date**: 2026-07-08
- **Purpose**: Web research cache for Bun/TypeScript terminal UI first keyboard input responsiveness.
- **Status**: Most recent source and directly applicable to lazy/non-blocking startup work.

### Key Decisions / Guidance
1. **Prefer explicit responsiveness barriers before nonessential startup work**
   - Use render flush/idleness barriers first, then yield via macrotask before running nonessential probes.
   - Impact: lets first paint and first keyboard input happen before background discovery/probing consumes the event loop.

2. **Use macrotask yielding, not microtask yielding, for input responsiveness**
   - Prefer `setImmediate` / promisified `setImmediate`.
   - Avoid `queueMicrotask` and `process.nextTick` as “yields”; they run before I/O/input can be processed and can worsen starvation.

3. **Make probes async, cancellable, and budgeted**
   - File system, git, network, and capability probes should not block first input.
   - Long or optional startup tasks should have time budgets and be deferrable.

### Technical Specifications
- Use `performance.now()` to measure startup responsiveness milestones.
- Measure at least:
  - first byte / first render
  - first key/input handling
  - first submit/action handling
- Regression testing should cover:
  - mock input/headless renderer paths
  - real PTY paths
  - Windows ConPTY paths where applicable

### Actionable Insights
- Any lazy startup implementation should explicitly separate:
  - **required for first render/input**
  - **required before first model request**
  - **nice-to-have/background**
- Do not “fix” blocking startup by moving work into `queueMicrotask`; that still runs before input.
- Prefer a pattern like: render → flush/idle barrier → `await setImmediate()` → start background probes.

### Relevance Assessment
- **Document age**: Recent ≤30d.
- Treat this as the highest-priority guidance for current lazy/non-blocking startup implementation.

---

## Analysis of: `research/docs/2026-05-11-pi-mcp-adapter-and-subagents.md`

### Document Context
- **Date**: 2026-05-11
- **Purpose**: Research into pi MCP adapter, subagents, and intercom architecture.
- **Status**: Moderately recent; relevant for MCP/subagent startup architecture and lazy tool discovery patterns.

### Key Decisions / Patterns Relevant to Startup
1. **MCP adapter uses a thin, lazy proxy tool surface**
   - Registers one proxy tool `mcp` instead of eagerly registering/discovering many MCP tools.
   - Rationale: keeps prompt/tool surface small and avoids large upfront discovery costs.
   - Impact: strong precedent for preserving APIs while deferring expensive MCP work.

2. **MCP server lifecycle supports lazy startup**
   - Per-server lifecycle modes:
     - `lazy` default
     - `eager`
     - `keep-alive`
   - Impact: lazy/non-blocking startup should preserve config/API compatibility while allowing opt-in eager behavior.

3. **Some tool registration must still happen synchronously**
   - pi-mcp-adapter registers direct tools synchronously at module load when cached metadata is available.
   - It also registers the proxy tool synchronously.
   - Constraint: if APIs require tools to exist before `session_start`, startup code may need a lightweight registration phase that does not connect to servers.

4. **Session lifecycle uses async initialization**
   - `pi.on("session_start", ...)` boots `initializeMcp()` asynchronously.
   - `pi.on("session_shutdown", ...)` tears down resources.
   - Impact: useful pattern for Atomic: keep registration cheap and defer actual connection/discovery to async session lifecycle/background work.

5. **Generation-counter race guard**
   - Public extension idiom to mirror: generation-counter race guard for `session_start` lifecycle.
   - Impact: important for non-blocking initialization where a session may restart/shutdown while background work is still running.

### Critical Constraints
- **Tools may be frozen at module-load/session-start boundaries**
  - Open issue #69 notes lazy MCP tool discovery via `ctx_discover_tools` is impossible when tools are frozen at module-load.
  - Implication: preserve public APIs by registering stable proxy/direct placeholders early, then populate metadata lazily.
- **Subagents currently cannot see MCP tools**
  - Open issue #20 identifies the gap.
  - Any lazy startup work involving MCP/subagents should avoid making tool visibility even more timing-dependent.
- **Shared MCP process pool was recommended**
  - Research recommends sharing MCP server pool across parent and foreground subagents.
  - Startup implication: avoid eager per-agent MCP server spawning; prefer shared/lazy pool.

### Technical Specifications
- MCP config supports:
  - `lifecycle?: "keep-alive" | "lazy" | "eager"`
  - `idleTimeout?: number`
  - `directTools?: boolean | string[]`
  - `excludeTools?: string[]`
- Tool surfacing model:
  1. Direct tools from cached metadata
  2. Single `mcp` proxy tool
  3. Both can coexist
- Discovery is config-file based, not running-process autodiscovery.
- Transports:
  - stdio
  - streamable-http
  - SSE fallback

### Actionable Insights
- Preserve APIs by registering stable tools/commands immediately, but defer:
  - MCP server process startup
  - tool schema expansion
  - OAuth/browser flows
  - network/resource discovery
- Use cached metadata for immediate display/tool registration when available.
- Treat direct tool registration and proxy registration differently:
  - proxy can be cheap and always present
  - direct tools require metadata and should avoid live server connection at startup
- Add lifecycle cancellation/race protection for async startup work.

### Relevance Assessment
- **Document age**: Moderate 31–90d.
- Still applicable as architectural context. It does not supersede the Bun startup docs, but it adds important MCP/subagent-specific lazy initialization constraints.

---

## Analysis of: `research/docs/2026-03-03-bun-migration-startup-optimization.md`

### Document Context
- **Date**: 2026-03-03
- **Purpose**: Research Node/Bun dependency usage and CLI startup path; identify Bun-native startup optimizations.
- **Status**: Aged >90d. Contains historical baseline and post-migration benchmark notes. Use as context, not guaranteed current source of truth.

### Key Historical Findings
1. **Atomic CLI was already Bun-first**
   - Scripts, tests, builds, and runtime used Bun.
   - Node compatibility imports were mostly Bun-compatible.
   - Only hard Node requirement: Copilot SDK subprocess due to `node:sqlite`.

2. **CLI startup was already designed around lazy loading**
   - Eager imports at the time: 6 modules / ~36KB.
   - Startup did **not** load SDKs, telemetry state, config file I/O, network, React/OpenTUI, or MCP discovery.
   - Command handlers used dynamic `await import()`.

3. **Telemetry upload was fire-and-forget after command completion**
   - Spawned detached child process after command completes.
   - Historical implementation used `child_process.spawn(process.execPath, [scriptPath, "upload-telemetry"], ...)`.
   - Startup impact was intended to be minimal because upload happened after command execution.

4. **Copilot SDK Node workaround must remain**
   - Copilot CLI requires `node:sqlite`, unsupported by Bun.
   - Existing workaround launches Copilot CLI under Node:
     - resolve Node binary
     - resolve bundled Copilot CLI `index.js`
     - set `cliPath` to Node
     - prepend `--no-warnings` and CLI path to args
   - Do not migrate this subprocess to Bun unless upstream removes `node:sqlite`.

### Technical Specifications / Historical Baseline
- Baseline benchmark for `./src/cli.ts --version`:
  - Mean: 32.03ms
  - Median: 31.73ms
  - P95: 34.47ms
- Post-migration benchmark:
  - Mean: 31.79ms
  - Median: 31.62ms
  - P95: 33.30ms
- Net gain was small:
  - Mean improved by 0.24ms / 0.74%
  - P95 improved by 1.17ms / 3.39%

### Actionable Insights
- Preserve the existing lazy command-handler architecture; do not replace it with eager central initialization.
- Do not perform config I/O, SDK loading, MCP discovery, or UI initialization on global CLI import.
- Startup optimizations that only replace Node APIs with Bun APIs may have limited measured impact compared with deferring work off the first-input path.
- Maintain the Copilot Node subprocess workaround exactly in behavior.

### Relevance Assessment
- **Document age**: Aged >90d.
- Useful as historical architecture/baseline. Some recommendations appear to have been implemented by the time post-migration benchmarks were added, so verify current code before reapplying old checklist items.

---

## Analysis of: `specs/2026-03-02-bun-migration-startup-optimization.md`

### Document Context
- **Date**: Created/updated 2026-03-03, filename 2026-03-02
- **Purpose**: Technical design for Bun API migration and CLI startup optimization.
- **Status**: Aged RFC. Superseded in part by `research/docs/2026-03-03-bun-migration-startup-optimization.md`, especially where post-migration results exist.

### Key Decisions
1. **Incremental one-for-one API migration**
   - Replace Node APIs with Bun-native equivalents without changing control flow or module boundaries.
   - Preserve lazy-loading architecture unchanged.
   - Impact: low-risk optimization compatible with `breaking_changes_allowed=false`.

2. **Do not refactor existing lazy-loading architecture**
   - Explicit non-goal: do not refactor lazy loading because it was already well optimized.
   - Impact: current lazy/non-blocking startup work should extend existing lazy boundaries rather than redesign public APIs.

3. **Do not migrate Copilot SDK subprocess away from Node**
   - Hard `node:sqlite` dependency.
   - Impact: preserve API/behavior by keeping Node execution path for Copilot CLI.

4. **Do not migrate sync startup config reads blindly**
   - Sync `node:fs` imports should remain where synchronous behavior is required.
   - Files called out to skip:
     - `src/utils/settings.ts`
     - `src/utils/mcp-config.ts`
     - `src/config/index.ts`
     - constructors/top-level sync paths

### Technical Specifications
- Preferred substitutions:
  - `execSync("which/where ...")` → `Bun.which(...)`
  - `child_process.spawn` → `Bun.spawn(...)`
  - inline `require("fs")` → top-level ESM `node:fs` imports
- `Bun.which()` details:
  - returns `string | null`
  - handles Windows `PATHEXT`
  - does not throw on missing binary
- `Bun.spawn()` details from spec:
  - command and args passed as one array
  - stdio as `["ignore", "ignore", "ignore"]`
  - `proc.unref()` for fire-and-forget
- `Bun.file()` caveat:
  - does not throw on missing files; use `.exists()` guard or catch.

### Actionable Insights
- For current lazy/non-blocking startup, prefer surgical changes that preserve:
  - function signatures
  - command behavior
  - module boundaries
  - sync/async contracts
- Moving sync config APIs to async can be breaking if callers rely on synchronous availability.
- If adding background startup tasks, retain equivalent observable behavior and avoid making command registration depend on async completion.

### Relevance Assessment
- **Document age**: Aged >90d.
- Use as design constraints and compatibility guidance. Treat implementation checklist as historical; verify current code because the newer research document includes post-migration benchmarks.

---

## Analysis of: `research/docs/2026-02-14-mcp-tool-discovery-startup-bugs.md`

### Document Context
- **Date**: 2026-02-14
- **Purpose**: Trace MCP config loading, server connection, tool discovery, state storage, and UI rendering bugs in `/mcp`.
- **Status**: Aged >90d but highly relevant as a cautionary document about MCP discovery timing and lazy session creation.

### Key Historical Findings
1. **Session creation was intentionally lazy**
   - TUI starts with `state.session = null`.
   - Session is only created when the first message is sent via `ensureSession()`.
   - Impact: pre-first-message commands cannot assume runtime MCP/session data exists.

2. **Runtime MCP tool discovery required an active session/query**
   - Claude `getMcpSnapshot()` returned `null` before first message because:
     - no `sdkSessionId`
     - no active `query`
   - Actual MCP tools only appeared after:
     - first message sent
     - SDK query started/completed enough to expose MCP status
     - MCP server finished connecting

3. **Avoid eager probe query during startup**
   - Document notes `createSession()` deliberately did not create an initial query to avoid leaking subprocesses.
   - Impact: do not introduce eager session/probe query merely to populate `/mcp` output unless subprocess lifetime/leak risk is explicitly handled.

4. **Static config fallback can be misleading**
   - Tool display fallback chain:
     1. runtime server tools
     2. config-declared tools
     3. empty list
   - A project `.mcp.json` without `tools` overrode builtin DeepWiki config with `tools: ["ask_question"]`, causing “No MCP tools available.”

### Critical Constraints
- MCP runtime data is not available before first message under lazy session design.
- Config dedup used “last wins” full object replacement, not field-level merge.
- Eager MCP startup/probing risks subprocess leaks and additional startup blocking.
- UI must distinguish “not discovered yet” from “no tools available.”

### Actionable Insights
- Lazy/non-blocking startup should preserve the null/not-yet-initialized MCP state and represent it accurately in UI.
- Do not block first render/input waiting for MCP server connection/tool enumeration.
- Prefer states like:
  - configured
  - connecting
  - not queried yet
  - tools unavailable until first message
  - no tools
- If background MCP discovery is added, make it cancellable and lifecycle-aware.
- Avoid changing `/mcp` API semantics to require a session before first message.

### Relevance Assessment
- **Document age**: Aged >90d.
- Still valuable because it documents why MCP discovery is timing-sensitive. It should constrain current lazy startup work: do not reintroduce eager MCP/session probes that were previously avoided.

---

## Consolidated Guidance for Current Lazy/Non-Blocking Startup Work

### Preserve These APIs / Behaviors
- Command registration should remain synchronous/lightweight.
- Public slash commands/tools should remain available even if runtime discovery is pending.
- Copilot SDK subprocess must continue to run under Node.js due to `node:sqlite`.
- Sync config/settings APIs should not be made async if callers require synchronous values.
- Lazy session creation should not be broken by eager SDK/MCP probes.

### Prefer These Implementation Patterns
- Register cheap placeholders/proxy tools early; connect/discover later.
- Use cached metadata where available.
- Defer MCP/server/tool/network/git/fs probes until after first render/input or until actually needed.
- Use macrotask yields (`setImmediate`) before background work, not microtasks.
- Add cancellation/race guards for async lifecycle work.
- Use explicit “not initialized yet” states instead of showing empty results.

### Avoid These Regressions
- Do not load SDKs, MCP discovery, telemetry state, React/OpenTUI, or network clients at CLI module import time.
- Do not run probe queries at startup unless subprocess lifetime and cancellation are safe.
- Do not make UI wait for MCP discovery before accepting first input.
- Do not treat missing runtime MCP snapshot as “no tools.”
- Do not replace synchronous startup config reads with async APIs unless all callers are already async-safe.

### Historical Performance Context
- March 2026 startup baseline was already around 32ms for `./src/cli.ts --version`.
- Bun API substitutions produced small measured improvements.
- Current likely higher-value work is event-loop responsiveness and deferring optional work, not broad Node-to-Bun API churn.
```
