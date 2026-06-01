# Partition 2 of 12 — Findings

## Scope

`.agents/` (98 files, 30,775 LOC)

## Files in Scope

<!-- Source: codebase-locator sub-agent -->

# Partition 2: Skills Loading Architecture (.agents/ Directory)

## Overview

The `.agents/` directory contains 43 bundled agent skills totaling 397 files. All skills follow the Atomic provider model and are discoverable via YAML frontmatter in `SKILL.md` files. Skills are embedded in the Atomic package and distributed to agent-native skill directories on install/upgrade.

---

## Implementation

### Skills Discovery & Loading

- `.agents/skills/*/SKILL.md` (43 files) — Each skill's entry point with YAML frontmatter (name, description, metadata.provider)
- `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/services/system/skills.ts` — installGlobalSkills() copies bundled skills to global dirs (~/.agents/skills, ~/.claude/skills)
- `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/services/system/auto-sync.ts` — Lazy first-run sync detects version mismatch and installs global skills silently
- `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/script/build-assets.ts` — Bundles .agents/skills into skills.tar archive (lines 46-61); enforces MAX_TARRED_PATH_CHARS=150 limit for Windows compatibility
- `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/script/bundle-configs.ts` — Includes .agents/skills in build output zip

### Skills-Lock Manifest

- `/home/alilavaee/Documents/projects/atomic-pi-rewrite/skills-lock.json` — Version 1 manifest tracking 18 curated skills with source repos, sourceType (github|well-known), skillPath, and SHA256 hash

### Symlink Architecture

- `.claude/skills` → `../.agents/skills` (symlink) — Claude Code agent reads from .claude/skills, which transparently resolves to project's .agents/skills directory
- Installation copies .agents/skills to ~/.agents/skills and ~/.claude/skills independently for provider-native access

---

## Skills by Category

### Git & VCS Integration (6 skills)

- `.agents/skills/ado-commit/SKILL.md` — Azure DevOps conventional commits with work-item linking
- `.agents/skills/ado-create-pr/SKILL.md` — ADO pull requests with reviewers and draft mode
- `.agents/skills/gh-commit/SKILL.md` — GitHub conventional commits
- `.agents/skills/gh-create-pr/SKILL.md` — GitHub pull request creation and updates
- `.agents/skills/sl-commit/SKILL.md` — SourceLab/internal VCS commits
- `.agents/skills/sl-submit-diff/SKILL.md` — SourceLab diff submission

### Code Analysis & Search (5 skills)

- `.agents/skills/ast-grep/SKILL.md` + `references/rule_reference.md` — Structural AST-based code search patterns
- `.agents/skills/research-codebase/SKILL.md` — Codebase exploration and context extraction
- `.agents/skills/ripgrep/SKILL.md` — Text-based regex search guide
- `.agents/skills/find-skills/SKILL.md` — Discover available agent skills
- `.agents/skills/explain-code/SKILL.md` — Code explanation and documentation

### Context Engineering (4 skills, 13 files total)

- `.agents/skills/context-fundamentals/SKILL.md` + `scripts/context_manager.py`, `references/` — Context window basics, attention mechanics, token budgeting
- `.agents/skills/context-compression/SKILL.md` + `references/evaluation-framework.md` — Conversation history summarization and token-per-task optimization
- `.agents/skills/context-degradation/SKILL.md` + `references/` — Diagnosis of lost-in-middle, poisoning, distraction, confusion, clash patterns
- `.agents/skills/context-optimization/SKILL.md` + `references/` — KV-cache, observation masking, context partitioning techniques

### Document Processing (4 skills, 186 files total)

- `.agents/skills/docx/SKILL.md` + `61 files` (Python API, XSD schemas, examples) — Word document creation/editing/extraction with python-docx
- `.agents/skills/pdf/SKILL.md` + `12 files` (Python scripts: form filling, annotation extraction, image conversion)
- `.agents/skills/pptx/SKILL.md` + `59 files` (Python API, XSD schemas, add_slide.py, merge_runs.py, redlining.py)
- `.agents/skills/xlsx/SKILL.md` + `54 files` (Python API, XSD schemas, validation and data manipulation)

### Agent & Workflow Orchestration (5 skills, 32 files total)

- `.agents/skills/atomic/SKILL.md` — Guide to Atomic CLI, workflows, skill chaining, decision-making
- `.agents/skills/workflow-creator/SKILL.md` + `13 files` (reference/, scripts/) — Atomic workflow DSL, defineWorkflow, stage execution, validation
- `.agents/skills/skill-creator/SKILL.md` + `18 files` (eval-viewer/, scripts/) — Skill design patterns, prompt engineering, evaluation pipelines
- `.agents/skills/hosted-agents/SKILL.md` + `3 files` (references/) — Multi-agent deployment and coordination
- `.agents/skills/multi-agent-patterns/SKILL.md` + `scripts/coordination.py` — Multi-agent reasoning and orchestration patterns

### Testing & Evaluation (3 skills, 12 files total)

