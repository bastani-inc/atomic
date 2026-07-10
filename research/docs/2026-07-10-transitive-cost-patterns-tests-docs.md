I completed the read-only research, but the available tool set in this subagent session does not include an edit/write tool, so I could not update:

- `/workspaces/atomic/progress.md`
- `/workspaces/atomic/research/docs/2026-07-10-transitive-cost-patterns-tests-docs.md`

Below is the content intended for the requested research document.

---

# Transitive Cost Patterns, Tests, and Docs Research

Date: 2026-07-10  
Scope: `/workspaces/atomic`  
Mode: read-only research  
Breaking changes allowed: false

## Pattern Examples: Keyed Maps / Upsert Tests

### Pattern 1: Live chat tool-call upsert by `toolCallId`

**Found in**: `packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:276-308`  
**Used for**: Maintaining a keyed live transcript row per tool call, replacing existing rows on repeated events and deleting pending state on final result.

```ts
private upsertToolEntry(update: {
  toolCallId?: string;
  toolName: string;
  args?: unknown;
  isPartial: boolean;
}): boolean {
  const toolCallId = update.toolCallId ?? `live-${update.toolName}`;
  const index = this.pendingToolIndexes.get(toolCallId) ?? this.findToolEntryIndex(toolCallId, update.toolName);
  const previous = index >= 0 ? this.entries[index] : undefined;
  const previousTool = this.isToolEntry(previous) ? previous : undefined;
  const next: ChatMessageEntry = {
    role: "tool",
    kind: "tool",
    toolName: previousTool?.toolName ?? update.toolName,
    toolCallId,
    args: update.args ?? previousTool?.args ?? {},
    result: previousTool?.result,
    isPartial: update.isPartial,
  };
  if (index >= 0) this.entries[index] = next;
  else this.entries.push(next);
  this.pendingToolIndexes.set(toolCallId, index >= 0 ? index : this.entries.length - 1);
  return true;
}

private updateToolResult(toolCallId: string, result: unknown, isPartial: boolean, isError: boolean): boolean {
  const index = this.pendingToolIndexes.get(toolCallId) ?? this.findToolEntryIndex(toolCallId);
  if (index < 0) return false;
  const entry = this.entries[index];
  if (!this.isToolEntry(entry)) return false;
  const resultObject = toolResultFromUnknown(result, entry.toolName, toolCallId, isError);
  this.entries[index] = { ...entry, result: resultObject, isPartial };
  if (!isPartial) this.pendingToolIndexes.delete(toolCallId);
  return true;
}
```

**Key aspects**:

- Uses `pendingToolIndexes` as keyed index map.
- Upserts by concrete `toolCallId`.
- Falls back to synthetic IDs for missing IDs.
- Reuses previous args/results where later events omit data.
- Deletes pending key on final non-partial result.

### Pattern 2: Tests for keyed tool-call upsert and parallel same-name calls

**Found in**: `test/unit/chat-message-renderer.test.ts:88-138`  
**Used for**: Verifying multiple same-name tool calls remain distinct by ID.

```ts
test("renders distinct rows and output for parallel same-name tool calls (live events)", () => {
  const entries = [] as ReturnType<typeof chatEntriesFromAgentMessages>;
  const live = new LiveChatEntriesController(entries);

  // A single assistant snapshot announcing TWO parallel `read` tool calls.
  live.applyEvent({
    type: "message_update",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "A", name: "read", arguments: { path: "a.ts" } },
        { type: "toolCall", id: "B", name: "read", arguments: { path: "b.ts" } },
      ],
    },
  });

  live.applyEvent({ type: "tool_execution_start", toolCallId: "A", toolName: "read", args: { path: "a.ts" } });
  live.applyEvent({ type: "tool_execution_start", toolCallId: "B", toolName: "read", args: { path: "b.ts" } });
  live.applyEvent({
    type: "tool_execution_end",
    toolCallId: "A",
    toolName: "read",
    result: { content: [{ type: "text", text: "OUTPUT_A" }] },
    isError: false,
  });
  live.applyEvent({
    type: "tool_execution_end",
    toolCallId: "B",
    toolName: "read",
    result: { content: [{ type: "text", text: "OUTPUT_B" }] },
    isError: false,
  });

  // Two distinct concrete toolCallIds must keep two distinct transcript rows.
  const tools = entries.filter((e) => e.kind === "tool");
  assert.equal(tools.length, 2);
  assert.deepEqual(tools.map((tool) => tool.toolCallId), ["A", "B"]);

  // Neither row may be left as a bare result-less tool marker (the #1198 bug).
  for (const tool of tools) {
    assert.notEqual(tool.result, undefined);
    assert.equal(tool.isPartial, false);
  }

  const aBlock = tools[0]?.result?.content[0];
  assert.equal(aBlock?.type === "text" ? aBlock.text : undefined, "OUTPUT_A");
  const bBlock = tools[1]?.result?.content[0];
  assert.equal(bBlock?.type === "text" ? bBlock.text : undefined, "OUTPUT_B");

  assert.deepEqual(live.pendingToolIds(), []);
});
```

