## Analysis: `.agents/` Bundled Skills Directory — Partition 2

### Files Analysed

1. `.agents/skills/atomic/SKILL.md` — Atomic guide skill (645 lines)
2. `.agents/skills/workflow-creator/SKILL.md` — Workflow authoring skill (806 lines)
3. `.agents/skills/workflow-creator/references/agent-sessions.md` — Per-SDK session API docs (partial)
4. `.agents/skills/workflow-creator/references/getting-started.md` — SDK composition root examples (partial)
5. `.agents/skills/init/SKILL.md` — CLAUDE.md / AGENTS.md generator (140 lines)
6. `.agents/skills/find-skills/SKILL.md` — Skills discovery helper (145 lines)
7. `.agents/skills/skill-creator/SKILL.md` — Skill authoring + eval loop (488 lines)
8. `.agents/skills/research-codebase/SKILL.md` — Parallel codebase research orchestrator (230 lines)
9. `.agents/skills/impeccable/SKILL.md` — Frontend design system skill (header only)
10. `.agents/skills/opentui/SKILL.md` — OpenTUI TUI-dev skill (header only)
11. `skills-lock.json` — Curated skill version manifest (112 lines)
12. `.claude/.mcp.json` — MCP server configuration (20 lines)

---

### Per-File Notes

#### `.agents/skills/atomic/SKILL.md`

- **Role:** The primary Atomic guide skill. When a user invokes `/atomic [args]` inside Claude Code, Copilot, or OpenCode, this skill body is loaded and routes the request to one of five canonical blocks: help menu, overview, example, workflows, what's-new, or free-form Q&A with source-reading fallback.
- **Key symbols:**
    - Argument-routing table at lines 22–30: dispatches on `$ARGUMENTS` literal tokens (`"overview"`, `"example"`, `"workflows"`, `"what's new"`, etc.)
    - Agent-detection table at lines 41–48: probes env vars (`CLAUDECODE=1`, `COPILOT_AGENT_ID`/`COPILOT_ALLOW_ALL`, `OPENCODE_CLIENT`/`OPENCODE_CONFIG*`) to select one of three agents and substitute the `-a <flag>` value throughout all user-visible output.
    - Source-reading fallback (lines 499–546): topic→path routing table mapping user questions to canonical source directories inside `packages/atomic-sdk/src/`, `packages/atomic/src/`, `.agents/skills/`, `.atomic/workflows/`, etc.
    - What's New flow (lines 550–634): reads `CHANGELOG.md`, parses Keep-a-Changelog format, skips pre-releases, renders 3 most recent stable versions.
- **Control flow:** Stateless text-generation skill; no scripts or sub-agent spawning. Activated by the agent runtime's skill-matching mechanism when the user invokes `/atomic`. Substitutes `<agent>`, `<agents-dir>`, `<TODAY>` tokens before rendering. Every block ends with a cross-nudge close pointing at two sibling modes.
- **Data flow:** Reads `CHANGELOG.md` (or `node_modules/@bastani/atomic-sdk/CHANGELOG.md`) for what's-new requests. Reads source files from `packages/` tree for fallback Q&A. All output rendered in the current conversation; no files written.
- **Dependencies:**
    - Hard-wired to three agent CLIs: Claude Code (`CLAUDECODE=1`, `-a claude`, `.claude/agents/`), GitHub Copilot CLI (`COPILOT_AGENT_ID`, `-a copilot`, `.github/agents/`), OpenCode (`OPENCODE_CLIENT`, `-a opencode`, `.opencode/agents/`). These env-var checks and display names are baked into the skill body (lines 41–48).
    - Built-in workflow names (`deep-research-codebase`, `ralph`, `open-claude-design`) are hardcoded throughout the canonical Q&A blocks and overview table.
    - References `@bastani/atomic-sdk` package name only in the source-reading routing table (line 515), not in user-facing prose (per instruction at line 251: "Do not reference `@bastani/atomic-sdk` in user-facing output").
    - `atomic workflow` CLI commands reference the `atomic` binary throughout (lines 150–157, 270–295, 429–454, 477–488).
    - Workflow picker at line 269 shows `atomic workflow -a <agent>`; named invocation at line 272 shows `atomic workflow -n ralph -a <agent>`.

---

#### `.agents/skills/workflow-creator/SKILL.md`