- `.agents/skills/tdd/SKILL.md` + `6 files` (references/) — Test-driven development with bun.test
- `.agents/skills/evaluation/SKILL.md` + `3 files` — LLM-as-a-Judge basics
- `.agents/skills/advanced-evaluation/SKILL.md` + `6 files` (references/, scripts/evaluation_example.py) — Evaluation rubrics, bias mitigation, pairwise comparison

### Code Generation & Design (5 skills, 100+ files total)

- `.agents/skills/create-spec/SKILL.md` — Create execution specs from research findings
- `.agents/skills/tool-design/SKILL.md` + `4 files` — Tool interface design, prompt templates, error handling
- `.agents/skills/prompt-engineer/SKILL.md` + `4 files` — Prompt optimization, few-shot examples, chain-of-thought
- `.agents/skills/impeccable/SKILL.md` + `59 files` (agents/, reference/, scripts/) — Design system, component patterns, state management (external skill from pbakaus/impeccable)

### UI/Component Libraries (2 skills, 30 files total)

- `.agents/skills/opentui/SKILL.md` + `26 files` (references/) — OpenTUI React component patterns, panes, layouts
- `.agents/skills/typescript-react-reviewer/SKILL.md` + `4 files` — React 19 patterns, TypeScript strict checking in component code

### TypeScript & JavaScript (3 skills, 7 files total)

- `.agents/skills/typescript-expert/SKILL.md` + `5 files` (references/) — Advanced TypeScript patterns, type guards, utility types
- `.agents/skills/typescript-advanced-types/SKILL.md` — Generic constraints, conditional types, mapped types
- `.agents/skills/bun/SKILL.md` — Bun runtime, bundler, test runner (well-known skill)

### Development Tools (3 skills, 15 files total)

- `.agents/skills/playwright-cli/SKILL.md` + `11 files` — Browser automation, screenshot, recording, mocking
- `.agents/skills/liteparse/SKILL.md` — LlamaIndex LlamaParse for document extraction
- `.agents/skills/project-development/SKILL.md` + `4 files` (scripts/pipeline_template.py) — Project setup, CI/CD, monorepo patterns

### Miscellaneous (4 skills, 11 files total)

- `.agents/skills/init/SKILL.md` — Atomic initialization and onboarding
- `.agents/skills/memory-systems/SKILL.md` + `3 files` — Agent memory architectures, session persistence
- `.agents/skills/filesystem-context/SKILL.md` + `scripts/filesystem_context.py` — File system crawling for context
- `.agents/skills/bdi-mental-states/SKILL.md` + `5 files` (references/) — Belief-Desire-Intention agent modeling, RDF transformation

---

## Configuration

### MCP Server Configuration

- `/home/alilavaee/Documents/projects/atomic-pi-rewrite/.claude/.mcp.json` — Defines HTTP (GitHub) and stdio (Azure DevOps) MCP servers; headers carry auth tokens (GH_TOKEN)

### Claude Code Settings

- `/home/alilavaee/Documents/projects/atomic-pi-rewrite/.claude/settings.json` — User-level configuration (content not shown here)
- `.claude/agents/` directory (12 files) — Sub-agent definitions (debugger.md, worker.md, codebase-locator.md, etc.)

### Skills-Lock Manifest

- `.skills-lock.json` — Maps skill names to source repos with version pinning:
    - External sources (anthropics/skills, ast-grep/agent-skill, bun.sh, microsoft/playwright-cli, etc.)
    - Each entry includes SHA256 hash for integrity verification

---

## Documentation

### Skill Frontmatter Metadata

Each SKILL.md uses YAML frontmatter with:

- `name` — Skill identifier (kebab-case)
- `description` — User-facing activation text and use cases
- `metadata.provider` — "atomic" (or external source)
- Optional: `internal: true`, `version`, `mintlify-proj`, `license`

### Reference Materials

- `.agents/skills/*/references/` directories — Knowledge bases for each skill domain
    - ast-grep: rule_reference.md
    - context-\*: evaluation-framework.md, degradation-patterns.md, etc.
    - advanced-evaluation: evaluation-pipeline.md, metrics-guide.md, bias-mitigation.md
    - bdi-mental-states: bdi-ontology-core.md, framework-integration.md, sparql-competency.md, rdf-examples.md
    - impeccable: 20+ design pattern references (design-parser, brand, color-and-contrast, etc.)

### Implementation Guides

- Skill SKILL.md files serve as the primary docs; inline code patterns and activation triggers
- Python skill implementations include docstrings and comments
- OpenTUI and React patterns documented inline in reference markdown

---

## Examples / Fixtures

### Python Skill Scripts

- `.agents/skills/advanced-evaluation/scripts/evaluation_example.py` — Sample LLM-as-judge evaluation
- `.agents/skills/context-fundamentals/scripts/context_manager.py` — Context state tracking
- `.agents/skills/skill-creator/scripts/run_eval.py` — Evaluate skill quality
- `.agents/skills/skill-creator/scripts/aggregate_benchmark.py` — Benchmark aggregation
- `.agents/skills/skill-creator/eval-viewer/generate_review.py` — Generate evaluation reports
- `.agents/skills/pptx/scripts/thumbnail.py`, `add_slide.py`, `merge_runs.py`, `redlining.py`
- `.agents/skills/docx/scripts/base.py`, `api.md`, `validation.md`

