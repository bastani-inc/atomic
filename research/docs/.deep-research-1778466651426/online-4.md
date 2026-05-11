# Partition 4 — `tests/` External Library Research

## Decision: Research IS applicable

The test suite (52 files, ~10 k LOC) uses `bun:test` APIs that have important
behavioural nuances not obvious from the import names alone, especially:

- `mock.module()` timing/hoisting semantics (critical for the claude-agent-sdk mock pattern)
- `spyOn` + `mockImplementation` chain used in registry tests
- AI-agent quieter-output env vars (`CLAUDECODE`, `REPL_ID`, `AGENT`) referenced in CLAUDE.md and in the project's test-script commentary
- `mock()` function for stub objects (renderer-background, tui-diagnostics)

Snapshot testing (`toMatchSnapshot`) is **not** used anywhere in `tests/`; that
section can be skipped for the rewrite.

---

#### Bun test runner — `bun:test` module

**Docs:** https://bun.com/docs/test/index.md  
**Docs (mocks):** https://bun.com/docs/test/mocks.md  
**Docs (lifecycle):** https://bun.com/docs/test/lifecycle.md  
**Docs (AI-agent integration / quieter output):** https://bun.com/docs/test/index.md (§ "AI Agent Integration")

**Relevant behaviour:**

1. **`mock(fn)`** — wraps `fn` and decorates it with `.mock.calls`, `.mock.results`, `.mock.lastCall`, and the full `mockImplementation` / `mockReturnValue` / `mockResolvedValue` family.  The result satisfies `toHaveBeenCalled`, `toHaveBeenCalledTimes`, `toHaveBeenCalledWith`.

2. **`mock.module(specifier, factory)`** — overrides the ESM/CJS module cache for `specifier`. The factory callback is evaluated lazily on first import after the call. **Critical timing rule**: when mocking a package that has already been imported (e.g. at top-level `await import()`), the original module's side-effects have already run; only subsequent imports see the mock. The codebase works around this with the pattern of capturing `actualClaudeSdk = await import("@anthropic-ai/claude-agent-sdk")` then spreading it in the factory so only `getSessionMessages` is overridden while all other exports remain authentic — a documented safe pattern.

3. **`spyOn(object, methodName)`** — wraps the named method in-place; the spy keeps the original implementation and also tracks calls. Calling `.mockImplementation(() => {})` silences the original. Restore with `.mockRestore()` or `mock.restore()` (global).

4. **`mock.clearAllMocks()`** — resets call history on all mocks without restoring implementations.

5. **`mock.restore()`** — restores all spied-on methods to originals; does NOT un-mock `mock.module()` overrides.

6. **Lifecycle hooks** — `beforeAll`, `beforeEach`, `afterEach`, `afterAll`; these are scoped to the `describe` block they appear in. `onTestFinished` runs after a single test, after all `afterEach` handlers.

7. **AI-agent quieter output** — `bun test` suppresses passing-test lines and shows only failures + summary when **any** of the following env vars is set:
   - `CLAUDECODE=1` (Claude Code)
   - `REPL_ID=1` (Replit)
   - `AGENT=1` (generic)
   This is noted in CLAUDE.md under "AI Agent Integration". The rewrite must **not** interpret these as general test-filtering logic; they solely affect reporter verbosity.

**Where used in `tests/`:**

| API | Path:line | Note |
|-----|-----------|------|
| `mock.module("@anthropic-ai/claude-agent-sdk", factory)` | `tests/sdk/providers/claude-wait-for-idle.test.ts:37` | Top-level `await mock.module(...)` called before the module under test is imported; factory spreads `actualClaudeSdk` and overrides only `getSessionMessages` with a queue-based stub |
| `mock(() => {})` stub objects | `tests/sdk/components/renderer-background.test.ts:13-15` | Creates `CliRenderer` stub via `Partial<CliRenderer>` cast |
| `mock(() => {})` stub objects | `tests/sdk/components/tui-diagnostics.test.ts:66-67` | `dumpBuffers`, `dumpStdoutBuffer` stubs |
| `spyOn(console, "warn").mockImplementation(...)` | `tests/sdk/registry.test.ts:162,191` | Silences console.warn; inspects `.mock.calls` in assertions |
| `beforeEach` / `afterEach` env save-restore | `tests/sdk/providers/copilot.test.ts`, `tests/sdk/runtime/executor.test.ts`, `tests/sdk/runtime/tmux.test.ts` | Standard env-var isolation pattern |

---

#### `@anthropic-ai/claude-agent-sdk` — test contract only

**Docs (local cache):** `research/web/2026-04-14-claude-agent-sdk-hil-transcript.md`  
**Relevant behaviour (test-surface only):**

The tests mock the SDK at the module boundary. Only two SDK symbols cross the
mock boundary into real test assertions:

- `SessionMessage` (type import only) — used to type the queue arrays in
  `claude-wait-for-idle.test.ts`; no runtime behaviour is exercised
- `getSessionMessages(sessionId: string, opts?) → Promise<SessionMessage[]>` —
  the function that the mock replaces; tests verify the **wrapper logic** in
  `claude.ts` (slice detection, flush-race retry, mid-loop flush) not the SDK
  itself

`listSessions()` is imported directly (un-mocked) in one CI-adjacent test that
simply asserts it returns an array. No mock contract is needed for it.

The HIL marker flow (`watchHILMarker`) does NOT mock the SDK at all; it uses
real `fs.watch` with UUID-namespaced marker files.

**Where used:**

| Symbol | Path:line | Note |
|--------|-----------|------|
| `import type { SessionMessage }` | `tests/sdk/providers/claude-wait-for-idle.test.ts:21` | Type-only; erased at runtime |
| `await import("@anthropic-ai/claude-agent-sdk")` + spread in `mock.module` factory | `tests/sdk/providers/claude-wait-for-idle.test.ts:35-44` | Captures real module before overriding |
| `listSessions` (un-mocked) | one CI helper | Smoke-tests that the export is callable |

---

## Prose Summary

External library research is warranted for this partition, but it is narrowly scoped.

The `tests/` directory's primary test runner is `bun:test` (Jest-compatible API). The key
non-obvious API is `mock.module()`: its ESM live-binding semantics mean mocks declared at
file top-level (before the module under test is imported) suppress original side-effects,
while mocks declared inside test bodies do not. The project exploits this correctly in
`claude-wait-for-idle.test.ts` by capturing the authentic module via a top-level `await
import()` and spreading it in the factory — this is the canonical "partial module mock"
pattern documented in Bun's mocks guide.

The AI-agent env vars (`CLAUDECODE=1`, `REPL_ID=1`, `AGENT=1`) only affect Bun's reporter
verbosity; they do not influence test selection or mocking behaviour and need not be
replicated in test logic during the rewrite.

Snapshot tests (`toMatchSnapshot`) are absent from this test suite, so that API surface
needs no attention.

The `@anthropic-ai/claude-agent-sdk` appears only as a mocked boundary dependency. The
actual SDK type `SessionMessage` is used for TypeScript queue typing but carries no runtime
contract the rewrite needs to preserve independently of the SDK version. All substantive
Claude-provider logic is exercised through internal module imports with the SDK replaced by
queue-based stubs.

`@opentui/core` (specifically `CliRenderer`) appears only as a `Partial<CliRenderer>` cast
target for stub objects constructed with `mock(() => {})`. No real renderer is instantiated
in tests; no OpenTUI test-specific API is required.