- **Role:** Workflow architect skill. Activated when users want to create, edit, debug, or run Atomic CLI workflows. Handles two journeys: **authoring** (generates `defineWorkflow().run().compile()` TypeScript files) and **running** (dispatches existing workflows by detecting the current agent and calling `atomic workflow -n ...`).
- **Key symbols:**
    - `defineWorkflow({name, source, description, inputs}).for(agent).run(callback).compile()` — the canonical workflow builder chain described throughout, with structural rules at lines 543–552.
    - `ctx.stage(stageOpts, clientOpts, sessionOpts, callback)` — the core session-spawning primitive (lines 98–103, 298–303).
    - `hostLocalWorkflows([wf])` — Mode 1 entry-point hook that responds to `_emit-workflow-meta` and `_atomic-run` sub-commands from the atomic CLI (lines 106–109, 186–189).
    - `runWorkflow({workflow, inputs, detach?, pathToAtomicExecutable?})` — spawns a workflow's tmux session (lines 355–362).
    - `WorkflowPickerPanel` — the interactive picker UI component from `@bastani/atomic-sdk/workflows/components` (lines 363, 480–488).
    - `createRegistry().register(wf)` / `listWorkflows(registry)` / `getWorkflow(registry, agent, name)` — registry primitives (lines 403–420).
    - Mode 1 vs Mode 2 vs combined layout selector at lines 52–62 (table).
    - Reference file lazy-load table at lines 26–38: 12 reference `.md` files loaded on demand from `references/`.
    - Design Advisory Skills table at lines 254–275: maps 13 design concerns to named skills (`prompt-engineer`, `context-fundamentals`, `context-degradation`, etc.).
- **Control flow:** Stateless but directive — instructs the AI to detect `ATOMIC_AGENT` env var (line 621), optionally invoke `create-spec` skill (lines 638–653), scaffold files to `.atomic/workflows/<name>/`, register in `settings.json` (lines 110–189), and run `atomic workflow refresh` to verify (lines 192–197). References `references/*.md` files on demand for specialized sub-topics.
- **Data flow:**
    - Reads `process.env.ATOMIC_AGENT` (`claude` | `copilot` | `opencode`) to determine target agent (line 44).
    - Writes workflow files to `.atomic/workflows/<name>/index.ts` (Mode 1) or `src/workflows/<name>/<agent>.ts` (Mode 2).
    - Reads and writes `.atomic/settings.json` (project) or `~/.atomic/settings.json` (global) for workflow registration.
    - Invokes `atomic workflow refresh` as a shell command to reload metadata from `settings.json`.
    - Session state persisted under `~/.atomic/sessions/<runId>/` via `s.save()` / `atomic workflow read`.
- **Dependencies:**
    - **tmux** — deeply load-bearing. `runWorkflow` spawns "a workflow's tmux session" (line 356). `nextWindow`, `previousWindow`, `gotoOrchestrator` are "pure tmux verbs" operating on "the shared `atomic` tmux socket" (line 361). `MissingDependencyError` explicitly lists `tmux`/`psmux` as required dependencies (line 362). Prerequisites step at line 83 checks "Bun, tmux/psmux, an authenticated agent CLI".
    - **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — provider SDK for `.for("claude")` branch; `s.session.query()` API documented in `references/agent-sessions.md`.
    - **GitHub Copilot SDK** (`@github/copilot-sdk`) — provider SDK for `.for("copilot")` branch.
    - **OpenCode SDK** (`@opencode-ai/sdk`) — provider SDK for `.for("opencode")` branch.
    - **`@bastani/atomic-sdk`** — orchestration SDK; the only package imported in workflow files (lines 8–10, 327–349).
    - **`settings.json`** schema at `https://raw.githubusercontent.com/bastani/atomic/main/assets/settings.schema.json` (line 120).
    - Devcontainer images `ghcr.io/bastani/atomic/<agent>:1` referenced as bundling Bun + tmux + agent CLI (line 83).

---

#### `.agents/skills/workflow-creator/references/agent-sessions.md` (lines 1–80)