### Reference Templates

- `.agents/skills/impeccable/reference/` — 20+ design guides (layout.md, typography.md, forms.md, animation.md, etc.)
- `.agents/skills/workflow-creator/reference/workflow-inputs.md` — Workflow input schema patterns
- `.agents/skills/opentui/reference/` — UI component patterns and best practices

---

## Notable Clusters

### `.agents/skills/` (43 directories, 397 files)

The master skills directory. Each subdirectory is a self-contained skill package with SKILL.md entry point, optional references/ subdirectory for knowledge bases, and optional scripts/ subdirectory for implementation helpers.

### Document Processing Triple (docx, pptx, xlsx, pdf)

- Combined 186 files
- Heavy use of XML Schema (XSD) files for Office Open XML (OOXML) format compliance
- Python-based APIs (python-docx, python-pptx, openpyxl patterns)
- Script examples for form filling, image extraction, validation
- All sourced from anthropics/skills except playwright-cli

### Context Engineering Suite (4 skills, 13 files)

Tightly coupled domain skills covering token budgeting, session management, degradation diagnosis, and optimization. Forms a knowledge pyramid: fundamentals → degradation patterns → compression strategies → optimization techniques.

### Workflow & Agent Cluster (5 skills, 32 files)

Atomic-specific domain: atomic.md (guide), workflow-creator.md (DSL/SDK), skill-creator.md (prompt patterns), hosted-agents.md (deployment), multi-agent-patterns.md (coordination). Defines the orchestration vocabulary and skill composition patterns.

### Impeccable Design System (1 skill, 59 files)

External skill from pbakaus/impeccable. Large collection of design reference docs, not markdown prose. Covers spatial design, interaction design, responsive design, motion, brand, color, typography, forms, containers, state, session management. Minimal code, maximum design guidance.

### Development Tools (3 skills, 15 files)

Support skills for local development: playwright-cli (browser automation), liteparse (document parsing), project-development (CI/CD setup). Python-heavy for file manipulation and template generation.

---

## Dependencies & Coupling

### Load-Bearing Elements

1. **SKILL.md Frontmatter**: Core discovery mechanism. Removing frontmatter breaks skill registration in all agents.
2. **Symlink Relationship (.claude/skills -> ../.agents/skills)**: Enables single-source-of-truth. Moving or removing breaks Claude Code discovery.
3. **skills-lock.json**: Version pinning and integrity verification. Tampering breaks skill updates and source tracking.
4. **installGlobalSkills() in skills.ts**: Copy mechanism to ~/.agents/skills and ~/.claude/skills. Removing prevents global skill access.
5. **build-assets.ts**: Tarball bundling for distribution. Removing breaks binary packaging and install scripts.

### Agent-Agnostic Elements

- Individual SKILL.md files are pure documentation + activation metadata (no code)
- Reference markdown files are purely educational and transferable
- Python script helpers (evaluation_example.py, context_manager.py, etc.) are standalone and reusable

### Agent-Specific Coupling

- **Claude Code Only**: .claude/skills symlink; .claude/.mcp.json
- **Multi-Provider**: Installation targets both ~/.agents/skills (OpenCode, Copilot) and ~/.claude/skills (Claude Code)
- **VCS Skills**: ado-_ skills hardcode ADO API expectations; gh-_ skills hardcode GitHub expectations; sl-\* skills hardcode SourceLab API

### Removable Without Breaking Core

- `impeccable` skill (external, not Atomic-authored)
- Individual skill categories (e.g., all document processing skills) can be removed if not used
- Python implementation scripts in skill directories (referenced by skill but not required for activation)

---

## Architecture Seams for pi-coding-agent Replatforming

### Skill Discovery Seam

**Current**: Atomic reads .claude/skills symlink and SKILL.md frontmatter via Claude Code SDK.
**Replatform Path**: pi-coding-agent can:

1. Read .agents/skills directly (no symlink needed)
2. Parse SKILL.md frontmatter identically (YAML format is agent-agnostic)
3. Register skills without dependency on Claude Code/OpenCode/Copilot SDKs
4. Use skills-lock.json for source attribution and integrity (format is already generic)

### Skills Installation Seam

**Current**: Atomic's installGlobalSkills() copies to ~/.agents/skills + ~/.claude/skills via dual-provider dispatch.
**Replatform Path**: pi-coding-agent can:

1. Consolidate to single global directory (e.g., ~/.pi/skills)
2. Skip provider-specific directory splitting (no need for Claude/OpenCode/Copilot symlinks)
3. Simplify install script from 2-directory copy to 1 copy
4. Store version marker in ~/.pi/.synced-version instead of ~/.atomic/.synced-version

### Skill Reference & Documentation Seam

**Current**: Each skill's references/ directory is pure markdown, discoverable only by user reading SKILL.md.
**Replatform Path**: pi-coding-agent can:

1. Index reference/ directories into a local knowledge base on install
2. Make references searchable via `/help <skill-name>` or inline skill help UI
3. Extract YAML frontmatter into searchable metadata (skill-provider-metadata.json)
4. Build a skill registry JSON file for fast skill lookup without file I/O

### Skill Execution & Prompting Seam

**Current**: Atomic surfaces skills to Claude Code/OpenCode/Copilot via agent SDKs; agents read SKILL.md and inject as prompt context.
**Replatform Path**: pi-coding-agent can:

1. Inject SKILL.md text directly into agent prompts (no SDK needed)
2. Implement skill activation logic as a middleware layer (at-mention parser -> skill lookup -> prompt injection)
3. Decouple skill loading from agent SDK entirely

### Provider-Specific Skills Seam

**Current**: ADO, GitHub, SourceLab VCS skills are hardcoded for specific platforms; skills themselves define provider scope in description text.
**Replatform Path**: pi-coding-agent can:

1. Extend skills with explicit `targetPlatforms: ["github", "ado", "gitlab", "sourclab"]` metadata
2. Filter available skills at runtime based on detected repo platform
3. Implement platform detection as a service module, decoupled from skill loading

### MCP Server Configuration Seam

**Current**: .claude/.mcp.json configured by Atomic; Claude Code SDK loads and connects.
**Replatform Path**: pi-coding-agent can:

1. Read .claude/.mcp.json (format is agent-agnostic TOML/JSON)
2. Load MCP servers independently via stdio/HTTP without Claude Code SDK
3. Move MCP configuration discovery to a separate module (mcp-loader.ts)
4. Store pi-specific MCP config in .pi/.mcp.json, leaving .claude/ untouched for compatibility

---

## Summary

Partition 2 inventory complete. The `.agents/` directory contains a mature, modular skill ecosystem (43 skills, 397 files) that is largely **agent-agnostic**. All skills use a standardized SKILL.md frontmatter format (name, description, provider metadata) and optional reference/ documentation. The primary Atomic-specific coupling points are:

1. **installGlobalSkills()** in packages/atomic/src/services/system/skills.ts (dual-directory copy)
2. **.claude/skills symlink** to ../.agents/skills (provider-specific discovery path)
3. **skills-lock.json** version manifest (transferable, format is generic)
4. **auto-sync.ts** lazy initialization (can be adapted to pi-coding-agent startup)

The skill content itself (SKILL.md, references/, scripts/) is **highly transferable**. A pi-coding-agent replatforming would:

- Keep all 43 SKILL.md files and reference materials as-is
- Reimplement installGlobalSkills() to use pi-specific global directories
- Remove the .claude/skills symlink and read .agents/skills directly
- Adapt skill registration from Claude Code SDK model to a direct frontmatter-parsing model
- Extract MCP configuration loading as an independent module (currently coupled to .claude/.mcp.json)

The skill ecosystem is a **natural extension point** for pi-coding-agent: all skills are already documented, portable, and ready for re-registration under a pi-native skill loading layer.

## How It Works

<!-- Source: codebase-analyzer sub-agent -->

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
    - **`settings.json`** schema at `https://raw.githubusercontent.com/bastani-inc/atomic/main/assets/settings.schema.json` (line 120).
    - Devcontainer images `ghcr.io/bastani-inc/atomic/<agent>:1` referenced as bundling Bun + tmux + agent CLI (line 83).

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

## Patterns

<!-- Source: codebase-pattern-finder sub-agent -->

# Partition 2 Pattern Finder: Skills, Prompts, MCP Loading & Configuration

## Skills Discovery and Loading

### Pattern 1: YAML Frontmatter Skill Metadata

**Where:** `.agents/skills/*/SKILL.md:1-10`
**What:** All skills use YAML frontmatter to declare name, description, and optional metadata fields.

```yaml
---
name: atomic
description: |
    The Atomic guide. Activate whenever the user asks how Atomic works, when to use
    which workflow or skill, how to chain research → spec → implementation, how to
    create custom workflows, how to refine a prompt, how to see available workflows,
    or any "how do I" / "when do I" / decision question about using Atomic.
metadata:
    provider: atomic
---
```

**Variations:**

- `.agents/skills/bun/SKILL.md:1-9` - Includes `version` and `internal: true` flags in metadata
- `.agents/skills/typescript-expert/SKILL.md:1-10` - Marks `internal: true` for excluded skill
- `.agents/skills/tool-design/SKILL.md:1-6` - Includes `provider: atomic` in all bundled skills

### Pattern 2: Global Skills Directory Symlink

**Where:** `.claude/skills -> ../.agents/skills` (symlink)
**What:** Claude Code consumes bundled skills via symlink to the `.agents/skills` directory.

```bash
# .claude/skills is a symlink to .agents/skills
lrwxrwxrwx .claude/skills -> ../.agents/skills

# Results in three identical skill trees:
~/.claude/skills/       (Claude Code)
~/.agents/skills/       (OpenCode + Copilot)
```

**Related:**

- `.agents/` contains 43+ skill directories bundled with Atomic
- Symlink enables single-source-of-truth for all three coding agents
- Skills service: `packages/atomic/src/services/system/skills.ts:35-50`