**Key aspects**:

- Uses `bun:test` and `node:assert/strict`.
- Tests same tool name with different IDs.
- Asserts order and final outputs.
- Asserts pending keyed map drains after completion.

### Pattern 3: Built-in model/custom model upsert documentation

**Found in**: `packages/coding-agent/docs/models.md:362-365`  
**Used for**: Provider model merge-by-ID behavior.

```md
- Built-in models are kept.
- Custom models are upserted by `id` within the provider.
- If a custom model `id` matches a built-in model `id`, the custom model replaces that built-in model.
- If a custom model `id` is new, it is added alongside built-in models.
```

**Related changelog entry**: `packages/coding-agent/CHANGELOG.md:2932-2934`

```md
- Changed `models.json` provider `models` behavior from full replacement to merge-by-id with built-in models. Built-in models are now kept by default, and custom models upsert by `id`.
```

---

## Pattern Examples: Event Bus Subscribers / Emitters

### Pattern 1: Extension event subscribers with `pi.on(...)`

**Found in**: `packages/coding-agent/docs/extensions.md:69-77`  
**Used for**: Extensions subscribing to session/tool events.

```ts
// React to events
pi.on("session_start", async (_event, ctx) => {
  ctx.ui.notify("Extension loaded!", "info");
});

pi.on("tool_call", async (event, ctx) => {
  if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
    const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
    if (!ok) return { block: true, reason: "Blocked by user" };
  }
});
```

### Pattern 2: Generic extension event subscriber shape

**Found in**: `packages/coding-agent/docs/extensions.md:172-176`  
**Used for**: Event handler API documentation.

```ts
// Subscribe to events
pi.on("event_name", async (event, ctx) => {
  // ctx.ui for user interaction
  const ok = await ctx.ui.confirm("Title", "Are you sure?");
  ctx.ui.notify("Done!", "info");
});
```

### Pattern 3: Compaction event subscribers

**Found in**: `packages/coding-agent/docs/compaction.md:688-729`  
**Used for**: Extension hooks around compaction lifecycle.

```ts
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, parameters, branchEntries, reason, signal } = event;

  // parameters.compression_ratio - fraction of compactable context to keep
});
```

```ts
pi.on("session_compact", async (event, ctx) => {
  // event.parameters - effective compression_ratio, preserve_recent, and query
  // event.result - ContextCompactionResult, including result.parameters
  // event.contextCompactionEntry - the saved ContextCompactionEntry
});
```

### Pattern 4: Session-tree event subscribers

**Found in**: `packages/coding-agent/docs/compaction.md:910-913`  
**Used for**: Intercepting tree navigation.

```ts
pi.on("session_before_tree", async (event, ctx) => {
  const { preparation, signal } = event;
});
```

### Pattern 5: SDK session event subscription

**Found in**: `packages/coding-agent/docs/sdk.md:24-34`  
**Used for**: Programmatic SDK listeners.

```ts
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

// Subscribe to events
session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});
```

### Pattern 6: Internal event emit after session rename

**Found in**: `packages/coding-agent/src/core/agent-session-tree.ts:6-10`  
**Used for**: Runtime emitting both local session event and extension event.

```ts
export function setSessionName(this: AgentSession, name: string): void {
  this.sessionManager.appendSessionInfo(name);
  const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
  this._emit(event);
  void this._extensionRunner.emit(event);
}
```

