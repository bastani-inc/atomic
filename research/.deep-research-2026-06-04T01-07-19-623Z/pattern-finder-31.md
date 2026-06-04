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