### Pattern 3: Skills Installation to Global Homes

**Where:** `packages/atomic/src/services/system/skills.ts:35-50`
**What:** At install time, bundled skills are copied to provider-native global skill directories.

```typescript
async function installGlobalSkills(): Promise<void> {
    const src = await getEmbeddedAsset("skills");

    if (!(await pathExists(src))) {
        throw new Error(`Bundled skills missing at ${src}`);
    }

    const home = homeRoot();
    const ignoreFilter = createCommonIgnoreFilter();

    await Promise.all(
        SKILL_DEST_DIRS.map((rel) =>
            copyDir(src, join(home, rel), { ignoreFilter }),
        ),
    );
}
```

**Destinations (SKILL_DEST_DIRS):**

- `~/.agents/skills` (OpenCode + Copilot CLI)
- `~/.claude/skills` (Claude Code)

**Related:** `packages/atomic/src/services/system/skills.ts:27-30`

---

## Skills Lock and Version Management

### Pattern 4: Skills Lock File Registry

**Where:** `skills-lock.json:1-112`
**What:** JSON registry tracks installed skills with source, path, and hash for integrity verification.

```json
{
    "version": 1,
    "skills": {
        "ast-grep": {
            "source": "ast-grep/agent-skill",
            "sourceType": "github",
            "skillPath": "ast-grep/skills/ast-grep/SKILL.md",
            "computedHash": "3bca45167617f547e97454ae16d271ba3aeb2550d89e6ef1942057bd122c0061"
        },
        "bun": {
            "source": "bun.sh",
            "sourceType": "well-known",
            "computedHash": "e81aa6ae97fdbc21cbccdbee38e0f314171fe8d7a09c5fdda72b82095cf4b9fa"
        },
        "impeccable": {
            "source": "pbakaus/impeccable",
            "sourceType": "github",
            "skillPath": ".agents/skills/impeccable/SKILL.md",
            "computedHash": "15ca2efbf646ed89e85f56470d2a6bbe96268134b7e1e2ce9908ecf3d672119c"
        }
    }
}
```

**Variations (sourceType values):**

- `"github"` - GitHub repo references (e.g., `ast-grep/agent-skill`)
- `"well-known"` - Well-known sources (e.g., `bun.sh`)
- Local bundled skills have paths like `.agents/skills/impeccable/SKILL.md`

**Track:** 43+ skills registered with unique hashes for change detection

---

## Agent Discovery and Configuration

### Pattern 5: Multi-Agent Configuration Discovery

**Where:** `packages/atomic/src/services/config/atomic-global-config.ts:44-48`
**What:** Atomic discovers and installs agents into provider-native global config directories.

```typescript
const AGENT_DIR_PAIRS: AgentSyncPair[] = [
    { kind: "claude", dest: ".claude/agents" },
    { kind: "opencode", dest: ".opencode/agents" },
    { kind: "github", dest: ".copilot/agents" },
];
```

**Installation pattern (installGlobalAgents):**

```typescript
export async function installGlobalAgents(): Promise<void> {
    const home = homeRoot();

    for (const { kind, dest } of AGENT_DIR_PAIRS) {
        const src = join(await getEmbeddedAsset(kind), "agents");
        const target = join(home, dest);

        if (!(await pathExists(src))) {
            warnings.push(`bundled agents missing at ${src}`);
            continue;
        }

        await copyDir(src, target, {
            ignoreFilter: createCommonIgnoreFilter(),
        });
    }

    // Copilot's lsp.json renamed to ~/.copilot/lsp-config.json
    const lspSrc = join(await getEmbeddedAsset("github"), "lsp.json");
    const lspDest = join(home, ".copilot", "lsp-config.json");
    if (await pathExists(lspSrc)) {
        await ensureDir(dirname(lspDest));
        await copyFile(lspSrc, lspDest);
    }
}
```

**Related:** `packages/atomic/src/services/config/atomic-global-config.ts:55-87`

### Pattern 6: Agent Definition Files

**Where:** `.claude/agents/*.md` (12 files), `.opencode/agents/*.md` (12 files), `.github/agents/*.md` (12 files)
**What:** YAML frontmatter agents declare name, description, tools, and model selection.

```markdown
---
name: orchestrator
description: Orchestrate sub-agents to accomplish complex long-horizon tasks without losing coherency by delegating to sub-agents.
tools: Bash, Agent, Edit, Grep, Glob, Read, TaskCreate, TaskList, TaskGet, TaskUpdate
model: opus
---

You are a sub-agent orchestrator that has a large number of tools available to you...
```

**Agent inventory:**

- `orchestrator.md` - Dispatches sub-agents for research/codebase tasks
- `planner.md` - Long-horizon planning and orchestration
- `worker.md` - Task implementation
- `reviewer.md` - Code review and quality assessment
- `codebase-analyzer.md` - Codebase understanding
- `codebase-pattern-finder.md` - Pattern discovery
- `debugger.md` - Debugging assistance
- Plus 5 more specialized agents

