## Partition 31: Subagent agent and chain discovery, builtin markdown agents, and skill loading

### Locator
## 1. Must-read paths

- `packages/subagents/src/agents/agents.ts` — main discovery pipeline for builtin/user/project agents and chains.
- `packages/subagents/src/agents/agent-management.ts` — create/update/delete/list flows for agents and chains.
- `packages/subagents/skills/subagent/SKILL.md` — canonical operator guide for `/run`, `/chain`, `/run-chain`, agent/chain scope, and orchestration patterns.
- `packages/subagents/agents/*.md` — builtin markdown agents (`codebase-locator`, `debugger`, etc.); these are the shipped agent definitions.
- `packages/subagents/src/agents/skills.ts` — subagent-side skill resolution/caching and builtin skill discovery.
- `packages/coding-agent/src/core/skills.ts` — core skill loader + prompt formatter (`SKILL.md` parsing, discovery, collision rules).
- `packages/coding-agent/src/core/resource-loader.ts` — where skills are actually loaded into the runtime alongside extensions/prompts/themes.
- `test/unit/subagents-skills.test.ts` and `test/unit/subagents-skills-npm-probe.test.ts` — verify discovery/precedence and builtin skill exclusion rules.
- `packages/coding-agent/test/skills.test.ts` — verifies `SKILL.md` parsing, validation, recursion, and prompt formatting.

## 2. Supporting paths

- `packages/subagents/src/agents/chain-serializer.ts` — parses/saves `.chain.md` and `.chain.json`.
- `packages/subagents/src/agents/agent-serializer.ts` — parses/saves agent markdown frontmatter.
- `packages/subagents/src/agents/frontmatter.ts` — frontmatter parsing used by agent files.
- `packages/subagents/src/agents/identity.ts` — runtime naming (`package.name`) for agents/chains.
- `packages/subagents/src/slash/slash-commands.ts` — `/chain` and `/run-chain` command wiring.
- `packages/coding-agent/test/package-manager.test.ts` — broader discovery tests for `.agents`, `skills`, and package-based resources.
- `packages/coding-agent/test/resource-loader.test.ts` — integration point for loaded skills in the runtime.

## 3. Entry points / symbols

- `discoverAgents(cwd, scope)` and `discoverAgentsAll(cwd)` in `packages/subagents/src/agents/agents.ts`
- `loadAgentsFromDir(dir, source)` in `packages/subagents/src/agents/agents.ts`
- `loadChainsFromDir(dir, source)` in `packages/subagents/src/agents/agents.ts`
- `parseChain(...)` / `parseJsonChain(...)` in `packages/subagents/src/agents/chain-serializer.ts`
- `create/update/delete/list` logic in `packages/subagents/src/agents/agent-management.ts`
- `loadSkills(...)`, `loadSkillsFromDir(...)`, `formatSkillsForPrompt(...)` in `packages/coding-agent/src/core/skills.ts`
- `buildSkillPaths(...)`, `collectFilesystemSkills(...)`, `collectBuiltinPackageSkillPaths(...)` in `packages/subagents/src/agents/skills.ts`
- `discoverAvailableSkills(cwd)` in `packages/subagents/src/agents/skills.ts`
- `loadSkillsFromDirInternal(...)` and `loadSkillFromFile(...)` in `packages/coding-agent/src/core/skills.ts`
- `buildSkillInjection(skills)` in `packages/subagents/src/agents/skills.ts`
- `subagent` skill docs in `packages/subagents/skills/subagent/SKILL.md`

## 4. Gaps or uncertainty

- I verified builtin agent markdown files exist under `packages/subagents/agents/`, but I did not open each one to inventory exact names/content.
- The chain/agent discovery precedence is clearly implemented, but the exact user-facing CLI commands that expose every path should be confirmed in `slash-commands.ts` if you need migration parity.
- `packages/subagents/src/agents/skills.ts` appears to support package-based skill discovery (`pi.skills` in package.json, settings-based package roots), but I only traced the loader logic, not every supported config surface.
- For Rust migration, the biggest unknown remains whether you want to preserve markdown agent/skill authoring verbatim or replace it with a new plugin format.

### Pattern Finder
## 1. Established patterns