### Pattern 7: Internal event emit after compaction

**Found in**: `packages/coding-agent/src/core/agent-session-compaction.ts:176-179`  
**Used for**: Emitting extension event after context compaction entry is persisted.

```ts
const contextCompactionEntry = this.sessionManager.getEntry(compactionEntryId) as ContextCompactionEntry;
try {
  await this._extensionRunner.emit({
    type: "session_compact",
```

---

## Pattern Examples: Slash Command Implementations

### Pattern 1: Slash command metadata registry

**Found in**: `packages/coding-agent/src/core/slash-commands.ts:163-193`  
**Used for**: Built-in slash command names, descriptions, and optional completions.

```ts
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
  { name: "settings", description: "Open settings menu" },
  { name: "model", description: "Select model (opens selector UI)" },
  { name: "scoped-models", description: "Enable/disable models for ctrl+p cycling" },
  { name: "fast", description: "Configure Codex fast mode for chat and workflows" },
  { name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
  { name: "import", description: "Import and resume a session from a JSONL file" },
  { name: "share", description: "Share session as a secret GitHub gist" },
  { name: "copy", description: "Copy last agent message to clipboard" },
  { name: "name", description: "Set session display name" },
  { name: "session", description: "Show session info and stats" },
  { name: "changelog", description: "Show changelog entries" },
  {
    name: ATOMIC_GUIDE_COMMAND_NAME,
    description: ATOMIC_GUIDE_COMMAND_DESCRIPTION,
    getArgumentCompletions: getAtomicGuideArgumentCompletions,
  },
  { name: "hotkeys", description: "Show all keyboard shortcuts" },
  { name: "fork", description: "Create a new fork from a previous user message" },
  { name: "clone", description: "Duplicate the current session at the current position" },
  { name: "tree", description: "Navigate session tree (switch branches)" },
  { name: "trust", description: "Save project trust decision for future sessions" },
  { name: "login", description: "Configure provider authentication" },
  { name: "logout", description: "Remove provider authentication" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Compact context with verbatim logical deletions" },
  { name: "resume", description: "Resume a different session" },
  { name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
  { name: "exit", description: `Exit ${APP_NAME}` },
  { name: "quit", description: `Quit ${APP_NAME}` },
];
```

### Pattern 2: Bundled extension slash commands

**Found in**: `packages/coding-agent/src/core/slash-commands.ts:195-213`  
**Used for**: Commands supplied by bundled extensions/workflows/subagents.

```ts
export const BUNDLED_EXTENSION_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
  {
    name: "workflow",
    description: "Run or inspect Atomic workflows. Usage: /workflow <name> [key=value…] | /workflow [list|status|connect|attach|interrupt|kill|pause|resume|inputs|reload] [args]",
    getArgumentCompletions: getBundledWorkflowArgumentCompletions,
  },
  { name: "run", description: "Run a subagent directly: /run agent[output=file] [task] [--bg] [--fork]" },
  { name: "chain", description: "Run agents in sequence: /chain scout task -> planner [--bg] [--fork]" },
  { name: "run-chain", description: "Run a saved chain: /run-chain chainName -- task [--bg] [--fork]" },
  { name: "parallel", description: "Run agents in parallel: /parallel scout task1 -> reviewer task2 [--bg] [--fork]" },
  { name: "subagents-doctor", description: "Show subagent diagnostics" },
  { name: "mcp", description: "Show MCP server status" },
  { name: "mcp-auth", description: "Authenticate with an MCP server (OAuth)" },
  { name: "curator", description: "Toggle or configure the search curator workflow" },
  { name: "google-account", description: "Show the active Google account for Gemini Web" },
  { name: "search", description: "Browse stored web search results" },
  { name: "websearch", description: "Open web search curator" },
  { name: "intercom", description: "Open session intercom overlay" },
];
```

### Pattern 3: Interactive slash command dispatch

**Found in**: `packages/coding-agent/src/modes/interactive/interactive-input-handling.ts:267-379`  
**Used for**: Handling built-in interactive commands before normal prompt submission.