**Related:** `.claude/agents/`, `.opencode/agents/`, `.github/agents/` (identical files in all three)

---

## MCP Server Configuration and Discovery

### Pattern 7: MCP Server Configuration Files

**Where:** `.claude/.mcp.json:1-20`
**What:** Claude Code MCP configuration defines HTTP and stdio-based MCP servers.

```json
{
    "mcpServers": {
        "github-mcp-server": {
            "type": "http",
            "url": "https://api.githubcopilot.com/mcp",
            "headers": {
                "Authorization": "Bearer ${GH_TOKEN}"
            }
        },
        "azure-devops": {
            "type": "stdio",
            "command": "bunx",
            "args": ["-y", "@azure-devops/mcp", "<your-org>"]
        }
    }
}
```

**Pattern variants:**

- HTTP servers: requires `url` and optional `headers`
- Stdio servers: requires `command` and `args`
- Uses environment variables: `${GH_TOKEN}`
- Both HTTP and stdio patterns for SCM integration

**Related:** `.opencode/opencode.json:3-22`

### Pattern 8: OpenCode MCP Configuration

**Where:** `.opencode/opencode.json:3-22`
**What:** OpenCode uses nested `mcp` object with `type`, `command`/`url`, and `enabled` flags.

```json
{
    "mcp": {
        "azure-devops": {
            "type": "local",
            "command": ["bunx", "-y", "@azure-devops/mcp", "<your-org>"],
            "enabled": false
        },
        "github-mcp-server": {
            "type": "remote",
            "url": "https://api.githubcopilot.com/mcp",
            "enabled": true,
            "headers": {
                "Authorization": "Bearer {env:GH_TOKEN}"
            }
        }
    },
    "permission": "allow",
    "instructions": ["~/.atomic/AGENTS.md"]
}
```

**OpenCode-specific syntax:**

- `type: "local"` vs `"remote"` (instead of `"stdio"` / `"http"`)
- Per-server `enabled: boolean` flag
- Environment variable syntax: `{env:GH_TOKEN}` (not `${...}`)
- Top-level `permission` and `instructions` fields

**Related:** `.opencode/opencode.json` entire file

### Pattern 9: SCM-Driven MCP Server Enable/Disable Sync

**Where:** `packages/atomic-sdk/src/services/config/scm-sync.ts:22-187`
**What:** Atomic automatically enables/disables MCP servers based on selected SCM in `.atomic/settings.json`.

```typescript
const SCM_MCP_SERVERS = ["github-mcp-server", "azure-devops"] as const;
type ScmMcpServer = (typeof SCM_MCP_SERVERS)[number];

function enabledServersFor(scm: ScmProvider): Set<ScmMcpServer> {
    if (scm === "github") return new Set(["github-mcp-server"]);
    if (scm === "azure-devops") return new Set(["azure-devops"]);
    return new Set();
}

// Copilot disable flags derived from scm selection
const COPILOT_DISABLE_BY_SCM: Record<ScmProvider, readonly string[]> = {
    github: ["azure-devops"],
    "azure-devops": ["github-mcp-server"],
    sapling: ["github-mcp-server", "azure-devops"],
};
```

**Sync actions (syncScmMcpServers):**

- Claude: Updates `.claude/settings.json` → `disabledMcpjsonServers` array
- OpenCode: Flips `.opencode/opencode.json` → `mcp.<server>.enabled` flags
- Copilot: Generates CLI flags `--disable-mcp-server <name>`

**Related:** `packages/atomic-sdk/src/services/config/scm-sync.ts:99-160`

---

## Custom Tools and Agent Configuration

### Pattern 10: Claude Settings with MCP Disabling

**Where:** `.claude/settings.json:1-28`
**What:** Claude Code stores global settings including MCP server enable/disable state.

```json
{
    "env": {
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "ENABLE_LSP_TOOL": "1",
        "CLAUDE_CODE_NO_FLICKER": "1"
    },
    "includeCoAuthoredBy": false,
    "skipDangerousModePermissionPrompt": true,
    "permissions": {
        "defaultMode": "bypassPermissions"
    },
    "disabledMcpjsonServers": ["azure-devops"],
    "enabledPlugins": {
        "pyright-lsp@claude-plugins-official": true,
        "typescript-lsp@claude-plugins-official": true,
        "gopls-lsp@claude-plugins-official": true,
        "rust-analyzer-lsp@claude-plugins-official": true
    }
}
```

**Key fields:**

- `disabledMcpjsonServers` - MCP servers to disable (managed by scm-sync)
- `enabledPlugins` - LSP and language support plugins
- `permissions.defaultMode` - Default permission mode for agent actions
- `env` - Environment variables for Claude Code runtime

**Related:** `.claude/settings.json` entire file; scm-sync updates `disabledMcpjsonServers`

---

## Skill-to-Agent Integration Patterns

### Pattern 11: Skill Provider Detection in Multi-Agent Environments

**Where:** `.agents/skills/atomic/SKILL.md:34-52`
**What:** Skills detect which coding agent is running and substitute agent-specific values.