- **Agents and chains are file-driven markdown resources.**  
  `packages/subagents/src/agents/agents.ts` scans `packages/subagents/agents/*.md` and `*.chain.md|json` via `loadAgentsFromDir()` / `loadChainsFromDir()`, parses frontmatter, then converts each file into runtime configs (`AgentConfig`, `ChainConfig`).

- **Builtin agents are just markdown files in a dedicated directory.**  
  `BUILTIN_AGENTS_DIR` points at `packages/subagents/agents`, and builtin discovery uses the same parser as user/project agents. That means “builtin” is a source label, not a separate format.

- **Naming is normalized through runtime/package identity helpers.**  
  Both agents and chains run through `parsePackageName()` + `buildRuntimeName()` so names can be namespaced without changing the underlying file layout.

- **Skill loading is layered and source-prioritized.**  
  `packages/subagents/src/agents/skills.ts` builds a search list from:
  - project `.agents/skills` / `settings.json`
  - user `~/.agents/skills` / `settings.json`
  - package `pi.skills`/`skills`
  - builtin packages  
  Then it dedupes by name with a `SOURCE_PRIORITY` table.

- **Skills are injected as prompt text, not executed code.**  
  `buildSkillInjection()` wraps each skill in `<skill name="...">...</skill>` XML.  
  `packages/coding-agent/src/core/skills.ts` does the same for the core system prompt via `formatSkillsForPrompt()`.

- **Missing skills are non-fatal.**  
  The subagents flow logs warnings and continues; `resolveSkills()` returns `{ resolved, missing }`, and callers surface warnings instead of failing the run.

## 2. Variations / exceptions

- **`.chain.md` is a special markdown dialect.**  
  `chain-serializer.ts` parses `## agent-name` sections plus inline step config (`output`, `reads`, `skills`, etc.). It rejects some inline forms, like inline JSON `outputSchema` in `.chain.md`.

- **Skill discovery differs between locations.**  
  In `packages/subagents/src/agents/skills.ts`, `SKILL.md` roots and loose `.md` files are both discovered, but location/source affects precedence.  
  In `packages/coding-agent/src/core/skills.ts`, root `.md` files are only treated specially in certain directories, and discovery is stricter about collisions.

- **Override behavior is layered, not additive everywhere.**  
  `readMergedSubagentSettings()` merges project/user overrides, but project settings can disable builtins wholesale via `disableBuiltins`.

- **Builtins can be disabled per scope.**  
  `applyBuiltinOverrides()` can mark builtin agents disabled from user/project settings without deleting the underlying markdown file.

## 3. Anti-patterns or risks

- **TS/Rust migration risk: behavior is encoded in markdown conventions, not just code.**  
  Any Rust port must preserve frontmatter keys, `##` chain section parsing, and skill injection format or it will break existing user-authored files.

- **Discovery rules are duplicated across packages.**  
  `packages/subagents` and `packages/coding-agent` each implement their own skill discovery semantics. That’s a migration hotspot: one Rust implementation will need one canonical rule set.

- **Source precedence is easy to get wrong.**  
  `SOURCE_PRIORITY` and the multi-directory merge order are central to “which skill wins.” Reordering search paths would silently change user-visible behavior.

- **Non-fatal warnings can hide configuration issues.**  
  Missing or unreadable skills don’t stop execution, so a migration that becomes stricter could be user-breaking; a migration that stays lenient needs strong diagnostics parity.

## 4. Evidence index

- `packages/subagents/src/agents/agents.ts`
  - `loadAgentsFromDir()`
  - `loadChainsFromDir()`
  - `discoverAgents()`
  - `discoverAgentsAll()`
  - `BUILTIN_AGENTS_DIR`
  - `applyBuiltinOverrides()`

- `packages/subagents/agents/code-simplifier.md`
- `packages/subagents/agents/codebase-analyzer.md`
- `packages/subagents/agents/codebase-locator.md`
- `packages/subagents/agents/codebase-online-researcher.md`
- `packages/subagents/agents/codebase-pattern-finder.md`
- `packages/subagents/agents/codebase-research-analyzer.md`
- `packages/subagents/agents/codebase-research-locator.md`
- `packages/subagents/agents/debugger.md`

- `packages/subagents/src/agents/skills.ts`
  - `buildSkillPaths()`
  - `collectInstalledPackageSkillPaths()`
  - `collectSettingsSkillPaths()`
  - `collectSettingsPackageSkillPaths()`
  - `collectBuiltinPackageSkillPaths()`
  - `SOURCE_PRIORITY`
  - `resolveSkills()`
  - `buildSkillInjection()`