```ts
// Handle commands
if (text === "/settings") {
  this.showSettingsSelector();
  this.editor.setText("");
  return;
}
if (text === "/fast") {
  this.editor.setText("");
  this.showFastModeSelector();
  return;
}
if (text === "/scoped-models") {
  this.editor.setText("");
  await this.ensureDeferredStartupComplete();
  await this.showModelsSelector();
  return;
}
if (text === "/model" || text.startsWith("/model ")) {
  const searchTerm = text.startsWith("/model ")
    ? text.slice(7).trim()
    : undefined;
  this.editor.setText("");
  await this.ensureDeferredStartupComplete();
  await this.handleModelCommand(searchTerm);
  return;
}
if (text === "/export" || text.startsWith("/export ")) {
  await this.handleExportCommand(text);
  this.editor.setText("");
  return;
}
if (text === "/import" || text.startsWith("/import ")) {
  await this.handleImportCommand(text);
  this.editor.setText("");
  return;
}
```

### Pattern 4: Slash command argument parser for path commands

**Found in**: `packages/coding-agent/src/modes/interactive/interactive-slash-commands.ts:119-146`  
**Used for**: `/export` and `/import` path argument parsing, including quoted paths.

```ts
InteractiveModeBase.prototype.getPathCommandArgument = function(this: InteractiveModeBase, text: string, command: "/export" | "/import"): string | undefined {
  if (text === command) {
    return undefined;
  }
  if (!text.startsWith(`${command} `)) {
    return undefined;
  }

  const argsString = text.slice(command.length + 1).trimStart();
  if (!argsString) {
    return undefined;
  }
  const firstChar = argsString[0];
  if (firstChar === '"' || firstChar === "'") {
    const closingQuoteIndex = argsString.indexOf(firstChar, 1);
    if (closingQuoteIndex < 0) {
      return undefined;
    }
    return argsString.slice(1, closingQuoteIndex);
  }

  const firstWhitespaceIndex = argsString.search(/\s/);
  if (firstWhitespaceIndex < 0) {
    return argsString;
  }
  return argsString.slice(0, firstWhitespaceIndex);
};
```

### Pattern 5: `/compact` validation before handler call

**Found in**: `packages/coding-agent/src/modes/interactive/interactive-input-handling.ts:373-380`  
**Used for**: Slash command with no arguments.

```ts
if (/^\/compact(?:\s|$)/.test(text)) {
  this.editor.setText("");
  if (text !== "/compact") {
    this.showWarning("Usage: /compact");
    return;
  }
  await this.handleCompactCommand();
  return;
}
```

---

## Pattern Examples: UI Render Invalidation / `requestRender` Usage

### Pattern 1: Docs for invalidate + requestRender

**Found in**: `packages/coding-agent/docs/tui.md:479-483`  
**Used for**: Guidance on cache invalidation and requesting repaint.

```md
Call `invalidate()` when state changes, then `ctx.ui.requestRender()` from the extension context or `tui.requestRender()` from a `ctx.ui.custom()` factory to trigger re-render.

## Invalidation and Theme Changes

When the theme changes, the TUI calls `invalidate()` on all components to clear their caches. Components must properly implement `invalidate()` to ensure theme changes take effect.
```

### Pattern 2: Component invalidate method clears cached render state

**Found in**: `packages/coding-agent/docs/tui.md:358-361`  
**Used for**: Component-level cache invalidation.

```ts
invalidate(): void {
  this.cachedWidth = undefined;
  this.cachedLines = undefined;
}
```

### Pattern 3: Rebuild on invalidate

**Found in**: `packages/coding-agent/docs/tui.md:528-531`  
**Used for**: Components that bake themed content.

```ts
override invalidate(): void {
  super.invalidate();  // Clear child caches
  this.updateDisplay(); // Rebuild with new theme
}
```

### Pattern 4: Request render from input handler

**Found in**: `packages/coding-agent/docs/tui.md:632-635`  
**Used for**: Custom component input handling.

```ts
return {
  render: (w) => container.render(w),
  invalidate: () => container.invalidate(),
  handleInput: (data) => { selectList.handleInput(data); tui.requestRender(); },
};
```

### Pattern 5: Footer data subscription requests render