- **Role:** Per-SDK session API reference used by `workflow-creator`. Describes how `ctx.stage()` creates isolated agent sessions and how the runtime auto-initializes provider clients.
- **Key symbols:**
    - Claude: `s.session.query(prompt)` — sends text to Claude pane in tmux, verifies delivery, waits for output stabilization. Returns `SessionMessage[]` (line 79).
    - Copilot: `s.session.send({prompt})` (referenced at `SKILL.md:685`).
    - OpenCode: `s.client.session.prompt({sessionID, parts})` (referenced at `SKILL.md:686`).
    - `s.client` — pre-created SDK client (Claude CLI wrapper, Copilot client, or OpenCode client).
    - `s.session` — pre-created session wrapper.
    - `chatFlags` — CLI flag array passed as `clientOpts` (2nd arg), default `["--allow-dangerously-skip-permissions", "--dangerously-skip-permissions"]` (line 43).
    - `readyTimeoutMs` — timeout waiting for TUI readiness, default 30s (line 44).
- **Control flow:** For Claude: runtime starts Claude CLI in a **tmux pane** (line 39), creates a session wrapper bound to the pane, auto-cleans up after callback returns. No manual timeout needed — idle detection watches for the pane prompt to return.
- **Dependencies:** tmux pane lifecycle is the transport layer for Claude sessions (lines 9, 38–40). `@anthropic-ai/claude-agent-sdk` provides the `SessionMessage[]` type.

---

#### `.agents/skills/workflow-creator/references/getting-started.md` (lines 1–80)

- **Role:** Quick-start composition root examples for all three SDK targets.
- **Key symbols:** Import paths table (lines 9–14): `@bastani/atomic-sdk` (root), `@bastani/atomic-sdk/workflows` (authoring), `@bastani/atomic-sdk/workflows/components` (picker), `@bastani/atomic-sdk/errors`.
- **Control flow:** Shows single-workflow and multi-workflow Commander entrypoints calling `runWorkflow({workflow, inputs})`.
- **Dependencies:** `@bastani/atomic-sdk`, `@commander-js/extra-typings`, `@anthropic-ai/claude-agent-sdk`, `@github/copilot-sdk`, `@opencode-ai/sdk`.

---

#### `.agents/skills/init/SKILL.md`

- **Role:** Generates `CLAUDE.md` and `AGENTS.md` files at project root by exploring the codebase using three specialized sub-agents: `codebase-analyzer`, `codebase-locator`, `codebase-pattern-finder`.
- **Key symbols:**
    - Template at lines 71–126: structured markdown with sections for project name, structure, quick reference, commands, environment, progressive disclosure table, universal rules, code quality.
    - LSP detection table at lines 40–54: maps 14 language types to language servers (TypeScript→`typescript-language-server`, Python→`pyright`, Rust→`rust-analyzer`, etc.).
    - Step 4 (lines 58–63): gates on user confirmation before installing any tooling.
- **Control flow:** Six-step procedure — explore manifests → identify attributes → detect LSPs → confirm with user → install (if confirmed) → populate template → write to both `CLAUDE.md` and `AGENTS.md`.
- **Data flow:** Reads package manifests, scans directory structure, runs non-destructive LSP discovery commands, writes two output files at project root with identical content.
- **Dependencies:** None agent-specific. Uses sub-agents for codebase exploration. LSP install commands depend on host tooling. No tmux, Claude SDK, Copilot SDK, or OpenCode SDK dependency. **Agent-agnostic by design** — produces output used by all three agent runtimes.

---

#### `.agents/skills/find-skills/SKILL.md`

- **Role:** Discovery helper that maps user intent to installable skills from the open agent skills ecosystem via `npx skills find [query]` CLI and `https://skills.sh/` leaderboard.
- **Key symbols:**
    - `npx skills find [query]` — search command (line 29).
    - `npx skills add <package>` — install command (line 30).
    - `npx skills add <owner/repo@skill> -g -y` — global non-interactive install (line 106).
    - Quality verification gates at lines 69–76: install count ≥1K, source reputation, GitHub stars ≥100.
- **Control flow:** Six-step procedure — understand need → check leaderboard → run `npx skills find` → verify quality → present options → offer to install.
- **Data flow:** Reads `skills.sh` leaderboard (live web fetch). Installs to global user skill directories via `npx skills add`. No files written inside the project.
- **Dependencies:** `npx skills` CLI (external package manager). No tmux, Claude SDK, Copilot SDK, or OpenCode SDK dependency. **Agent-agnostic** — works with any agent that can run shell commands. Note: uses `npx` despite CLAUDE.md mandating `bun`; this is an external tool invocation for the skills registry, not a project dependency.

---

#### `.agents/skills/skill-creator/SKILL.md`

