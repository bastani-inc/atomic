---
date: 2026-02-09 01:38:44 UTC
researcher: Claude Opus 4.6
git_commit: 5b33b79c1b8a4a2131b4640b077b16dd3a9bf352
branch: lavaman131/feature/tui
repository: atomic
topic: "Ralph Loop enhancements - task management, prompt refinement, and loop safety (Issue #163)"
tags:
    [
        research,
        codebase,
        ralph-loop,
        todowrite,
        prompt-engineer,
        feature-list,
        workflow,
        task-management,
    ]
status: complete
last_updated: 2026-02-09
last_updated_by: Claude Opus 4.6
---

# Research: Ralph Loop Enhancements (Issue #163)

## Research Question

Document the current Ralph Loop implementation and all related components to understand what changes are needed for GitHub issue #163's three enhancements:

1. Replace `feature-list.json` task tracking with TodoWrite-style task lists and simplify the `/ralph` API
2. Integrate `prompt-engineer` skill for yolo mode prompt refinement
3. Add completion promise and termination conditions to prompts

## Summary

The Ralph Loop is a graph-based autonomous workflow engine that iterates over features from a JSON file (or runs in freestyle "yolo" mode), delegating implementation to an AI coding agent. It uses a custom `feature-list.json` / `progress.txt` file-based tracking system, completely separate from the existing TodoWrite/task-list TUI infrastructure. The `prompt-engineer` skill exists as a pinned builtin but has no integration with Ralph. The `completion-promise` parameter exists in config types and the CLI but is not wired into the graph execution path; instead, a hardcoded `COMPLETE` keyword check handles yolo termination. Issue #163 proposes unifying these systems.

## Detailed Findings

### 1. Current Ralph Loop Architecture

#### Core Files