**Found in**: `packages/coding-agent/docs/tui.md:802-807`  
**Used for**: Reactive footer updates.

```ts
ctx.ui.setFooter((tui, theme, footerData) => ({
  invalidate() {},
  render(width: number): string[] {
    // footerData.getGitBranch(): string | null
    // footerData.getExtensionStatuses(): ReadonlyMap<string, string>
    return [`${ctx.model?.id} (${footerData.getGitBranch() || "no git"})`];
  },
  dispose: footerData.onBranchChange(() => tui.requestRender()), // reactive
}));
```

### Pattern 6: Extension spinner requesting render

**Found in**: `packages/coding-agent/examples/extensions/border-status-editor.ts:89-98`  
**Used for**: Timer-driven UI updates.

```ts
spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
activeTui?.requestRender();
}, 80);
activeTui?.requestRender();
});

pi.on("agent_end", () => {
  stopSpinner();
  activeTui?.requestRender();
});
```

### Pattern 7: Event handler invalidates footer and usage meter

**Found in**: `packages/coding-agent/src/modes/interactive/interactive-agent-events.ts:70-90`  
**Used for**: Session/model/context events updating UI.

```ts
case "session_info_changed":
  this.updateTerminalTitle();
  this.footer.invalidate();
  this.ui.requestRender();
  break;

case "thinking_level_changed":
  this.footer.invalidate();
  this.refreshBuiltInHeader();
  this.updateEditorBorderColor();

case "context_window_changed":
  this.footer.invalidate();
  this.usageMeter.invalidate();
  this.ui.requestRender();
```

### Pattern 8: CHANGELOG entry for reactive extension UI rendering

**Found in**: `packages/coding-agent/CHANGELOG.md:972-974`

```md
- Added reactive extension UI rendering via `ExtensionUIContext.requestRender()` so long-lived widgets can repaint without remount flicker.
```

**Related entry**: `packages/coding-agent/CHANGELOG.md:993-995`

```md
- Added `ExtensionUIContext.requestRender()` and a shared reactive widget installer for extensions to mount widgets once, repaint via coalesced render requests, and own timer-based refreshes without remount flicker ([#1150](https://github.com/bastani-inc/atomic/issues/1150)).
```

---

## Pattern Examples: Session File Parsing / Walking

### Pattern 1: Streaming JSONL session parser

**Found in**: `packages/coding-agent/src/core/session-manager-storage.ts:35-78`  
**Used for**: Loading session entries from JSONL without reading entire file at once.

```ts
/** Exported for testing */
export function loadEntriesFromFile(filePath: string): FileEntry[] {
  const resolvedFilePath = normalizePath(filePath);
  if (!existsSync(resolvedFilePath)) return [];

  const entries: FileEntry[] = [];
  const fd = openSync(resolvedFilePath, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
    let pending = "";

    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;

      pending += decoder.write(buffer.subarray(0, bytesRead));
      let lineStart = 0;
      let newlineIndex = pending.indexOf("\n", lineStart);
      while (newlineIndex !== -1) {
        const entry = parseSessionEntryLine(pending.slice(lineStart, newlineIndex));
        if (entry) entries.push(entry);
        lineStart = newlineIndex + 1;
        newlineIndex = pending.indexOf("\n", lineStart);
      }
      pending = pending.slice(lineStart);
    }

    pending += decoder.end();
    const finalEntry = parseSessionEntryLine(pending);
    if (finalEntry) entries.push(finalEntry);
  } finally {
    closeSync(fd);
  }

  // Validate session header
  if (entries.length === 0) return entries;
  const header = entries[0];
  if (header.type !== "session" || !("id" in header) || typeof header.id !== "string") {
    return [];
  }

  return entries;
}
```

### Pattern 2: Tolerant per-line JSON parsing

**Found in**: `packages/coding-agent/src/core/session-manager-storage.ts:26-33`  
**Used for**: Ignoring blank or malformed JSONL lines.

```ts
function parseSessionEntryLine(line: string): FileEntry | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as FileEntry;
  } catch {
    return null;
  }
}
```

### Pattern 3: Header-only session read

**Found in**: `packages/coding-agent/src/core/session-manager-storage.ts:80-124`  
**Used for**: Reading session metadata cheaply for listing/resume filtering.

