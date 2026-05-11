## Analysis: Partition 6 — Skills / Prompts / Sub-Agents / MCP Loading

### Files Analysed

- `research/designs/workflow-picker-tui.tsx`
- `research/designs/session-graph-tui.tsx`
- `research/designs/tsconfig.json`
- `research/docs/2026-02-08-skill-loading-from-configs-and-ui.md`
- `research/docs/2026-02-25-skills-directory-structure.md`

---

### Per-File Notes

#### `research/designs/workflow-picker-tui.tsx`

- **Role:** OpenTUI React prototype demonstrating a two-phase, agent-scoped telescope-style workflow picker TUI with fuzzy matching, structured argument forms, and a confirm-before-run modal.
- **Key symbols:**
  - `AgentType` (`workflow-picker-tui.tsx:89`) — union `"claude" | "copilot" | "opencode"`, the three supported agent backends; the picker is pinned to one agent per session via the `-a` CLI flag parsed at `workflow-picker-tui.tsx:255–279`.
  - `Workflow` / `WorkflowInput` (`workflow-picker-tui.tsx:99–115`) — core data shapes; `Workflow.source` is `"local" | "global" | "builtin"` mapping to `.atomic/workflows`, `~/.atomic/workflows`, and built-in respectively; `WorkflowInput.type` is `"text" | "string" | "enum"`.
  - `fuzzyMatch()` (`workflow-picker-tui.tsx:307–326`) — subsequence scoring: 0 for empty query, adjacent-character bonus (score 1), gap penalty (score 4 + gap distance).
  - `buildEntries()` (`workflow-picker-tui.tsx:341–378`) — filters workflows by active agent (`wf.agents.includes(agent)`), scores against name (primary) and description (+2 penalty), returns flat sorted list on non-empty query or source-grouped list on empty query.
  - `buildRows()` (`workflow-picker-tui.tsx:380–395`) — inserts `kind:"section"` separator rows for the source groups when query is empty.
  - `DEFAULT_PROMPT_INPUT` (`workflow-picker-tui.tsx:119–125`) — fallback `WorkflowInput` used for free-form (no `inputs`) workflows; keeps form renderer uniform.
  - `isFieldValid()` (`workflow-picker-tui.tsx:1262–1266`) — required-field guard: optional fields always pass; `enum` requires non-empty; `text`/`string` require non-whitespace-only value.
  - `WorkflowPicker` (`workflow-picker-tui.tsx:1270`) — root React component; manages `phase` (`"pick" | "prompt"`), `query`, `entryIdx`, `fieldValues`, `focusedFieldIdx`, `confirmOpen`, and a 530ms blinking `cursorTick`.
  - `ConfirmModal` (`workflow-picker-tui.tsx:1011`) — absolute-positioned overlay showing the composed shell invocation (`atomic workflow <name> -a <agent> [--field="val" ...]`); `y`/`return` triggers `renderer.destroy()` (prototype) or the real `runWorkflow()` hook (`TODO(prod)` comment at `workflow-picker-tui.tsx:1349`).
  - Source-color and source-dir maps (`workflow-picker-tui.tsx:283–296`) — `SOURCE_DIR` maps `local` → `.atomic/workflows`, `global` → `~/.atomic/workflows`, `builtin` → `built-in`; these strings match the `atomic workflow -l` output.
- **Control flow:**
  1. `parseAgentFromArgv()` (`workflow-picker-tui.tsx:255`) reads `-a`/`--agent` from `process.argv` and sets module-level `CURRENT_AGENT`.
  2. `WorkflowPicker` renders. `useKeyboard` at `workflow-picker-tui.tsx:1337` dispatches into three branches: confirm-modal, pick-phase, or prompt-phase.
  3. Pick-phase: alphanumeric chars append to `query`; `↑`/`↓` move `entryIdx`; `return` seeds `fieldValues` (enum fields get `f.default ?? f.values[0]`, others get `""`) and transitions `phase` to `"prompt"`.
  4. Prompt-phase: `tab`/`shift+tab` cycle `focusedFieldIdx`; text/string fields collect typed chars; enum fields cycle `left`/`right`; `ctrl+s` blocks if `invalidFieldIndices.length > 0` (first invalid field is focused instead), otherwise sets `confirmOpen = true`.
  5. Confirm-modal: `y`/`return` → `renderer.destroy()` (prod: `runWorkflow()`); `n`/`escape` closes modal.