- **Role:** Full skill development lifecycle: draft → test → eval → iterate → package. Includes quantitative benchmarking via a Python eval framework and description optimization via `scripts/run_loop.py`.
- **Key symbols:**
    - Skill anatomy at lines 78–85: `skill-name/SKILL.md` + optional `scripts/`, `references/`, `assets/` subdirectories.
    - Three-level loading system at lines 90–95: metadata (name+description, always in context), SKILL.md body (in context when triggered), bundled resources (loaded on demand).
    - `evals/evals.json` schema at lines 149–161: `{skill_name, evals: [{id, prompt, expected_output, files, assertions}]}`.
    - Sub-agent spawning pattern at lines 176–188: launches `with-skill` and `baseline` runs in parallel via task agents.
    - `eval-viewer/generate_review.py` at lines 238–249: launches HTML review viewer.
    - `scripts/aggregate_benchmark` at lines 229–234: produces `benchmark.json` and `benchmark.md`.
    - `scripts/run_loop.py` at lines 388–396: description optimization loop with train/test split, up to 5 iterations.
    - `scripts/package_skill` at lines 411–416: packages skill into `.skill` file.
    - YAML frontmatter fields (lines 67–69): `name`, `description` (primary triggering mechanism), `compatibility` (optional).
- **Control flow:** Iterative loop — capture intent → write SKILL.md → run test cases (parallel sub-agents: with-skill + baseline) → grade → aggregate benchmark → launch viewer → read feedback → improve → repeat. Description optimization is a separate loop using `claude -p` subprocess (line 434).
- **Data flow:**
    - Evals written to `evals/evals.json`.
    - Results organized in `<skill-name>-workspace/iteration-<N>/eval-<ID>/with_skill/outputs/` (and `without_skill/` or `old_skill/`).
    - Grading output: `grading.json` per run directory.
    - Benchmark: `benchmark.json` and `benchmark.md` per iteration.
    - Feedback: `feedback.json` downloaded from browser viewer.
    - Optimized description: JSON `best_description` field from `run_loop.py`.
- **Dependencies:**
    - `claude -p` CLI command used in description optimization (line 434) — Claude Code CLI dependency.
    - Python runtime for `scripts/` (eval framework, benchmark aggregation, viewer generation).
    - Subagent capability required for parallel eval runs (Claude.ai fallback documented at lines 422–438).
    - `present_files` tool (optional, line 410).
    - No tmux, Copilot SDK, or OpenCode SDK direct dependency; the description optimization uses `claude -p` specifically.

---

#### `.agents/skills/research-codebase/SKILL.md`

- **Role:** Parallel codebase research orchestrator. Spawns multiple specialized sub-agents concurrently to answer a user research question and synthesizes findings into a dated markdown document under `research/docs/`.
- **Key symbols:**
    - Sub-agent types at lines 41–68: `codebase-locator` (WHERE files live), `codebase-analyzer` (HOW code works), `codebase-pattern-finder` (examples of patterns), `codebase-research-locator` (existing research docs), `codebase-research-analyzer` (extracts insights from docs), `codebase-online-researcher` (external docs via playwright-cli / curl).
    - Research document template at lines 88–170: YAML frontmatter with `date`, `researcher`, `git_commit`, `branch`, `repository`, `topic`, `tags`, `status`; body sections for Summary, Detailed Findings, Code References, Architecture Documentation, Historical Context, Related Research, Open Questions.
    - GitHub permalink generation at lines 172–179: uses `gh repo view --json owner,name` and `git rev-parse`.
    - `$ARGUMENTS` token at line 7 — the user's research question passed in.
    - Prompt engineering gate at lines 17–19: instructs skill to use `prompt-engineer` skill to optimize the research question before proceeding.
- **Control flow:** Seven-step sequence: read mentioned files → decompose question → spawn parallel sub-agents → wait for all to complete → synthesize → generate dated research document → present findings → handle follow-up (append to same doc).
- **Data flow:**
    - Input: `$ARGUMENTS` (research question).
    - Sub-agents write intermediate results; main agent synthesizes.
    - Output: single markdown file in `research/docs/YYYY-MM-DD-<slug>.md` (no other files written per line 229).
    - Web research cached in `research/web/YYYY-MM-DD-<kebab-case-topic>.md` with frontmatter `source_url`, `fetched_at`, `fetch_method`.
    - Follow-up research appends to the same file with updated frontmatter fields.