```ts
export function readSessionHeader(filePath: string): SessionHeader | null {
  try {
    const fd = openSync(filePath, "r");
    try {
      // Read the full first line rather than a fixed 512-byte window so very
      // long headers (e.g. internal workflow headers carrying stage metadata)
      // are not truncated and dropped from listing/resume filtering.
      const decoder = new StringDecoder("utf8");
      // Use a small dedicated header buffer instead of the 1MiB transcript
      // buffer so prefiltering internal sessions during listing stays cheap.
      // The loop still reads in chunks until the first newline (or EOF) so
      // headers larger than one chunk are handled correctly.
      const buffer = Buffer.allocUnsafe(HEADER_READ_BUFFER_SIZE);
      let pending = "";
      let foundNewline = false;
      while (true) {
        const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        pending += decoder.write(buffer.subarray(0, bytesRead));
        const newlineIndex = pending.indexOf("\n");
        if (newlineIndex !== -1) {
          pending = pending.slice(0, newlineIndex);
          foundNewline = true;
          break;
        }
      }
      // Only flush the decoder when we hit EOF without a newline. Once a
      // newline was found, any remaining decoder bytes belong to data after
      // the header line; flushing them would corrupt the parsed header.
      if (!foundNewline) {
        pending += decoder.end();
      }
      const firstLine = pending.split("\n")[0];
      if (!firstLine) return null;
      const header = JSON.parse(firstLine) as Record<string, unknown>;
      if (header.type !== "session" || typeof header.id !== "string") {
        return null;
      }
      return header as unknown as SessionHeader;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}
```

### Pattern 4: Session directory walking/filtering

**Found in**: `packages/coding-agent/src/core/session-manager-storage.ts:141-163`  
**Used for**: Finding newest session matching cwd and internal-session filtering.

```ts
/** Exported for testing */
export function findMostRecentSession(sessionDir: string, cwd?: string, includeInternal = false): string | null {
  const resolvedSessionDir = normalizePath(sessionDir);
  const resolvedCwd = cwd ? resolvePath(cwd) : undefined;
  try {
    const files = readdirSync(resolvedSessionDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(resolvedSessionDir, f))
      .map((path) => ({ path, header: readSessionHeader(path) }))
      .filter(
        (file): file is { path: string; header: SessionHeader } =>
          file.header !== null &&
          (!resolvedCwd || sessionCwdMatches(getSessionHeaderCwd(file.header), resolvedCwd)) &&
          (includeInternal || !isInternalHeader(file.header)),
      )
      .map(({ path }) => ({ path, mtime: statSync(path).mtime }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    return files[0]?.path || null;
  } catch {
    return null;
  }
}
```

---

## Pattern Examples: Usage / Cost Test Helpers

### Pattern 1: Usage helper factory

**Found in**: `packages/coding-agent/test/agent-session-stats.test.ts:13-29`  
**Used for**: Creating `Usage` objects in tests.

```ts
function createUsage(totalTokens: number): Usage {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}
```

### Pattern 2: Assistant message helper with usage

**Found in**: `packages/coding-agent/test/agent-session-stats.test.ts:30-44`  
**Used for**: Creating assistant messages with typed usage for session stats tests.

```ts
function createAssistantMessageWithUsage(text: string, usage: Usage, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: model.provider,
    api: model.api,
    model: model.id,
    usage,
    stopReason: "stop",
    timestamp,
  };
}

function createAssistantMessage(text: string, totalTokens: number, timestamp: number): AssistantMessage {
  return createAssistantMessageWithUsage(text, createUsage(totalTokens), timestamp);
}
```

### Pattern 3: Context compaction stats helper

**Found in**: `packages/coding-agent/test/agent-session-stats.test.ts:55-63`  
**Used for**: Constructing stats objects with token delta and reduction percentage.

```ts
function createContextCompactionStats(tokensBefore: number, tokensAfter: number) {
  return {
    objectsBefore: 1,
    objectsAfter: 1,
    objectsDeleted: 0,
    tokensBefore,
    tokensAfter,
    percentReduction: tokensBefore === 0 ? 0 : ((tokensBefore - tokensAfter) / tokensBefore) * 100,
  };
}
```