- `packages/subagents/src/agents/chain-serializer.ts`
  - `parseChain()`
  - `parseJsonChain()`
  - `parseStepBody()`

- `packages/coding-agent/src/core/skills.ts`
  - `loadSkillsFromDirInternal()`
  - `loadSkillFromFile()`
  - `formatSkillsForPrompt()`
  - `loadSkills()`

- `packages/coding-agent/docs/skills.md`
- `packages/subagents/README.md`

### Analyzer
## 1. Behavioral model

This partition is the **dynamic plugin surface** for Atomic’s subagent ecosystem:

- **Agents/chains are discovered from multiple scopes**: builtin, user, project.
- **Builtin agents are shipped as markdown files** and can be overridden/disabled via settings.
- **Skills are discovered from many sources** (filesystem dirs, package manifests, settings, builtin packages), then cached and deduped by name.
- The system is intentionally **data-driven**: markdown and JSON settings define behavior; code mostly does discovery, validation, precedence, and serialization.

For a Rust migration, this is the biggest compatibility seam: the repo currently treats **markdown agent/skill authoring as a runtime feature**, not just docs.

## 2. Key flows and invariants

### Agent / chain discovery
- `discoverAgentsAll(cwd)` (from `agents.ts`) aggregates:
  - builtin agents
  - user agents
  - project agents
  - chains
  - diagnostics for invalid chain files
- `handleList()` exposes only **executable agents** (`!disabled`) plus all chains.
- Name matching is tolerant:
  - raw name
  - sanitized name (`spaces -> hyphens`, lowercase, strip invalid chars)
- Scope matters:
  - `user`, `project`, `both`
  - mutable operations refuse builtin-only targets

### Builtin markdown agents
- Builtins are read as `AgentConfig` records and then optionally overridden by settings:
  - `disableBuiltins`
  - per-agent overrides in `subagents.agentOverrides`
- Overrides can disable or replace:
  - model / fallback models
  - thinking
  - system prompt mode
  - inherited context / skills
  - default context
  - tools / skills / completion guard
- Invariant: builtin agents remain read-only unless a user/project shadow exists.

### Agent/chain management
- `create/update/delete/get/list` are all mediated by `agent-management.ts`.
- `create`:
  - sanitizes name
  - builds runtime name from package + local name
  - validates config types
  - writes markdown via serializer
  - warns if model/skills are unknown
- `update`:
  - resolves target by scope
  - can rename files on disk
  - warns if chains still reference renamed/deleted agents
- `delete`:
  - removes file
  - warns about broken chain references

### Skill loading
There are two skill systems with overlapping intent:

1. **Core runtime skills loader** (`packages/coding-agent/src/core/skills.ts`)
   - loads markdown skills from filesystem paths
   - validates name/description/frontmatter
   - dedupes by canonical path and name
   - formats skills into XML prompt blocks
   - filters out `disable-model-invocation` from automatic prompt injection

2. **Subagent skill discovery** (`packages/subagents/src/agents/skills.ts`)
   - resolves skills from:
     - project/user skill dirs
     - `.agents/skills`
     - package manifests (`pi.skills`)
     - settings.json package references
     - builtin packages
   - caches results briefly (5s TTL)
   - caches failed global `npm root -g` probe for process lifetime
   - gives precedence by source priority:
     - project > project-settings > project-package > user > user-settings > user-package > extension > builtin

### Important invariants
- **Builtin skill `subagent` is excluded from child injection**; it is orchestration-only.
- A skill file without description is skipped.
- A `SKILL.md` at a directory root wins over nested files in that subtree.
- Collisions prefer higher-priority source, not first-found.
- Settings/package probing is best-effort and must not crash startup.

## 3. Tests / validation

Covered by tests in:
- `test/unit/subagents-skills.test.ts`
- `test/unit/subagents-skills-npm-probe.test.ts`
- `packages/coding-agent/test/skills.test.ts`
- `packages/coding-agent/test/resource-loader.test.ts`