- **Dependencies:**
    - `playwright-cli` skill (or `bunx @playwright/cli` / `curl`) for online research (line 58).
    - `gh` CLI for GitHub permalinks (line 177).
    - `git` CLI for commit/branch metadata (lines 116–118, 174–176).
    - Sub-agent capability required (codebase-locator, codebase-analyzer, etc.).
    - `prompt-engineer` skill invoked at lines 17–19.
    - No tmux, Claude SDK, Copilot SDK, or OpenCode SDK dependency. **Agent-agnostic** research orchestrator.

---

#### `.agents/skills/impeccable/SKILL.md` (header only, lines 1–40)

- **Role:** Frontend design system skill. Loaded from external source `pbakaus/impeccable` (per `skills-lock.json` line 37). Handles UI design, redesign, visual hierarchy, accessibility, theming, design systems.
- **Key symbols:** Context-gathering gates (line 14): `PRODUCT.md` (required) and `DESIGN.md` (optional). Context loader script: `node .agents/skills/impeccable/scripts/load-context.mjs`.
- **Dependencies:** `node` runtime for `load-context.mjs`. No tmux or agent SDK dependency. **Agent-agnostic** design tool.

---

#### `.agents/skills/opentui/SKILL.md` (header only, lines 1–40)

- **Role:** OpenTUI TUI development skill. Internal skill (`internal: true` in frontmatter, line 7) covering the core imperative API, React reconciler, and Solid reconciler for terminal UI development.
- **Key symbols:** `create-tui` CLI tool for new projects (line 20); `bunx create-tui -t react my-app` (line 21); `renderer.destroy()` for cleanup (line 23).
- **Dependencies:** `bunx create-tui`, OpenTUI runtime. No tmux or agent SDK dependency. **Atomic-specific internal skill** (marked `provider: atomic`, `internal: true`).

---

#### `skills-lock.json`

- **Role:** Version 1 manifest that tracks 18 curated skills with their GitHub source, `sourceType`, path within the source repo, and content hash. Used by the skills sync system to verify and update bundled skills.
- **Key symbols:**
    - `"version": 1` (line 2) — schema version.
    - `"skills"` map (lines 3–111): 18 entries, each with `source` (e.g., `"anthropics/skills"`, `"microsoft/playwright-cli"`), `sourceType` (`"github"` or `"well-known"`), `skillPath` (path within source repo to the `SKILL.md`), and `computedHash` (SHA-256 of skill content).
    - 18 curated skills: `ast-grep`, `bun`, `dev`, `docx`, `find-skills`, `impeccable`, `liteparse`, `opentui`, `pdf`, `playwright-cli`, `pptx`, `ripgrep`, `skill-creator`, `tdd`, `typescript-advanced-types`, `typescript-expert`, `typescript-react-reviewer`, `xlsx`.
    - `"sourceType": "well-known"` — only `bun` uses this type (line 14), meaning it is fetched from a well-known registry endpoint rather than a GitHub path.
    - `"impeccable"` resolves `skillPath` to `.agents/skills/impeccable/SKILL.md` (line 38) — already present in this repo, not a remote-only skill.
    - `"opentui"` resolves `skillPath` to `skill/opentui/SKILL.md` (line 49) in `msmps/opentui-skill`.
- **Data flow:** Read by `packages/atomic/src/services/system/skills.ts` (`installGlobalSkills`) and `packages/atomic/src/services/system/auto-sync.ts` to determine which skills need fetching or updating.
- **Dependencies:** No runtime dependencies. References GitHub repos and hash digests only.

---

#### `.claude/.mcp.json`

- **Role:** MCP (Model Context Protocol) server configuration for Claude Code. Declares two MCP servers available to Claude Code sessions in this project.
- **Key symbols:**
    - `"github-mcp-server"` (lines 3–9): HTTP transport, URL `https://api.githubcopilot.com/mcp`, auth via `Authorization: Bearer ${GH_TOKEN}` header. Uses GitHub Copilot's MCP endpoint.
    - `"azure-devops"` (lines 10–18): stdio transport, command `bunx -y @azure-devops/mcp <your-org>`. Placeholder `<your-org>` indicates this must be configured per-org before use.
