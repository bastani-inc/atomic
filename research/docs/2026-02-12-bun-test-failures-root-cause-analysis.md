---
date: 2026-02-12 03:57:25 UTC
researcher: Copilot CLI
git_commit: f9603b88b96c47859073b0647d2c6b7d95057f8d
branch: lavaman131/hotfix/opentui-distribution
repository: atomic
topic: "Root cause analysis of 104 bun test failures across 6 error categories"
tags:
    [
        research,
        testing,
        bun-errors,
        theme,
        agents,
        claude-sdk,
        tool-renderers,
        ui,
    ]
status: complete
last_updated: 2026-02-12
last_updated_by: Copilot CLI
---

# Research: Bun Test Failures Root Cause Analysis

## Research Question

Research how to resolve the 104 failing `bun test` errors documented in `bun_errors.txt`, by exploring the codebase in detail to identify root causes for each error category.

## Summary

104 tests fail across 6 distinct categories. In every case, **the source code was updated but the corresponding tests were not**. The tests contain stale expectations that no longer match the current implementation. Below is a category-by-category root cause analysis with exact file paths and line numbers.

## Detailed Findings

### Category 1: Builtin Agent `model` Field Missing (~30 tests)

**Root Cause**: The `AgentDefinition` interface defines an optional `model?: AgentModel` field, but **none of the builtin agent definitions include a `model` property**. Tests expect `agent.model` to be `"opus"` but it's `undefined`.

