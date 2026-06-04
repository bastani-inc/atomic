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