- **Data flow:** `WORKFLOWS` (mock) → `buildEntries(query, CURRENT_AGENT)` → `buildRows(entries, query)` → `WorkflowList` (left sidebar) + `Preview` (right pane). Field values live in `fieldValues: Record<string, string>` React state. On confirm, the full invocation is composed inline inside `ConfirmModal` from `workflow`, `agent`, `fields`, and `values`.
- **Dependencies:** `@opentui/core` (`createCliRenderer`), `@opentui/react` (`createRoot`, `useKeyboard`, `useRenderer`), React (`useState`, `useEffect`, `useMemo`).

---

#### `research/designs/session-graph-tui.tsx`

- **Role:** OpenTUI React prototype of the orchestrator session graph pane, rendering a scrollable DAG of tmux-backed agent sessions with live duration timers, pulsing borders, and spatial keyboard navigation.
- **Key symbols:**
  - `Session` (`session-graph-tui.tsx:95–103`) — data shape: `id`, `name`, `status` (`"running" | "complete" | "pending" | "error"`), `duration`, `tmux` (tmux session handle e.g. `"@0"`), `parent` (nullable session id for tree edges), optional `error`.
  - `SESSIONS` (`session-graph-tui.tsx:114–122`) — 7-node mock DAG with parent-child relationships (orchestrator → planner → frontend-writer / backend-writer / reviewer → test-runner, orchestrator → deploy-agent). Session nodes explicitly carry `tmux` session identifiers — this is load-bearing tmux coupling.
  - `computeLayout()` (`session-graph-tui.tsx:150–215`) — pure function: builds parent→children tree from flat `Session[]`, assigns DFS `depth`, computes `rowH` (max node height per depth level), leaf-first column placement with `cursor` accumulation, centers parents over child midpoints. Returns `{ roots, map, rowH, width, height }`.
  - `buildConnector()` (`session-graph-tui.tsx:235–298`) — computes Unicode box-drawing connector text for an edge: straight `│` drop for single in-line children, or a multi-row stem + horizontal bar with junction characters (`╭ ╰ ├ ┤ ┴ ┬ ┼ ─`) for branching.
  - `NodeCard` (`session-graph-tui.tsx:315–376`) — absolute-positioned node box; running nodes pulse border color via `lerpColor(theme.border, theme.warning, sin(pulsePhase))` at `session-graph-tui.tsx:334`; focused node gets status-tinted background via `lerpColor(theme.background, statusColor, 0.12)` at `session-graph-tui.tsx:347`.
  - `navigate()` (`session-graph-tui.tsx:544–573`) — spatial arrow-key navigation: computes `(dx, dy)` from focused node center to each candidate, applies a 3× cross-axis penalty (`Math.abs(dy) + Math.abs(dx) * 3` for horizontal), picks minimum-distance node.
  - `doAttach()` (`session-graph-tui.tsx:535–541`) — shows a flash message `"→ <name> · <tmux>"` in the statusline for 2400ms; in production this is where tmux attach would fire.
  - `SessionGraph` (`session-graph-tui.tsx:470`) — root component; wraps graph canvas in `<scrollbox scrollX scrollY>` and auto-scrolls to keep focused node visible via `sb.scrollTo()` at `session-graph-tui.tsx:630`.