Verified behaviors include:
- builtin skill resolution from repo root
- prompt injection excludes YAML frontmatter
- project skills override builtin skills
- `subagent` skill is not injected to children
- failed `npm root -g` probe is cached
- `clearSkillCache()` resets probing
- skill loader:
  - validates names/descriptions
  - supports nested discovery
  - prefers root `SKILL.md`
  - parses `disable-model-invocation`
  - handles collisions and diagnostics

## 4. Risks, unknowns, and verification steps

### Main migration risk
A Rust rewrite must decide whether to:
1. **Preserve markdown agent/skill/chains as-is**, or
2. Replace them with a new plugin format.

If you preserve them, Rust must replicate:
- markdown frontmatter parsing
- discovery precedence
- settings overrides
- serializers for create/update
- prompt formatting and prompt-time filtering

If you replace them, you’ll break a large existing authoring workflow.

### Unknowns
- Exact builtin agent inventory wasn’t fully enumerated here.
- The full chain parsing/serialization edge cases (especially dynamic fanout) need separate confirmation.
- `discoverAgentsAll` internals are only partially visible from the locator summary.

### Verify next
- Inspect builtin agent markdown files under `packages/subagents/agents/`.
- Inspect `chain-serializer.ts` for save/load format guarantees.
- Trace how `discoverAgentsAll` feeds CLI/TUI commands.
- Decide whether Rust should:
  - embed JS/TS for compatibility, or
  - reimplement markdown/chain/skill parsing natively.

If you want, I can turn this into a **Rust migration compatibility matrix** for this partition.

### Online Researcher
## 1. Relevant external facts

- **Atomic/pi skill format**: `SKILL.md` is a markdown skill file with frontmatter; the loader parses `name`, `description`, and `disable-model-invocation` and validates name/description constraints.  
  - Source: `packages/coding-agent/src/core/skills.ts`
- **Directory discovery rules**: skill loading treats a directory containing `SKILL.md` as a terminal skill root and does not recurse further into that subtree.  
  - Source: `packages/coding-agent/src/core/skills.ts`
- **Ignore-file behavior**: `.gitignore`, `.ignore`, and `.fdignore` are honored during skill discovery.  
  - Source: `packages/coding-agent/src/core/skills.ts`
- **Package-based skill discovery**: packages can advertise skills via `package.json -> pi.skills`. The subagent layer also scans installed packages, config dirs, and global npm root.  
  - Source: `packages/subagents/src/agents/skills.ts`
- **Priority rules**: discovered skills are ordered by source priority; project skills outrank user skills, which outrank extensions/builtins.  
  - Source: `packages/subagents/src/agents/skills.ts`
- **Builtin agent/chain format**: subagent agents and chains are markdown-based artifacts discovered from directories, with builtins shipped as markdown definitions.  
  - Source: `packages/subagents/src/agents/agents.ts`, `packages/subagents/agents/*.md`
- **Chain serialization**: chains are loaded/saved via `.chain.md` and `.chain.json`.  
  - Source: `packages/subagents/src/agents/chain-serializer.ts`

## 2. Local implications

- A TS→Rust migration should **preserve the same discovery contract** first, not invent new agent/skill formats unless you want a breaking change.
- The Rust runtime will need equivalents for:
  - markdown frontmatter parsing,
  - recursive filesystem scanning with ignore rules,
  - package metadata lookup (`pi.skills`),
  - source-priority precedence/override logic,
  - chain parsing for `.chain.md` / `.chain.json`,
  - builtin markdown agent loading.
- If Rust changes any of those semantics, it will affect:
  - which skills/agents appear,
  - which one wins on name collisions,
  - whether user/project overrides still shadow builtins,
  - whether existing markdown-based assets remain usable.
- For migration safety, I’d treat the current TS loaders as the **compatibility spec** and reimplement them in Rust before expanding the format.

## 3. Version/API assumptions

- No external version pin was needed for this partition.
- Assumed current behavior is the repo’s source of truth:
  - `SKILL.md` frontmatter format,
  - `pi.skills` package metadata,
  - `.chain.md` / `.chain.json` support,
  - source precedence rules in `packages/subagents/src/agents/skills.ts`.

## 4. Unverified or unnecessary research

- I did **not** need external web research to answer this partition; the repo files are enough.
- I did **not** inventory every builtin markdown agent by name/content.
- I did **not** verify Rust-specific implementation libraries yet; that’s the next research step for the migration plan.