### Pattern 4: Compaction mock calculating context tokens from usage

**Found in**: `packages/coding-agent/test/agent-session-auto-compaction-queue-01.suite.ts:41-49`  
**Used for**: Mocking compaction token calculation.

```ts
vi.mock("../src/core/compaction/index.js", () => ({
  calculateContextTokens: (usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens?: number;
  }) => usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
```

### Pattern 5: Test helper walking backwards for latest usable assistant usage

**Found in**: `packages/coding-agent/test/agent-session-auto-compaction-queue-01.suite.ts:57-73`  
**Used for**: Mocking `estimateContextTokens`.

```ts
estimateContextTokens: (
  messages: Array<{
    role: string;
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens?: number };
    stopReason?: string;
  }>,
) => {
  // Walk backwards to find last non-error, non-aborted assistant with usage
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.stopReason !== "error" && msg.stopReason !== "aborted" && msg.usage) {
      const tokens =
        msg.usage.totalTokens ?? msg.usage.input + msg.usage.output + msg.usage.cacheRead + msg.usage.cacheWrite;
      return { tokens, usageTokens: tokens, trailingTokens: 0, lastUsageIndex: i };
    }
  }
  return { tokens: 0, usageTokens: 0, trailingTokens: 0, lastUsageIndex: null };
},
```

### Pattern 6: Inline usage object shape in tests

**Found in**: `test/unit/chat-message-renderer.test.ts:20-27`  
**Used for**: Minimal zero-cost usage object in Bun tests.

```ts
usage: {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
},
```

---

## Pattern Examples: `bun:test` + `node:assert/strict` Tests

### Pattern 1: Bun test imports with strict assert

**Found in**: `test/unit/chat-message-renderer.test.ts:1-2`  
**Used for**: Bun-native unit tests.

```ts
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
```

### Pattern 2: Bun test with `assert.equal` / `assert.deepEqual`

**Found in**: `test/unit/chat-message-renderer.test.ts:41-48`  
**Used for**: Structural assertions without Vitest `expect`.

```ts
const entries = chatEntriesFromAgentMessages(messages);
const toolEntry = entries.find((entry) => entry.kind === "tool");

assert.equal(toolEntry?.kind, "tool");
assert.deepEqual(toolEntry.args, { command: "echo hi" });
assert.equal(toolEntry.result?.content[0]?.type, "text");
assert.equal(toolEntry.result?.isError, false);
```

### Pattern 3: Bun test for live event controller

**Found in**: `test/unit/chat-message-renderer.test.ts:50-86`  
**Used for**: Stateful controller assertions.

```ts
test("live chat controller accumulates assistant deltas and tool results", () => {
  const entries = [] as ReturnType<typeof chatEntriesFromAgentMessages>;
  const live = new LiveChatEntriesController(entries);

  assert.equal(live.applyEvent({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "hel" },
    message: { role: "assistant", content: [] },
  }), true);
  assert.equal(live.applyEvent({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "lo" },
    message: { role: "assistant", content: [] },
  }), true);
  assert.equal(entries[0]?.kind, "assistant");
```

### Pattern 4: Mixed testing style elsewhere: Vitest with `node:assert/strict`

**Found in**: `packages/coding-agent/test/agent-session-copilot-catalog-refresh.test.ts:3-6`  
**Used for**: Vitest test runner plus Node strict assert.

```ts
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai/compat";
```

---

## Pattern Examples: Docs / Changelog Conventions

### Pattern 1: Package CHANGELOG headings and sections

**Found in**: `packages/coding-agent/CHANGELOG.md:561-565`  
**Used for**: Versioned package changelog.

```md
## [0.8.30] - 2026-06-17

### Changed
```

### Pattern 2: CHANGELOG bullet with issue reference

**Found in**: `packages/coding-agent/CHANGELOG.md:993-996`  
**Used for**: Feature notes with issue references.