```markdown
## Detect the calling agent

The skill runs inside one of three coding agents. Detect which by reading env
vars in order, then substitute the matching values throughout user-facing
examples. Never list multiple agents' values side-by-side — show only the
detected one.

| Detected           | Env signal                                | `-a` flag     | Display name       | Agents directory    |
| ------------------ | ----------------------------------------- | ------------- | ------------------ | ------------------- |
| Claude Code        | `CLAUDECODE=1`                            | `-a claude`   | Claude Code        | `.claude/agents/`   |
| GitHub Copilot CLI | `COPILOT_AGENT_ID` or `COPILOT_ALLOW_ALL` | `-a copilot`  | GitHub Copilot CLI | `.github/agents/`   |
| OpenCode           | `OPENCODE_CLIENT` or `OPENCODE_CONFIG*`   | `-a opencode` | OpenCode           | `.opencode/agents/` |

Probe with: `printenv | grep -E '^(CLAUDECODE|COPILOT_|OPENCODE_)' | head -20`.
If none match, default to `-a claude` and `Claude Code` as the display name.
```

**Agent-specific substitution pattern:**

- Environment variable signals for each agent
- Skill replaces placeholders like `<agent>` with detected agent name
- Prevents leaking alternate-agent values in user-facing prose

**Related:** `.agents/skills/atomic/SKILL.md:34-52`

### Pattern 12: MCP Tool Naming Conventions

**Where:** `.agents/skills/tool-design/SKILL.md:96-111`
**What:** Skills document that MCP tools require fully qualified names with server prefix.

```markdown
### MCP Tool Naming Requirements

Always use fully qualified tool names with MCP (Model Context Protocol) to avoid
"tool not found" errors.

Format: `ServerName:tool_name`

# Correct: Fully qualified names

"Use the BigQuery:bigquery_schema tool to retrieve table schemas."
"Use the GitHub:create_issue tool to create issues."

# Incorrect: Unqualified names

"Use the bigquery_schema tool..." # May fail with multiple servers

Without the server prefix, agents may fail to locate tools when multiple MCP
servers are available. Establish naming conventions that include server context
in all tool references.
```

**Pattern:** `<ServerName>:<tool_name>` for all MCP tool references in skills

**Related:** `.agents/skills/tool-design/SKILL.md:96-111`

---

## Custom Workflow Loading and Configuration

### Pattern 13: Custom Workflow Entry Discovery

**Where:** `packages/atomic/src/commands/custom-workflows.ts:1-90`
**What:** Atomic discovers custom workflows from `settings.json` `workflows` map entries.

```typescript
export interface LoadCustomWorkflowsResult {
    loaded: LoadedWorkflow[];
    broken: BrokenWorkflow[];
}

export async function loadCustomWorkflows(
    workflows: Record<string, CustomWorkflowEntry> | undefined,
    origin: "local" | "global",
    settingsPath: string,
): Promise<LoadCustomWorkflowsResult> {
    if (!workflows) return { loaded: [], broken: [] };

    const results = await Promise.all(
        Object.entries(workflows).map(([alias, entry]) =>
            loadOne(alias, entry, origin, settingsPath),
        ),
    );

    return {
        loaded: results.flatMap((r) => r.loaded),
        broken: results.flatMap((r) => r.broken),
    };
}
```

**Entry structure (CustomWorkflowEntry):**

- `alias` - Workflow name in `workflows` map
- `command` - Executable command string
- `args[]` - Optional command arguments
- `agents` - Array of supported agent types

**Related:** `packages/atomic/src/commands/custom-workflows.ts:94-138`

### Pattern 14: Workflow Metadata Emission

**Where:** `packages/atomic/src/commands/custom-workflows.ts:120-150`
**What:** Atomic spawns custom workflow commands with `_emit-workflow-meta` flag to extract metadata.

```typescript
async function loadOne(
    alias: string,
    entry: CustomWorkflowEntry,
    origin: "local" | "global",
    settingsPath: string,
): Promise<LoadCustomWorkflowsResult> {
    const loaded: LoadedWorkflow[] = [];
    const broken: BrokenWorkflow[] = [];
    const timeoutMs = resolveTimeoutMs();
    const args = entry.args ?? [];

    const token = randomBytes(16).toString("hex");
    const argv = [
        entry.command,
        ...args,
        "_emit-workflow-meta",
        `--dispatch-token=${token}`,
    ];

    let child: ReturnType<typeof Bun.spawn>;
    try {
        child = Bun.spawn(argv, {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                ...process.env,
                ATOMIC_HOST: "1",
                ATOMIC_DISPATCH_TOKEN: token,
            },
        });
    } catch (err) {
        return fail(
            entry.agents,
            spawnErrorMessage(alias, entry.command, err),
            isNotFoundError(err)
                ? `install "${entry.command}" or use an absolute path`
                : "check file permissions and PATH",
        );
    }

    // Timeout race and output capture...
}
```

**Emission pattern:**

- Command spawned with: `<command> <args...> _emit-workflow-meta --dispatch-token=<hex>`
- Environment: `ATOMIC_HOST=1` + `ATOMIC_DISPATCH_TOKEN=<hex>`
- Captures stdout/stderr with timeout (default 5s)
- Parses JSON metadata from stdout