- **Control flow:**
  1. `computeLayout(SESSIONS)` runs once in `useMemo` at `session-graph-tui.tsx:474`.
  2. Two `useEffect` intervals run: pulse phase at 60ms (`session-graph-tui.tsx:492`), and live duration increment at 1000ms for `"running"` nodes (`session-graph-tui.tsx:509`).
  3. Keyboard: arrows/hjkl call `navigate()`; `return` calls `doAttach(focusedId)`; `G` (shift) jumps to deepest-rightmost leaf; `gg` double-tap within 300ms jumps to root; `q`/`escape` destroys renderer.
  4. Auto-scroll `useEffect` at `session-graph-tui.tsx:625` fires on `focusedId` change, centering the focused node.
- **Data flow:** `Session[]` → `computeLayout()` → `LayoutNode[]` + `ConnectorResult[]` → `NodeCard` + `Edge` components rendered in a `<scrollbox>`. Live duration updates flow from `timerSecsRef` (a stable mutable `useMemo` object) → `setDurations()` → `NodeCard.duration` prop.
- **Dependencies:** `@opentui/core` (`createCliRenderer`, `ScrollBoxRenderable`), `@opentui/react` (`createRoot`, `useKeyboard`, `useTerminalDimensions`, `useRenderer`), React (`useState`, `useEffect`, `useMemo`, `useCallback`, `useRef`).

---

#### `research/designs/tsconfig.json`

- **Role:** TypeScript configuration for the design exploration files in `research/designs/`; extends the root `tsconfig.json` and sets `noEmit: true`, covering all `.tsx` files in the directory.
- **Key symbols:** None exported; `"extends": "../../tsconfig.json"` at line 2; `"include": ["**/*.tsx"]` at line 5.
- **Control flow:** Compile-time only — no runtime behavior.
- **Data flow:** None.
- **Dependencies:** Root `../../tsconfig.json` (repo-level).

---

#### `research/docs/2026-02-08-skill-loading-from-configs-and-ui.md`

- **Role:** Research document mapping how skills are discovered, loaded, and rendered across all three agent SDKs, with a gap analysis of what Atomic currently implements vs. what is missing, and a proposed `SkillStatusIndicator` UI component design.
- **Key symbols (source file references documented):**
  - `BUILTIN_SKILLS` — array at `src/ui/commands/skill-commands.ts:70`, 9 hardcoded skills with embedded prompts; `SkillMetadata` and `BuiltinSkill` types at `skill-commands.ts:27–58`.
  - `expandArguments()` — `skill-commands.ts:1548`; replaces `$ARGUMENTS` placeholder.
  - `createBuiltinSkillCommand()` — `skill-commands.ts:1624`; produces `CommandDefinition` with category `"skill"`, calls `context.sendSilentMessage(expandedPrompt)`.
  - `registerSkillCommands()` — `skill-commands.ts:1699`; registers builtins then legacy `SKILL_DEFINITIONS`.
  - `discoverAgentFiles()` / `parseAgentFile()` / `parseMarkdownFrontmatter()` — `agent-commands.ts:1493 / 1519 / 1188`; the pattern Atomic should replicate for disk-based skill discovery.
  - `CommandRegistry` — `registry.ts:209`; category priority at `registry.ts:383`: `workflow(0) > skill(1) > agent(2) > builtin(3) > custom(4)`.
  - `initializeCommandsAsync()` — `commands/index.ts:132–151`; proposed insertion point for `discoverAndRegisterDiskSkills()`.
  - `executeCommand()` — `chat.tsx:1973–2265`; dispatch site where a `SkillStatusIndicator` render should be injected.
  - `StatusIndicator` / `AnimatedStatusIndicator` / `ToolResult` — `tool-result.tsx:76–108 / 53–74 / 256–353`; UI patterns to reuse for skill loading indicator.
  - `initClaudeOptions()` / `createSession()` (Copilot) / `createSession()` (OpenCode) — `src/sdk/init.ts:24–33` / `copilot-client.ts:585–645` / `opencode-client.ts:608–633`.