- **Control flow:** Loaded by Claude Code at session start. MCP servers are made available as tools during any Claude Code session in this directory.
- **Dependencies:**
    - `GH_TOKEN` environment variable — required for GitHub MCP server.
    - `bunx` — required for Azure DevOps MCP server.
    - Claude Code CLI — the `.claude/` config is Claude-specific. No equivalent config for Copilot or OpenCode is present in the `.agents/` partition scope.

---

### Cross-Cutting Synthesis

The `.agents/skills/` directory implements a **three-tier provider model**. At the top, the `atomic` guide skill (provider: atomic) is the user-facing entry point that routes into either workflows or skills, with agent detection baked in via env-var probing. The `workflow-creator` skill is the deepest dependency on the existing tech stack: it encodes tmux as a structural runtime requirement (every `ctx.stage()` creates a tmux pane; `runWorkflow` spawns a tmux session; `MissingDependencyError` names tmux/psmux explicitly), and it hardwires all three agent SDKs (`@anthropic-ai/claude-agent-sdk`, `@github/copilot-sdk`, `@opencode-ai/sdk`) as peer provider packages selectable via `.for("claude" | "copilot" | "opencode")`. The `research-codebase`, `init`, and `find-skills` skills are **fully agent-agnostic** — they use generic sub-agent spawning, shell commands (`git`, `gh`, `curl`), and produce markdown artifacts with no agent-SDK or tmux dependency. The `skill-creator` skill has a single Claude-specific dependency (`claude -p` for description optimization) but otherwise runs generically. The 18 entries in `skills-lock.json` are almost all sourced from external GitHub repos (`anthropics/skills`, `vercel-labs/skills`, `microsoft/playwright-cli`, etc.), with none directly wiring Claude or Copilot — these curated skills are agent-agnostic third-party tools. The MCP configuration in `.claude/.mcp.json` is Claude Code-exclusive and would need a Copilot- or OpenCode-equivalent if multi-agent MCP support is required.

For the pi-coding-agent rewrite, the primary **extension seams** in this partition are: (1) the agent-detection env-var table in `atomic/SKILL.md` (lines 41–48), which must add `PI_AGENT` or equivalent; (2) the `.for("claude" | "copilot" | "opencode")` provider selector in `workflow-creator/SKILL.md` (lines 684–686), which must be extended with `.for("pi")`; (3) the `agent-sessions.md` reference for the pi-specific `s.session` API; and (4) the `settings.json` `agents` array at workflow-creator line 144, which currently accepts only `"claude"`, `"opencode"`, `"copilot"`. The **architectural inversion** to note: the `workflow-creator` skill models the workflow orchestrator as requiring tmux and agent CLI binaries to exist at session spawn time — removing tmux means the entire `ctx.stage()` → tmux-pane → agent-CLI-TUI pipeline in `agent-sessions.md` must be replaced with a pi-native session transport.

---

### Out-of-Partition References

The following files are referenced by skills in this partition but live outside `.agents/` and must be analyzed in their respective partitions:

- `packages/atomic/src/commands/cli/chat/index.ts:310` — bakes `ATOMIC_AGENT` env var; referenced by `workflow-creator/SKILL.md` line 621.
- `packages/atomic/src/services/system/skills.ts` — `installGlobalSkills()` reads `skills-lock.json` and copies bundled skills to global directories.
- `packages/atomic/src/services/system/auto-sync.ts` — lazy first-run skill sync triggered at startup.
- `packages/atomic/script/build-assets.ts` — bundles `.agents/skills/` into `skills.tar` archive for distribution.
- `packages/atomic-sdk/src/runtime/` — workflow runtime that implements `ctx.stage()` → tmux session lifecycle.
- `packages/atomic-sdk/src/workflows/builtin/` — `ralph`, `deep-research-codebase`, `open-claude-design` built-in workflow implementations.
- `packages/atomic-sdk/src/providers/` — Claude, Copilot, OpenCode adapter implementations behind `.for()`.
- `.atomic/settings.json` (runtime, not checked in) — workflow registry read by `atomic workflow refresh`.
- `assets/settings.schema.json` — JSON schema for `settings.json` `workflows` entries.
- `CHANGELOG.md` — read by `atomic/SKILL.md` What's New flow.

---

This document covers the `.agents/` partition by reading 12 files — 7 full SKILL.md bodies, 2 reference sub-files, the skills-lock manifest, the MCP config, and partial headers of two additional skills — and synthesizes the agent-SDK, tmux, and provider-detection dependencies throughout the skill layer, with precise line references for each concrete claim.