| File                                                                                                                                   | Purpose                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| [`src/workflows/ralph/workflow.ts:185`](https://github.com/bastani/atomic/blob/5b33b79/src/workflows/ralph/workflow.ts#L185)           | `createRalphWorkflow()` factory - builds the compiled graph |
| [`src/workflows/ralph/executor.ts:80`](https://github.com/bastani/atomic/blob/5b33b79/src/workflows/ralph/executor.ts#L80)             | `RalphExecutor` class - manages interrupt handling          |
| [`src/workflows/ralph/session.ts:107`](https://github.com/bastani/atomic/blob/5b33b79/src/workflows/ralph/session.ts#L107)             | `RalphSession` interface and persistence functions          |
| [`src/graph/nodes/ralph-nodes.ts:300`](https://github.com/bastani/atomic/blob/5b33b79/src/graph/nodes/ralph-nodes.ts#L300)             | `RalphWorkflowState` and all graph node implementations     |
| [`src/commands/ralph.ts:322`](https://github.com/bastani/atomic/blob/5b33b79/src/commands/ralph.ts#L322)                               | `ralphSetup()` CLI entry point                              |
| [`src/config/ralph.ts:17`](https://github.com/bastani/atomic/blob/5b33b79/src/config/ralph.ts#L17)                                     | `RalphConfig` type and defaults                             |
| [`src/ui/commands/workflow-commands.ts:780`](https://github.com/bastani/atomic/blob/5b33b79/src/ui/commands/workflow-commands.ts#L780) | `createRalphCommand()` - UI slash command handler           |

#### Graph Structure

The workflow graph, assembled at `workflow.ts:212-229`, is:

```
init-session -> LOOP(clear-context -> implement-feature) -> check-completion
```

- **init-session** (`ralph-nodes.ts:1463`): Loads features from JSON, creates session directory, initializes state
- **clear-context** (`nodes.ts:487`): Forces context window summarization
- **implement-feature** (`ralph-nodes.ts:903`): Finds next pending feature, builds prompt
- **check-completion** (`ralph-nodes.ts:100`): Evaluates if all features pass or max iterations reached

Loop exit condition at `workflow.ts:223`: `(state) => !state.shouldContinue`

#### Session Directory Structure

Each run creates `.ralph/sessions/{UUID}/` with:

- `session.json` - serialized `RalphSession`
- `progress.txt` - append-only human-readable log
- `research/feature-list.json` - session-local feature list copy
- `checkpoints/` - graph state checkpoints (`node-001.json`, etc.)
- `logs/agent-calls.jsonl` - NDJSON action log

#### Two Execution Paths

**CLI path** (`src/commands/ralph.ts`): `ralphSetup()` -> `executeGraphWorkflow()` -> creates SDK client, streams graph, displays progress.

**UI path** (`src/ui/commands/workflow-commands.ts`): `/ralph` command parses args, returns `stateUpdate` with `ralphConfig`, chat UI initiates workflow.

### 2. Current feature-list.json System

#### Schema (as used by create-feature-list skill)

The `research/feature-list.json` on disk is a **flat JSON array**:

```json
[
    {
        "category": "functional",
        "description": "Feature description",
        "steps": ["Step 1", "Step 2"],
        "passes": false
    }
]
```

#### Schema (as expected by Ralph graph engine)

The `FeatureListJson` interface at `ralph-nodes.ts:1306-1313` expects a **wrapped format**:

```typescript
interface FeatureListJson {
    features: Array<{
        category: string;
        description: string;
        steps: string[];
        passes: boolean;
    }>;
}
```

`loadFeaturesFromFile()` at `ralph-nodes.ts:1356` accesses `featureList.features`, which would be `undefined` on a flat array. This format mismatch means the current `research/feature-list.json` (flat array with 18 features, all `passes: false`) would fail to load directly via the Ralph graph engine.

#### Internal Representation

Features are converted to `RalphFeature` objects (`session.ts:43-70`):

- Auto-generated IDs: `feat-001`, `feat-002`, etc.
- `name`: first 60 chars of `description`
- `status`: `"pending"` | `"in_progress"` | `"passing"` | `"failing"`
- `acceptanceCriteria`: mapped from `steps`

#### Feature Lifecycle

`pending` -> `in_progress` -> `passing` | `failing`

Managed by:

- `implementFeatureNode` (`ralph-nodes.ts:1022-1031`): marks `in_progress`
- `processFeatureImplementationResult()` (`ralph-nodes.ts:1129-1213`): marks `passing`/`failing`
- `checkCompletionNode` (`ralph-nodes.ts:188-258`): evaluates `features.every(f => f.status === "passing")`

#### progress.txt

Initialized by `initializeProgressFile()` (`ralph-nodes.ts:1381-1400`) with a session header.
Entries appended by `appendProgress()` (`session.ts:526-538`) in format: `[ISO-TIMESTAMP] ✓/✗ feature-name`.

### 3. Current TodoWrite/Task List System

#### SDK Tool

`createTodoWriteTool()` at `src/sdk/tools/todo-write.ts:67` creates a tool definition with:

- Input: `{ todos: TodoItem[] }` where `TodoItem` has `id?`, `content`, `status`, `activeForm`, `blockedBy?`
- Handler: full replacement of the todo list per invocation (not incremental)
- Registered only for Copilot agents (`src/commands/chat.ts:170-172`); Claude SDK has built-in TodoWrite

#### UI Integration

- `TaskListIndicator` component (`src/ui/components/task-list-indicator.tsx:58`): Renders task items with status icons (`◻`/`◉`/`◼`), tree connectors, blocked-by indicators, and overflow count
- Live during streaming: tool.start and tool.complete events update `todoItems` state in `chat.tsx:1537-1540` and `1592-1595`
- Baked into completed messages as `taskItems` (`chat.tsx:1727-1731`)
- Persistent summary panel: `☑ N tasks (X done, Y open) · ctrl+t to hide` (`chat.tsx:3727-3736`)
- Toggle: Ctrl+T (`chat.tsx:2886-2889`)

#### Tool Renderer

`todoWriteToolRenderer` at `src/ui/tools/registry.ts:554-573` renders tool calls in the transcript with `☑` icon and `✓`/`◉`/`□` status prefixes.

#### No Integration with Ralph

The TodoWrite system and Ralph's feature-list.json system are completely independent. Ralph does not invoke TodoWrite, and TodoWrite does not read feature-list.json. The Ralph agent definition at `.opencode/agents/ralph.md:9` has `todowrite: true`, meaning the tool is available but not utilized by the workflow logic.

### 4. Current prompt-engineer Skill

#### Builtin Definition

Pinned builtin at `src/ui/commands/skill-commands.ts:1112-1286`. Command: `/prompt-engineer` (alias: `/prompt`). Cannot be overridden by disk copies (`PINNED_BUILTIN_SKILLS` at line 1731).

#### Workflow

7-step prompt refinement process:

1. Understand requirements
2. Identify applicable techniques (CoT, multishot, chaining, etc.)
3. Load reference files from `.github/skills/prompt-engineer/references/`
4. Design prompt using XML tags template
5. Add quality controls (accuracy, consistency, security)
6. Optimize and test
7. Iterate based on results

#### Reference Materials

Three reference files (identical across 4 agent config dirs):

- `references/core_prompting.md` (119 lines): clarity, system prompts, XML tags
- `references/advanced_patterns.md` (250 lines): CoT, multishot, chaining, long context, extended thinking
- `references/quality_improvement.md` (178 lines): hallucination reduction, consistency, jailbreak mitigation

#### Integration with Ralph

None. The `prompt-engineer` skill is not referenced anywhere in the Ralph workflow, command, or configuration. The `research-codebase` skill references it (`skill-commands.ts:328`), but Ralph does not.

### 5. Current completion-promise Handling

#### Configuration Layer

- `RalphConfig.completionPromise?: string` at `src/config/ralph.ts:34`
- `ralph-loop.local.md` frontmatter: `completion_promise: null`
- `loadRalphConfig()` at `ralph.ts:241-254`: passes `completionPromise` through
- `describeRalphConfig()` at `ralph.ts:264-275`: includes in summary if set

#### CLI Layer

- CLI flag `--completion-promise <text>` at `src/cli.ts:262-263`
- `RalphSetupOptions.completionPromise` at `src/commands/ralph.ts:83`
- **Not wired**: `executeGraphWorkflow()` at `ralph.ts:194-200` does NOT destructure or pass `completionPromise` to the workflow config

#### UI Layer

- No `--completion-promise` flag in `parseRalphArgs()` at `workflow-commands.ts:97-189`
- Not in `CommandContextState.ralphConfig` at `registry.ts:125-132`

#### Graph Execution Layer

The actual yolo completion detection uses a hardcoded approach:

- `YOLO_COMPLETION_INSTRUCTION` at `ralph-nodes.ts:677-688`: `<EXTREMELY_IMPORTANT>` block telling agent to output `COMPLETE`
- `checkYoloCompletion()` at `ralph-nodes.ts:696-698`: regex `/\bCOMPLETE\b/` on agent output
- `processYoloResult()` at `ralph-nodes.ts:1225-1297`: calls `checkYoloCompletion()`, sets `yoloComplete`

The `completionPromise` config field is never consumed by any graph node. The concept exists at the config/CLI level but is not connected to the graph execution.

### 6. /ralph Slash Command API

#### Current Invocation

```
/ralph [PROMPT] [--yolo] [--resume UUID] [--max-iterations N (100)] [--feature-list PATH]
```

Alias: `/loop`

#### Argument Parsing (`parseRalphArgs()` at `workflow-commands.ts:97-189`)

| Flag                    | Type    | Default                      | Description                      |
| ----------------------- | ------- | ---------------------------- | -------------------------------- |
| `--yolo`                | boolean | `false`                      | Freestyle mode (no feature list) |
| `--resume <uuid>`       | string  | `null`                       | Resume previous session          |
| `--max-iterations <n>`  | number  | `100`                        | Max iterations                   |
| `--feature-list <path>` | string  | `research/feature-list.json` | Feature list path                |
| (remaining text)        | string  | `null`                       | User prompt                      |

#### Default Discrepancy for max-iterations

- `parseRalphArgs`: `DEFAULT_MAX_ITERATIONS = 100` (`workflow-commands.ts:61`)
- `RALPH_DEFAULTS.maxIterations`: `0` (unlimited) (`config/ralph.ts:72`)
- `RALPH_CONFIG.maxIterations`: `0` (unlimited) (`config/ralph.ts:105`)

#### Mode Behavior

**Yolo mode**: Requires prompt, no feature list check, appends `YOLO_COMPLETION_INSTRUCTION`, detects `COMPLETE` in output.

**Feature-list mode**: Auto-generates prompt from `implement-feature` skill if feature list exists and no prompt given. Validates feature list file exists.

**Resume mode**: Loads existing session by UUID, converts to workflow state.

### 7. create-feature-list Skill

Defined in triplicate:

- `.claude/commands/create-feature-list.md`
- `.github/skills/create-feature-list/SKILL.md`
- `.opencode/command/create-feature-list.md`

Also as builtin skill in `skill-commands.ts:761`.

**Function**: Reads a spec document (`$ARGUMENTS`), produces `research/feature-list.json` (flat array of `{category, description, steps, passes}`) and empty `research/progress.txt`.

### 8. implement-feature Skill

Defined in triplicate (same directories as create-feature-list).

**Function**: Reads `research/feature-list.json`, picks highest-priority non-passing feature, implements it, sets `passes: true`, writes to `progress.txt`, commits.

Key behaviors:

- Only works on ONE feature per invocation, then STOPS
- Error handling: delegates to debugger agent, adds bug-fix feature at highest priority
- Context window: stops if >60% full
- References `testing-anti-patterns` skill

### 9. Ralph Agent Definition

`.opencode/agents/ralph.md`:

- `mode: primary`
- `model: anthropic/claude-opus-4-5`
- `tools: write, edit, bash, todowrite, lsp, skill` (all true)
- `question: false` (autonomous, no user interaction)

`.opencode/ralph-loop.local.md`:

- Frontmatter: `active: true`, `iteration: 1`, `max_iterations: 0`, `completion_promise: null`
- Body: detailed agent prompt with initialization steps, workflow examples, design principles, important behavioral constraints

## Code References

### Ralph Workflow Core

- `src/workflows/ralph/workflow.ts:185-247` - `createRalphWorkflow()` factory
- `src/workflows/ralph/executor.ts:80-289` - `RalphExecutor` class
- `src/workflows/ralph/session.ts:107-166` - `RalphSession` interface
- `src/workflows/ralph/session.ts:218-241` - `createRalphSession()` factory
- `src/workflows/ralph/session.ts:526-538` - `appendProgress()`

### Graph Nodes

- `src/graph/nodes/ralph-nodes.ts:300-406` - `RalphWorkflowState` interface
- `src/graph/nodes/ralph-nodes.ts:507-555` - `createRalphWorkflowState()` factory
- `src/graph/nodes/ralph-nodes.ts:677-688` - `YOLO_COMPLETION_INSTRUCTION`
- `src/graph/nodes/ralph-nodes.ts:696-698` - `checkYoloCompletion()`
- `src/graph/nodes/ralph-nodes.ts:903-1108` - `implementFeatureNode()`
- `src/graph/nodes/ralph-nodes.ts:1129-1213` - `processFeatureImplementationResult()`
- `src/graph/nodes/ralph-nodes.ts:1225-1297` - `processYoloResult()`
- `src/graph/nodes/ralph-nodes.ts:1306-1313` - `FeatureListJson` interface
- `src/graph/nodes/ralph-nodes.ts:1350-1371` - `loadFeaturesFromFile()`
- `src/graph/nodes/ralph-nodes.ts:1381-1400` - `initializeProgressFile()`
- `src/graph/nodes/ralph-nodes.ts:1463-1583` - `initRalphSessionNode()`

### CLI and Config

- `src/cli.ts:237-286` - Ralph CLI command registration
- `src/commands/ralph.ts:45-89` - `RalphSetupOptions` interface
- `src/commands/ralph.ts:193-311` - `executeGraphWorkflow()`
- `src/config/ralph.ts:17-35` - `RalphConfig` interface
- `src/config/ralph.ts:70-77` - `RALPH_DEFAULTS`
- `src/config/ralph.ts:104-107` - `RALPH_CONFIG`

### UI Commands

- `src/ui/commands/workflow-commands.ts:47-58` - `RalphCommandArgs` interface
- `src/ui/commands/workflow-commands.ts:61` - `DEFAULT_MAX_ITERATIONS = 100`
- `src/ui/commands/workflow-commands.ts:97-189` - `parseRalphArgs()`
- `src/ui/commands/workflow-commands.ts:675-697` - `BUILTIN_WORKFLOW_DEFINITIONS`
- `src/ui/commands/workflow-commands.ts:780-939` - `createRalphCommand()`
- `src/ui/components/workflow-status-bar.tsx:171-252` - `WorkflowStatusBar` component

### TodoWrite System

- `src/sdk/tools/todo-write.ts:53-59` - `TodoItem` interface
- `src/sdk/tools/todo-write.ts:67` - `createTodoWriteTool()` factory
- `src/commands/chat.ts:170-172` - Registration for Copilot
- `src/ui/components/task-list-indicator.tsx:16-21` - `TaskItem` interface
- `src/ui/components/task-list-indicator.tsx:58` - `TaskListIndicator` component
- `src/ui/chat.tsx:1416-1419` - `todoItems` state
- `src/ui/chat.tsx:1537-1540` - Tool start interception
- `src/ui/chat.tsx:2886-2889` - Ctrl+T toggle
- `src/ui/chat.tsx:3727-3736` - Persistent summary panel
- `src/ui/tools/registry.ts:554-573` - `todoWriteToolRenderer`

### Prompt-Engineer Skill

- `src/ui/commands/skill-commands.ts:1112-1286` - Builtin skill definition
- `src/ui/commands/skill-commands.ts:1731-1734` - `PINNED_BUILTIN_SKILLS`
- `.claude/skills/prompt-engineer/SKILL.md` - Disk-based definition
- `.claude/skills/prompt-engineer/references/core_prompting.md` - Core techniques
- `.claude/skills/prompt-engineer/references/advanced_patterns.md` - Advanced patterns
- `.claude/skills/prompt-engineer/references/quality_improvement.md` - Quality controls

### Feature List Skills

- `.claude/commands/create-feature-list.md` - Claude create-feature-list
- `.claude/commands/implement-feature.md` - Claude implement-feature
- `research/feature-list.json` - Current feature list (18 features, flat array)
- `research/progress.txt` - Current progress file (empty)

### Agent Definitions

- `.opencode/agents/ralph.md` - Ralph agent (todowrite: true, skill: true)
- `.opencode/ralph-loop.local.md` - Ralph loop local configuration

## Architecture Documentation

### Dual Task Tracking Systems

The codebase has two independent task tracking mechanisms:

1. **File-based (Ralph-specific)**: `feature-list.json` + `progress.txt` + `session.json`. Used by Ralph workflow nodes and the `create-feature-list`/`implement-feature` skills. Features tracked as `RalphFeature` objects with lifecycle `pending -> in_progress -> passing/failing`.

2. **Tool-based (Generic TUI)**: TodoWrite tool + `TaskListIndicator` component. Used by any agent with the tool enabled. Tasks tracked as `TodoItem` objects with lifecycle `pending -> in_progress -> completed`. Renders in the TUI with status icons and Ctrl+T toggle.

These systems do not interact. The Ralph agent has `todowrite: true` in its agent definition, but the workflow nodes never invoke TodoWrite.

### Completion Detection

Yolo mode termination relies on a hardcoded `COMPLETE` keyword:

- `YOLO_COMPLETION_INSTRUCTION` appends instructions to output `COMPLETE`
- `checkYoloCompletion()` matches `/\bCOMPLETE\b/`
- The `completionPromise` config field exists in types (`RalphConfig.completionPromise`, CLI `--completion-promise`) but is not wired into the graph nodes

### Max Iterations Enforcement

Two independent mechanisms:

1. **Graph builder level** (`graph/builder.ts:536`): Loop check `currentIteration < maxIterations`. With default `0`, this becomes `n < 0` which is always false, meaning the builder-level check could exit after iteration 1.
2. **Application level** (`ralph-nodes.ts:122`): `state.maxIterations > 0 && state.iteration >= state.maxIterations`. With `0`, the `0 > 0` check is false, meaning unlimited.

The UI default is `100` (`DEFAULT_MAX_ITERATIONS` at `workflow-commands.ts:61`) while config defaults are `0` (`RALPH_DEFAULTS` and `RALPH_CONFIG`).

### Skill Registration Architecture

Three-tier priority system:

1. **Pinned builtins** (`prompt-engineer`, `testing-anti-patterns`) - embedded in TypeScript, cannot be overridden
2. **Disk-based skills** - discovered from `.claude/skills/`, `.opencode/skills/`, `.github/skills/`, `.atomic/skills/` with priority: project(4) > atomic(3) > user(2) > builtin(1)
3. **Legacy `SKILL_DEFINITIONS`** - metadata-only fallback entries

## Historical Context (from research/)

- `research/docs/2026-02-05-pluggable-workflows-sdk-design.md` - Pluggable workflows SDK design
- `research/docs/2026-02-02-atomic-builtin-workflows-research.md` - Built-in workflows research
- `research/docs/2026-02-01-chat-tui-parity-implementation.md` - Chat TUI parity (includes TodoWrite)
- `research/docs/2026-01-31-atomic-current-workflow-architecture.md` - Workflow architecture
- `research/docs/2026-01-31-sdk-migration-and-graph-execution.md` - SDK migration and graph execution
- `research/docs/2026-01-31-graph-execution-pattern-design.md` - Graph execution pattern design
- `research/docs/2026-01-19-slash-commands.md` - Slash commands research

## Related Research

- `research/docs/2026-02-08-skill-loading-from-configs-and-ui.md` - Skill loading system
- `research/docs/2026-02-08-command-required-args-validation.md` - Command validation

## Open Questions

1. **Format mismatch**: The current `research/feature-list.json` is a flat array, but `loadFeaturesFromFile()` expects `{ features: [...] }`. How is this reconciled in practice?

2. **Max iterations default discrepancy**: The UI defaults to 100 (`DEFAULT_MAX_ITERATIONS`) while config defaults to 0 (unlimited). Which should be the canonical default after the changes?

3. **Builder-level max iterations bug**: When `maxIterations: 0` is passed to the graph builder's `.loop()`, the condition `currentIteration < 0` is always false, which would exit the loop immediately. How is this handled in practice?

4. **Executor placeholder**: `RalphExecutor.run()` at `executor.ts:256-262` returns a placeholder result without actually invoking graph execution. Is the actual invocation handled elsewhere, or is this a WIP?

5. **TodoWrite tool replacement semantics**: TodoWrite does full replacement per invocation (not incremental merge). If Ralph transitions to TodoWrite, how should feature state be managed across iterations where context windows are cleared?

6. **progress.txt auto-creation**: Issue #163 says "progress.txt should be auto-created in the `.ralph` folder." Currently it is created in `.ralph/sessions/{id}/progress.txt` by `initializeProgressFile()`. The skill instructions reference `research/progress.txt`. Which location should be canonical?

7. **Prompt argument handling**: Issue #163 proposes `/ralph "specs/YYYY-MM-DD-progress-bar.md"` for spec mode and `/ralph "PROMPT" --yolo` for yolo mode. Currently the `/ralph` command uses positional text as the prompt, not a spec path. How should spec path vs prompt be differentiated?