```md
- Added `ExtensionUIContext.requestRender()` and a shared reactive widget installer for extensions to mount widgets once, repaint via coalesced render requests, and own timer-based refreshes without remount flicker ([#1150](https://github.com/bastani-inc/atomic/issues/1150)).
- Added `/fast` Codex fast mode toggles for chat and workflow-stage sessions, applying OpenAI priority service tier to supported `openai/*` and `openai-codex/*` models only; active supported models now show a visible `fast` indicator after the model name ([#1134](https://github.com/bastani-inc/atomic/issues/1134)).
```

### Pattern 3: CHANGELOG breaking changes section

**Found in**: `packages/coding-agent/CHANGELOG.md:1681-1683`  
**Used for**: Explicit breaking change grouping.

```md
### Breaking Changes
```

### Pattern 4: Docs site changelog MDX `Update` blocks

**Found in**: `packages/coding-agent/docs/changelog.mdx:9-14`  
**Used for**: User-facing docs changelog.

```mdx
- **Synced with upstream Pi 0.80.5.** Atomic's coding-agent package and bundled extensions now depend on `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-tui` through `^0.80.5`.
- **Refreshed runtime dependencies.** The consolidated dependency update also moves `lru-cache` to `11.5.2`, optional `@dbos-inc/dbos-sdk` to `4.23.6`, and native Cargo dependencies `napi`, `napi-derive`, and `tree-sitter` to their latest stable releases.

</Update>
<Update label="June 29, 2026">
```

### Pattern 5: Docs changelog update with tags

**Found in**: `packages/coding-agent/docs/changelog.mdx:29-35`  
**Used for**: Tagged release notes.

```mdx
<Update label="May 25, 2026" tags={["v0.8.14"]}>

## Stable release

- **Synced with upstream Pi patches.** Atomic's coding-agent fork is now aligned with upstream Pi patches since v0.75.4 and bundles Pi libraries at 0.75.5.
- **Bundled workflow docs are current.** The docs now describe Ralph's final PR-preparation phase, deep-research report artifacts, and newer workflow inspection/control actions such as `stages`, `stage`, `transcript`, `send`, `pause`, and `reload`. See [Workflows](/workflows).
```

### Pattern 6: Documentation source-file list convention

**Found in**: `packages/coding-agent/docs/compaction.md:7-17`  
**Used for**: Docs pages linking source files.

```md
**Source files** ([atomic](https://github.com/bastani-inc/atomic)):

- [`packages/coding-agent/src/core/compaction/context-compaction.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/compaction/context-compaction.ts) - Public barrel for Verbatim Compaction types, helpers, tools, and runner exports
- [`packages/coding-agent/src/core/compaction/context-compaction-runner.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/compaction/context-compaction-runner.ts) - Planner loop, strict target gate, auto-compaction fallback ladder, and planner nudge cap
- [`packages/coding-agent/src/core/compaction/context-compaction-critical.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/compaction/context-compaction-critical.ts) - Internal overflow-only critical-pass protected-entry eligibility and prompt guidance
```

### Pattern 7: Development docs testing commands

**Found in**: `packages/coding-agent/docs/development.md:61-70`  
**Used for**: Developer test command documentation.

```md
## Testing

```bash
bun run typecheck                 # Type-check the monorepo
bun run check:file-length         # Enforce the tracked TS/JS/Rust 500-line limit
bun run test:unit                 # Run unit tests
bun run test:integration          # Run integration tests
bun run test:all                  # Run all tests
# Run package Vitest tests
bun --cwd packages/coding-agent run test -- test/specific.test.ts
```
```

---

## Related Files and Directories

- `packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts`
- `test/unit/chat-message-renderer.test.ts`
- `packages/coding-agent/src/core/slash-commands.ts`
- `packages/coding-agent/src/modes/interactive/interactive-input-handling.ts`
- `packages/coding-agent/src/modes/interactive/interactive-slash-commands.ts`
- `packages/coding-agent/src/core/session-manager-storage.ts`
- `packages/coding-agent/test/agent-session-stats.test.ts`
- `packages/coding-agent/test/agent-session-auto-compaction-queue-01.suite.ts`
- `packages/coding-agent/docs/tui.md`
- `packages/coding-agent/docs/extensions.md`
- `packages/coding-agent/docs/sdk.md`
- `packages/coding-agent/docs/compaction.md`
- `packages/coding-agent/docs/changelog.mdx`
- `packages/coding-agent/CHANGELOG.md`