**Related:** `packages/atomic/src/commands/custom-workflows.ts:52-55`

---

## Session Configuration and Tool/Skill Loading

### Pattern 15: Headless Session Configuration for Skills/Agents

**Where:** `.agents/skills/workflow-creator/references/session-config.md:44-117`
**What:** Workflow sessions configure tools, skills, agents, and MCP servers via SDK options.

```typescript
const result = query({
    prompt: ctx.inputs.prompt ?? "",
    options: {
        // Model selection
        model: "claude-opus-4-6",
        effort: "high",
        thinking: { type: "adaptive" },

        // Tools — base set of available built-in tools
        tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
        allowedTools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
        disallowedTools: ["AskUserQuestion"],

        // Skills — preload named skills into the headless session (v0.2.120+)
        skills: ["my-skill"], // or "all" to preload every available skill

        // Agents — Record<string, AgentDefinition> keyed by name
        agents: {
            worker: {
                description: "Implement tasks",
                prompt: "You are a task implementer...",
                tools: ["Read", "Write", "Edit", "Bash"],
            },
        },
        agent: "worker", // Main thread agent name (optional)

        // MCP servers
        mcpServers: {
            "my-server": { command: "node", args: ["server.js"] },
        },

        // System prompt
        systemPrompt: "You are a senior security auditor...",
        // Or: { type: "preset", preset: "claude_code", append: "Always explain your reasoning." }
    },
});
```

**Key configuration groups:**

- `tools` / `allowedTools` / `disallowedTools` - Control available tools
- `skills` - Preload named skills or "all"
- `agents` - Define sub-agents with their own tools/prompts
- `mcpServers` - Runtime MCP server definitions
- `systemPrompt` - Custom or preset system prompts

**Related:** `.agents/skills/workflow-creator/references/session-config.md:60-116`

---

## Bundled Skills Structure and Progressive Disclosure

### Pattern 16: Skill Progressive Disclosure with References

**Where:** `.agents/skills/skill-creator/SKILL.md:77-95`
**What:** Skills use three-level progressive disclosure: metadata → body → bundled resources.

```markdown
#### Anatomy of a Skill

skill-name/
├── SKILL.md (required)
│ ├── YAML frontmatter (name, description required)
│ └── Markdown instructions
└── Bundled Resources (optional)
├── scripts/ - Executable code for deterministic/repetitive tasks
├── references/ - Docs loaded into context as needed
└── assets/ - Files used in output (templates, icons, fonts)

#### Progressive Disclosure

Skills use a three-level loading system:

1. **Metadata** (name + description) - Always in context (~100 words)
2. **SKILL.md body** - In context whenever skill triggers (<500 lines ideal)
3. **Bundled resources** - As needed (unlimited, scripts can execute without loading)
```

**Directory patterns across bundled skills:**

- `docx/scripts/`, `pptx/scripts/`, `advanced-evaluation/scripts/`, etc.
- `references/` subdirs for large reference docs (context-fundamentals, filesystem-context, etc.)
- Assets and templates for document generation skills

**Related:** `.agents/skills/skill-creator/SKILL.md:75-112`

---

## Summary

Atomic's partition 2 (`.agents/`) contains **43+ bundled skills** and their supporting infrastructure. Key patterns identified:

1. **Skill Discovery**: YAML frontmatter in SKILL.md files; global symlink `.claude/skills -> ../.agents/skills`
2. **Installation**: `installGlobalSkills()` copies bundled skills to `~/.agents/skills` and `~/.claude/skills`
3. **Versioning**: `skills-lock.json` tracks source, path, and SHA-256 hash per skill
4. **Agent Config**: Three agent directories (`.claude/agents`, `.opencode/agents`, `.github/agents`) copied to provider homes
5. **MCP Discovery**: `.mcp.json` (Claude) and `.opencode/opencode.json` define server endpoints
6. **SCM Sync**: `scm-sync.ts` auto-enables/disables MCP servers based on selected version control
7. **Skill-Agent Bridge**: Skills detect calling agent via env vars; substitute agent-specific values
8. **Custom Workflows**: Loaded via `_emit-workflow-meta` spawning; metadata extracted from stdout
9. **Session Config**: Skills/agents preloaded via SDK `options` (tools, agents, mcpServers)
10. **Progressive Disclosure**: Skills load metadata → body → resources on-demand for context efficiency

**Clear seams for pi-coding-agent replacement:**

- MCP server definition loading (scm-sync, .mcp.json parsing)
- Custom agent definition discovery (.claude/agents, .opencode/agents, .github/agents)
- Skill metadata registry (skills-lock.json, YAML frontmatter parsing)
- Custom workflow spawning and metadata emission (\_emit-workflow-meta)
- Skills installation (installGlobalSkills, copyDir patterns)

## Out-of-Partition References

Look for the **Out-of-Partition References** subsection inside the
"How It Works" section above — that is where the analyzer flagged files
outside this partition that other partitions should examine.