- **Control flow:** Documents a proposed flow: `initializeCommandsAsync()` → `registerSkillCommands()` (builtins, priority 1) → `discoverAndRegisterDiskSkills()` (disk SKILL.md, priorities 2–4, override via `unregister()` + `register()`). SDK passthrough: Claude via `settingSources: ["project", "user"]` (already present); OpenCode auto-discovers via server; Copilot via `skillDirectories` in `SessionConfig` (currently missing).
- **Data flow:** Discovery paths table (8 paths across project-local, global, builtin scopes) → YAML frontmatter parsing → `CommandDefinition` registration → command dispatch → `sendSilentMessage()` → active agent session.
- **Dependencies:** References `src/ui/commands/skill-commands.ts`, `agent-commands.ts`, `registry.ts`, `commands/index.ts`, `chat.tsx`, `tool-result.tsx`, `src/sdk/init.ts`, `copilot-client.ts`, `opencode-client.ts`, `config-path.ts`, `settings.ts`.

---

#### `research/docs/2026-02-25-skills-directory-structure.md`

- **Role:** Research document providing a complete catalog of all 11 skills (names, locations, sizes, purposes, key features), the multi-platform deployment strategy, the `install.sh` `sync_global_agent_configs` function, the `package.json` `files` field, and the `~/.atomic` directory structure.
- **Key symbols (source file references documented):**
  - `sync_global_agent_configs()` — `install.sh:144–165`; copies `.claude/` → `~/.atomic/.claude/`, `.opencode/` → `~/.atomic/.opencode/`, `.github/` → `~/.atomic/.copilot/`, `.mcp.json` → `~/.atomic/.mcp.json`; then removes `gh-*` and `sl-*` from all three `skills/` subdirectories and removes `.copilot/workflows` and `.copilot/dependabot.yml`.
  - `package.json:22–31` — `files` field: includes `src`, `assets/settings.schema.json`, `.claude`, `.opencode`, `.mcp.json`, `.github/skills`, `.github/agents`, `.github/mcp-config.json`; excludes `.github/workflows` and `.github/dependabot.yml`.
  - 11 skills across `.github/skills/`, `.claude/skills/`, `.opencode/skills/`: `create-spec`, `explain-code`, `frontend-design`, `gh-commit`, `gh-create-pr`, `init`, `prompt-engineer` (with 3 reference files), `research-codebase`, `sl-commit`, `sl-submit-diff`, `testing-anti-patterns`.
  - `.claude/skills/research-codebase/SKILL.md` — the only file with Claude-specific frontmatter: `aliases: [research]`, `argument-hint: "<research-question>"`, `required-arguments: [research-question]`.
  - `~/.atomic/.tmp/opencode-config-merged/skills/` — temporary merged skills directory created by OpenCode config merging.
  - 9 agent markdown files (identical across all three platforms): `codebase-analyzer.md`, `codebase-locator.md`, `codebase-online-researcher.md`, `codebase-pattern-finder.md`, `codebase-research-analyzer.md`, `codebase-research-locator.md`, `debugger.md`, `reviewer.md`, `worker.md`.
- **Control flow:** Documents `install.sh` 8-step flow ending with `sync_global_agent_configs "$DATA_DIR"` at `install.sh:233–234`.
- **Data flow:** npm package → `atomic-config.tar.gz` → extraction to `$DATA_DIR` → `sync_global_agent_configs` copies 3 platform dirs → removes SCM/GitHub-specific artifacts → `~/.atomic/{.claude,.opencode,.copilot}/` each receive 7 skills and 9 agents.
- **Dependencies:** References `install.sh`, `package.json`, `.github/skills/`, `.claude/skills/`, `.opencode/skills/`, `~/.atomic/`.

---

### Cross-Cutting Synthesis

