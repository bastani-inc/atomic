## 1. Must-read paths

- `packages/coding-agent/src/core/resource-loader.ts`
  - **Why:** central orchestrator for loading **skills, prompts, themes, context files, and system prompt files**.
  - Key symbols: `DefaultResourceLoader`, `loadProjectContextFiles()`, `resolvePromptInput()`, `reload()`, `updateSkillsFromPaths()`, `updatePromptsFromPaths()`.
  - This is the main “resource discovery + merge + precedence” contract a Rust rewrite would need to preserve or intentionally change.

- `packages/coding-agent/src/core/skills.ts`
  - **Why:** defines how **skill markdown** is discovered, validated, deduped, and rendered into the system prompt.
  - Key symbols: `loadSkillsFromDir()`, `loadSkills()`, `loadSkillFromFile()`, `formatSkillsForPrompt()`.
  - Important behaviors: `SKILL.md` root handling, recursive discovery, frontmatter validation, collision handling.

- `packages/coding-agent/src/core/prompt-templates.ts`
  - **Why:** defines how **markdown prompt templates** are loaded and expanded.
  - Key symbols: `loadPromptTemplates()`, `expandPromptTemplate()`, `parseCommandArgs()`, `substituteArgs()`.
  - Important behaviors: non-recursive `prompts/*.md` loading, frontmatter `argument-hint`, `/template` expansion semantics.

- `packages/coding-agent/src/core/agent-session.ts`
  - **Why:** connects loaded resources to actual agent behavior.
  - Key symbols: prompt handling around `prompt()`, `_expandSkillCommand()`, `_bindExtensionCore()`.
  - Important behavior: prompt templates and skills are exposed as slash commands, and skills are injected into the system prompt.

- `packages/coding-agent/src/core/system-prompt.ts`
  - **Why:** shows how loaded context files and skills are assembled into the final prompt.
  - Key symbols: prompt assembly logic that appends **project context files** and `formatSkillsForPrompt()` output.

- `packages/coding-agent/src/core/tools/read.ts`
  - **Why:** special handling for markdown resources when read by the agent.
  - Key symbols: `getCompactReadClassification()`, `COMPACT_RESOURCE_FILE_NAMES`, `getPiDocsClassification()`.
  - Important for Rust migration because it encodes UX shortcuts for `AGENTS.md`, `CLAUDE.md`, `SKILL.md`, and docs paths.

## 2. Supporting paths

- `packages/coding-agent/src/core/package-manager.ts`
  - **Why:** package-level discovery for `skills`, `prompts`, and related markdown resources.
  - Look for: `collectSkillEntries()`, `collectResourceFiles()`, `resolveExtensionSources()`, `matchesAnyPattern()`, `applyPatterns()`.
  - This is where packaged `atomic`/`pi` manifests and convention directories are normalized.

- `packages/coding-agent/src/core/settings-manager.ts`
  - **Why:** user/project settings can point to custom `skills` and `prompts` directories.
  - Look for: settings fields for `skills`, `prompts`, and reload/migration logic.

- `packages/coding-agent/docs/skills.md`
  - **Why:** user-facing contract for skill discovery, structure, and validation.

- `packages/coding-agent/docs/prompt-templates.md`
  - **Why:** user-facing contract for template discovery and expansion syntax.

- `packages/coding-agent/docs/packages.md`
  - **Why:** explains package-based markdown resource loading and precedence rules.

- `packages/coding-agent/test/resource-loader.test.ts`
  - **Why:** integration tests for loader precedence, discovery, and context file handling.
  - Good examples: user vs project precedence, `AGENTS.md`/`CLAUDE.md` discovery, no-context mode.

- `packages/coding-agent/test/skills.test.ts`
  - **Why:** direct behavioral spec for skill loading/validation/rendering.

- `packages/coding-agent/test/prompt-templates.test.ts`
  - **Why:** direct behavioral spec for template parsing, substitution, and loading.

- `packages/coding-agent/test/package-manager.test.ts`
  - **Why:** verifies package manifest and convention-directory discovery for markdown resources.

- `packages/coding-agent/test/suite/regressions/2781-skill-collision-precedence.test.ts`
  - **Why:** regression coverage for skill name collisions.

- `packages/coding-agent/test/suite/regressions/3616-settings-inmemory-reload.test.ts`
  - **Why:** reload behavior can affect resource discovery correctness.

- `packages/subagents/src/agents/skills.ts`
  - **Why:** separate skill discovery implementation used by subagents; relevant if you migrate that ecosystem too.
  - Key symbols: `discoverAvailableSkills()`, `buildSkillInjection()`, `loadSkillsFromDirInternal()`.

- `packages/subagents/src/agents/agents.ts`
  - **Why:** loads `.md` and `.chain.md` agent definitions; adjacent markdown-based resource loading.

## 3. Entry points / symbols

- `DefaultResourceLoader.reload()`
  - Orchestrates all resource loading and precedence.

- `loadProjectContextFiles({ cwd, agentDir })`
  - Finds `AGENTS.md` / `CLAUDE.md` up the directory chain plus agent-dir copies.

- `loadSkills({ cwd, agentDir, skillPaths, includeDefaults })`
  - Merges global/project/explicit skill sources.

- `loadSkillsFromDir(options)`
  - Skill directory recursion rules, especially `SKILL.md` root behavior.

- `formatSkillsForPrompt(skills)`
  - Emits the XML block inserted into the system prompt.

- `loadPromptTemplates({ cwd, agentDir, promptPaths, includeDefaults })`
  - Template discovery rules and source typing.

- `expandPromptTemplate(text, templates)`
  - `/template` expansion semantics.

- `parseCommandArgs(argsString)` / `substituteArgs(content, args)`
  - Command-like argument parsing and placeholder replacement.

- `getCompactReadClassification()`
  - How markdown resource files are abbreviated in the UI.

- `collectSkillEntries(...)` / `collectResourceFiles(...)` / `resolveExtensionSources(...)`
  - Package-level markdown resource discovery and enable/disable filtering.

## 4. Gaps or uncertainty

- I verified the core TS loading path, but **not every docs cross-reference** in `packages/coding-agent/docs/*.md`.
- I did **not** fully inspect `packages/coding-agent/src/core/package-manager.ts` end-to-end; it is clearly relevant, but specific edge-case behavior may need a second pass.
- I did **not** verify whether all markdown resource loading for `themes` and `workflows` belongs in this partition or the next one; they are adjacent and share the same loader pipeline.
- I did **not** inspect `packages/subagents` markdown loaders fully; they matter if your Rust migration includes subagent/skill parity outside the main CLI.