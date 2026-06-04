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