The three design files (`workflow-picker-tui.tsx`, `session-graph-tui.tsx`, `tsconfig.json`) are prototypes exploring two UI surfaces: a two-phase workflow picker (pick → compose → confirm) and a DAG session graph viewer. Both use OpenTUI + React exclusively and introduce no agent-SDK coupling at the component level. The workflow picker does embed the `AgentType` union (`"claude" | "copilot" | "opencode"`) as a first-class concept, and the session graph's `Session.tmux` field exposes direct tmux dependency (the "attach" interaction at `session-graph-tui.tsx:535–541`).

The two research documents document the load-bearing implementation: 11 skills maintained as SKILL.md files in three parallel directories (`.github/skills/`, `.claude/skills/`, `.opencode/skills/`), deployed globally via `install.sh:144–165` to `~/.atomic/{.claude,.opencode,.copilot}/skills/` minus SCM-specific ones. The TUI command layer presents skills as hardcoded `BUILTIN_SKILLS` at `src/ui/commands/skill-commands.ts:70` — disk-based SKILL.md discovery is described as absent and proposed. Sub-agents (9 agents shared across platforms) are the main orchestration primitive used by complex skills like `research-codebase` and `create-spec`.

For the pi-coding-agent rewrite: the three-platform parallel skill structure collapses to one; the `AgentType` union in the picker becomes a single pi target; the tmux `Session.tmux` field in the graph has no pi equivalent without a tmux replacement; and the `BUILTIN_SKILLS` embedding plus the proposed disk-discovery flow are the seam where pi skill loading (via pi's own skill/prompt mechanism) slots in.

---

### Out-of-Partition References

- `src/ui/commands/skill-commands.ts` — Primary skill registration file: `BUILTIN_SKILLS` array, `expandArguments()`, `createBuiltinSkillCommand()`, `registerSkillCommands()` — core load-bearing skill command implementation.
- `src/ui/commands/agent-commands.ts` — Contains `discoverAgentFiles()`, `parseAgentFile()`, `parseMarkdownFrontmatter()`, `shouldAgentOverride()`, `registerAgentCommands()` — the disk-discovery pattern that skill loading should replicate.
- `src/ui/commands/registry.ts` — `CommandRegistry` class, category sort priority; skill commands register here.
- `src/ui/commands/index.ts` — `initializeCommandsAsync()` registration flow; proposed insertion point for disk skill discovery.
- `src/ui/chat.tsx` — `executeCommand()` at line 1973; message bubble rendering at line 982; `LoadingIndicator`, `StreamingBullet` animation patterns.
- `src/ui/components/tool-result.tsx` — `StatusIndicator`, `AnimatedStatusIndicator`, `ToolResult` — UI component patterns to reuse for `SkillStatusIndicator`.
- `src/sdk/init.ts` — `initClaudeOptions()` at line 24–33; `settingSources: ["project"]` Claude skill passthrough.
- `src/sdk/copilot-client.ts` — `createSession()` at line 585–645; missing `skillDirectories` in `SdkSessionConfig`.
- `src/sdk/opencode-client.ts` — `createSession()` at line 608–633; OpenCode auto-discovers skills via server.
- `src/utils/config-path.ts` — `getConfigRoot()` at line 77; installation-aware path resolution.
- `src/utils/settings.ts` — Two-tier settings paths (local `.atomic/settings.json` overrides global `~/.atomic/settings.json`).
- `install.sh` — `sync_global_agent_configs()` at line 144–165; SCM skill exclusion and three-platform skill deployment.
- `package.json` — `files` field at line 22–31; controls which skill/agent directories are published to npm.
- `.github/skills/` — Canonical skill source directory (9/11 skills, most complete set).
- `.claude/skills/` — Claude-specific skill directory; `research-codebase/SKILL.md` has unique `aliases`/`argument-hint`/`required-arguments` frontmatter.
- `.opencode/skills/` — OpenCode-specific skill directory.
- `.agents/skills/` — Shared symlink target; `.claude/skills` is a symlink to `.agents/skills`.