**Source**: [`src/ui/commands/agent-commands.ts`](https://github.com/bastani-inc/atomic/blob/f9603b88b96c47859073b0647d2c6b7d95057f8d/src/ui/commands/agent-commands.ts)

- **Interface**: Lines 175-225 — `AgentDefinition` has `model?: AgentModel` (line ~205)
- **Agent Definitions**: The `BUILTIN_AGENTS` array contains agents like `debugger` (line ~1085), `codebase-analyzer`, `codebase-locator`, `codebase-pattern-finder`, `codebase-online-researcher`, `codebase-research-analyzer`, `codebase-research-locator` — **none include `model: "opus"`**
- **`getBuiltinAgent()`**: Lines 1158-1163 — correctly finds agents by name, but since `model` is absent from definitions, `agent.model` is `undefined`

**Affected Tests**:

- `tests/e2e/subagent-debugger.test.ts` — 14 tests checking `agent.model === "opus"`
- `tests/e2e/subagent-codebase-analyzer.test.ts` — 6 tests checking `agent.model === "opus"`
- `tests/ui/commands/agent-commands.test.ts` — ~10 tests across all agent types

**Resolution**: Either add `model: "opus"` to each builtin agent definition in `BUILTIN_AGENTS`, or update the tests to not expect `model` to be defined (if model selection is intended to be dynamic).

---

### Category 2: Sub-agent `sentMessages` Empty (~20 tests)

**Root Cause**: `createAgentCommand().execute()` calls `context.spawnSubagent()` (fire-and-forget via `void`) and returns `{ success: true }` immediately. It **never calls `context.sendMessage()` or `context.sendSilentMessage()`**. The mock context's `sentMessages` array only tracks those two methods, so it remains empty.

**Source**: [`src/ui/commands/agent-commands.ts`](https://github.com/bastani-inc/atomic/blob/f9603b88b96c47859073b0647d2c6b7d95057f8d/src/ui/commands/agent-commands.ts)

- **`createAgentCommand()`**: Lines 1495-1532
    ```typescript
    execute: (args, context) => {
      void context.spawnSubagent({...}).then(...).catch(...);
      return { success: true };  // Returns immediately
    }
    ```
- **Mock Context**: `tests/e2e/subagent-debugger.test.ts` lines 121-191
    - `sentMessages` tracks `sendMessage()` / `sendSilentMessage()` calls
    - `spawnSubagent()` resolves successfully but doesn't add to `sentMessages`

**Affected Tests**:

- `tests/e2e/subagent-debugger.test.ts` — tests asserting `context.sentMessages.length > 0` or `context.sentMessages[0].toContain(...)`
- `tests/e2e/subagent-codebase-analyzer.test.ts` — same pattern

**Resolution**: Tests need to be updated to check `spawnSubagent` was called (e.g., via a spy or tracking array) instead of checking `sentMessages`. Alternatively, the mock's `spawnSubagent` could populate `sentMessages`.

---

### Category 3: Theme Color Mismatches (~12 tests)

**Root Cause**: The source theme uses **Catppuccin palette** colors, but tests expect **Tailwind CSS palette** colors. The theme was changed but tests were not updated.

**Source**: [`src/ui/theme.tsx`](https://github.com/bastani-inc/atomic/blob/f9603b88b96c47859073b0647d2c6b7d95057f8d/src/ui/theme.tsx)

| Property           | Source (Catppuccin)        | Test Expected (Tailwind) |
| ------------------ | -------------------------- | ------------------------ |
| **Dark Theme**     |                            |                          |
| `background`       | `#1e1e2e` (Mocha Base)     | `black`                  |
| `foreground`       | `#cdd6f4` (Mocha Text)     | `#ecf2f8`                |
| `error`            | `#f38ba8` (Mocha Red)      | `#fb7185` (Rose 400)     |
| `success`          | `#a6e3a1` (Mocha Green)    | `#4ade80` (Green 400)    |
| `warning`          | `#f9e2af` (Mocha Yellow)   | `#fbbf24` (Amber 400)    |
| `userMessage`      | `#89b4fa` (Mocha Blue)     | `#60a5fa` (Blue 400)     |
| `assistantMessage` | `#94e2d5` (Mocha Teal)     | `#2dd4bf`                |
| `systemMessage`    | `#cba6f7` (Mocha Mauve)    | `#a78bfa` (Violet 400)   |
| `userBubbleBg`     | `#313244` (Mocha Surface0) | `#3f3f46`                |
| **Light Theme**    |                            |                          |
| `background`       | `#eff1f5` (Latte Base)     | `white`                  |
| `foreground`       | `#4c4f69` (Latte Text)     | `#0f172a`                |
| `error`            | `#d20f39` (Latte Red)      | `#e11d48` (Rose 600)     |
| `success`          | `#40a02b` (Latte Green)    | `#16a34a` (Green 600)    |
| `warning`          | `#df8e1d` (Latte Yellow)   | `#d97706` (Amber 600)    |
| `userMessage`      | `#1e66f5` (Latte Blue)     | `#2563eb` (Blue 600)     |
| `assistantMessage` | `#179299` (Latte Teal)     | `#0d9488`                |
| `systemMessage`    | `#8839ef` (Latte Mauve)    | `#7c3aed` (Violet 600)   |
| `userBubbleBg`     | `#e6e9ef` (Latte Mantle)   | `#e2e8f0`                |

**Affected Tests**:

- `tests/ui/theme.test.ts` — lines 59-155 (dark/light theme color assertions, getMessageColor)
- `tests/ui/components/tool-result.test.tsx` — lines 61-67 (error color assertions)

**Resolution**: Update all test color values to match the Catppuccin palette values from the source.

---

### Category 4: Tool Renderer Icon Mismatches (~8 tests)

**Root Cause**: Tool renderers use **ASCII/Unicode symbols** in source, but tests expect **emoji icons**. The source was changed but tests were not updated.

**Source**: [`src/ui/tools/registry.ts`](https://github.com/bastani-inc/atomic/blob/f9603b88b96c47859073b0647d2c6b7d95057f8d/src/ui/tools/registry.ts)

| Tool    | Source Icon (Actual) | Test Expected Icon |
| ------- | -------------------- | ------------------ |
| Read    | `≡` (line 64)        | `📄`               |
| Edit    | `△` (line 133)       | `△` ✅ Match       |
| Bash    | `$` (line 187)       | `💻`               |
| Write   | `►` (line 258)       | `📝`               |
| Glob    | `◆` (line 314)       | `🔍`               |
| Grep    | `★` (line 402)       | `🔎`               |
| Default | `▶` (line 465)       | `🔧`               |

**Affected Tests**:

- `tests/ui/tools/registry.test.ts` — lines 34, 134, 187, 249, 291, 331
- `tests/ui/components/tool-result.test.tsx` — lines 306, 314, 322, 330, 338, 346

**Resolution**: Update test expectations to match the actual Unicode symbol icons, or update the source to use emojis if that was the intended design.

---

### Category 5: Claude SDK / HITL Integration (~6 tests)

**Root Cause**: `createSession()` **no longer calls `query()`** internally. A previous refactoring removed the initial empty-prompt query to fix a leaked subprocess issue. The comment in source explains: _"Don't create an initial query here — send()/stream() each create their own query with the actual user message. Previously an empty-prompt query was spawned here, which leaked a Claude Code subprocess that was never consumed."_

**Source**: [`src/sdk/claude-client.ts`](https://github.com/bastani-inc/atomic/blob/f9603b88b96c47859073b0647d2c6b7d95057f8d/src/sdk/claude-client.ts)

- **`createSession()`**: Lines 752-768 — calls `this.wrapQuery(null, sessionId, config)` without invoking `query()`
- **`query()` only called by**: `send()` (line 392), `stream()` (line 454), `summarize()` (line 599), `resumeSession()` (line 805)
- **`canUseTool` callback**: Created inside `buildSdkOptions()` (lines 237-297), only attached when `query()` is called
- **Mock setup**: `tests/sdk/claude-client.test.ts` line 166 — expects `mockQuery` called after `createSession()`, which no longer happens
- **HITL mock**: `tests/sdk/ask-user-question-hitl.test.ts` — captures `canUseToolCallback` during `query()` setup, but since `query()` isn't called during `createSession()`, callback remains `null`

**Affected Tests**:

- `tests/sdk/claude-client.test.ts` — 3 tests expecting `mockQuery.toHaveBeenCalled()` after `createSession()`
- `tests/sdk/ask-user-question-hitl.test.ts` — 3 tests expecting `canUseToolCallback` not null after `createSession()`

**Resolution**: Tests need to call `session.send()` or `session.stream()` after `createSession()` to trigger `query()`. Mock responses need to be set up so `query()` completes properly.

---

### Category 6: Misc UI Test Failures (~8 tests)

#### 6a. `truncate()` Function (2 tests)

**Root Cause**: `truncateText()` uses `"..."` (three periods) instead of `"…"` (single ellipsis character), and uses `maxLength - 3` for the slice which breaks at small limits.

**Source**: [`src/ui/utils/format.ts`](https://github.com/bastani-inc/atomic/blob/f9603b88b96c47859073b0647d2c6b7d95057f8d/src/ui/utils/format.ts) lines 144-147

```typescript
export function truncateText(text: string, maxLength: number = 40): string {
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 3)}...`;
}
```

- Export alias at line 57: `export const truncate = truncateText;`

**Test**: `src/ui/__tests__/task-list-indicator.test.ts` lines 89-101

- Expects `truncate("Hello, World!", 5)` → `"Hell…"` (gets `"He..."`)
- Expects `truncate("ab", 1)` → `"…"` (gets `"..."` with negative slice)

**Resolution**: Either update the function to use `"…"` and handle edge cases, or update tests to match current `"..."` behavior.

#### 6b. `buildDisplayParts()` Duration Formatting (2 tests)

**Root Cause**: `formatDuration()` uses `Math.floor()` for seconds, discarding sub-second precision.

**Source**: [`src/ui/utils/format.ts`](https://github.com/bastani-inc/atomic/blob/f9603b88b96c47859073b0647d2c6b7d95057f8d/src/ui/utils/format.ts) line ~68

```typescript
const seconds = Math.floor(ms / 1000); // 1500 → 1, not 1.5
return { text: `${seconds}s`, ms };
```

**Test**: `tests/ui/components/timestamp-display.test.tsx` lines 74-87

- Expects `buildDisplayParts(ts, 1500)` to include `"1.5s"` — actually returns `"1s"`
- Expects `buildDisplayParts(ts, 1000)` edge case handling

**Resolution**: Either update `formatDuration()` to show decimal seconds (e.g., `(ms / 1000).toFixed(1)`), or update tests to match current floor-based behavior.

#### 6c. Command Registration (2 tests)

**Root Cause**: Tests expect a "commit" command with alias "ci" to be registered, but no such command exists in the codebase.

**Source**:

- [`src/ui/commands/builtin-commands.ts`](https://github.com/bastani-inc/atomic/blob/f9603b88b96c47859073b0647d2c6b7d95057f8d/src/ui/commands/builtin-commands.ts) lines 551-560 — registered commands: help, theme, clear, compact, exit, model, mcp, context
- [`src/ui/commands/skill-commands.ts`](https://github.com/bastani-inc/atomic/blob/f9603b88b96c47859073b0647d2c6b7d95057f8d/src/ui/commands/skill-commands.ts) lines 1113-1135 — skills: research-codebase, create-spec, explain-code

**Test**: `tests/ui/commands/index.test.ts` line 79

- Expects `globalRegistry.has("ci")` to be `true`
- Expects `globalRegistry.has("commit")` to be `true`

**Resolution**: Either add a "commit" command with "ci" alias, or remove the test assertion for a command that doesn't exist.

#### 6d. `globalRegistry` Population (1 test)

**Root Cause**: Related to 6c — `tests/ui/index.test.ts` line 596 expects `globalRegistry` to be populated with specific commands that may not all be registered.

**Resolution**: Align test expectations with actually registered commands.

---

## Code References

- `src/ui/commands/agent-commands.ts:175-225` — `AgentDefinition` interface with optional `model` field
- `src/ui/commands/agent-commands.ts:1085-1150` — Debugger agent definition (no `model` property)
- `src/ui/commands/agent-commands.ts:1158-1163` — `getBuiltinAgent()` function
- `src/ui/commands/agent-commands.ts:1495-1532` — `createAgentCommand()` function
- `src/ui/theme.tsx:219-271` — Dark and light theme color definitions (Catppuccin)
- `src/ui/tools/registry.ts:64-465` — Tool renderer definitions with ASCII icons
- `src/sdk/claude-client.ts:237-297` — `buildSdkOptions()` with `canUseTool`
- `src/sdk/claude-client.ts:752-768` — `createSession()` without `query()` call
- `src/ui/utils/format.ts:144-147` — `truncateText()` function
- `src/ui/utils/format.ts:68` — `formatDuration()` with `Math.floor()`
- `src/ui/commands/builtin-commands.ts:551-560` — Registered builtin commands
- `src/ui/commands/skill-commands.ts:1113-1135` — Skill definitions
- `src/ui/commands/registry.ts:64-118` — `CommandContext` interface

## Architecture Documentation

The test failures reveal a pattern of source code evolution without test synchronization:

1. **Theme system** migrated from Tailwind CSS palette to Catppuccin palette
2. **Tool renderers** changed from emoji icons to Unicode symbols for better terminal compatibility
3. **Claude SDK integration** was refactored to fix subprocess leaks by deferring `query()` to message sending
4. **Agent command system** moved from `sendMessage`-based to `spawnSubagent`-based execution
5. **Agent model field** was added to the type system but not populated in definitions
6. **Command registry** evolved but new/removed commands weren't reflected in tests

## Historical Context (from research/)

- `research/docs/2026-02-04-agent-subcommand-parity-audit.md` — Audit of agent subcommand parity
- `research/docs/2026-02-03-command-migration-notes.md` — Notes on command system migration
- `research/docs/2026-01-31-claude-agent-sdk-research.md` — Claude Agent SDK research
- `research/docs/2026-01-31-claude-implementation-analysis.md` — Claude implementation analysis
- `research/docs/2026-02-05-subagent-ui-opentui-independent-context.md` — Sub-agent UI context design

## Related Research

- `research/docs/2026-02-01-chat-tui-parity-implementation.md`
- `research/docs/2026-02-05-model-command-header-update-research.md`

## Open Questions

1. **Agent model intent**: Should all builtin agents have `model: "opus"`, or is model selection intended to be dynamic/configurable at runtime?
2. **Icon design**: Were emojis intentionally replaced with Unicode symbols for terminal compatibility, or was this an incomplete migration?
3. **Commit command**: Was the "commit"/"ci" command removed intentionally, or is it planned but not yet implemented?
4. **Duration precision**: Should `formatDuration()` show sub-second precision (e.g., `1.5s`), or is integer seconds the desired behavior?
