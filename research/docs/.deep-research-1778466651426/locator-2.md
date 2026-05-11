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
  - context-*: evaluation-framework.md, degradation-patterns.md, etc.
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
- **VCS Skills**: ado-* skills hardcode ADO API expectations; gh-* skills hardcode GitHub expectations; sl-* skills hardcode SourceLab API

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

