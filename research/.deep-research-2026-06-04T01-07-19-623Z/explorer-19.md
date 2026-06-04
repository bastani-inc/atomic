## Partition 19: Skills, prompt templates, context files, and markdown-based resource loading

### Locator
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

### Pattern Finder
## 1. Established patterns

- **Markdown-as-resource convention**
  - The repo treats `.md` files as first-class runtime assets, not just docs.
  - `packages/coding-agent/src/core/skills.ts` loads `SKILL.md` roots and also direct `.md` files.
  - `packages/coding-agent/src/core/prompt-templates.ts` loads prompt templates from markdown files and uses frontmatter for metadata.
  - `packages/coding-agent/src/core/resource-loader.ts` loads project context from `AGENTS.md` / `CLAUDE.md` files.

- **Frontmatter + body split for authored resources**
  - `prompt-templates.ts` parses frontmatter for `description` and `argument-hint`, then uses the markdown body as template content.
  - Skills use the same pattern (`parseFrontmatter<SkillFrontmatter>` in `skills.ts`).

- **Directory-based discovery with scope precedence**
  - Resource loading is layered by location:
    - global agent dir
    - project `.atomic/`
    - explicit user paths
  - `resource-loader.ts` and `skills.ts` both normalize paths and attach source metadata.

- **Context injection into system prompt**
  - `system-prompt.ts` inserts loaded context files as `<context_file path="...">...</context_file>` blocks.
  - Skills are appended only when the `read` tool is available.

- **“Reloadable” resource model**
  - The app expects skills, prompts, themes, and context files to be reloadable at runtime.
  - `system-prompt.ts` and `resource-loader.ts` are built around recomputing derived prompt state from disk.

## 2. Variations / exceptions

- **Skills are hierarchical; prompt templates are flat**
  - `skills.ts` recursively descends directories, but stops recursing when it finds a `SKILL.md` root.
  - `prompt-templates.ts` scans directories non-recursively and loads only direct `.md` files.

- **Special filenames drive behavior**
  - `SKILL.md` means “this directory is a skill.”
  - `AGENTS.md` / `CLAUDE.md` mean “this directory contributes project context.”
  - This is a naming convention, not a generic metadata system.

- **Explicit paths can override discovery**
  - `loadPromptTemplates()` supports user-provided paths in addition to default directories.
  - `loadSkills()` also accepts explicit paths, but validates them as markdown and classifies them by source.

- **Markdown is used both as content and as configuration**
  - Some markdown files are pure instructions.
  - Others are templates with placeholder substitution (`$1`, `$@`, `${@:N}`) in `prompt-templates.ts`.

## 3. Anti-patterns or risks

- **Implicit behavior from filenames**
  - Rust migration will need to preserve filename-driven semantics (`SKILL.md`, `AGENTS.md`, `CLAUDE.md`) or intentionally replace them.
  - This is easy to break if resources become “just files” without a discovery contract.

- **Mixed concerns in markdown loading**
  - Markdown files are doing triple duty: documentation, executable instructions, and prompt templates.
  - That coupling is convenient in TS, but a Rust rewrite may need a clearer resource schema.

- **Runtime prompt assembly is brittle**
  - `system-prompt.ts` concatenates context, skills, metadata, and docs references into one prompt string.
  - Any change in resource-loading order can alter model behavior.

- **Recursive discovery can be surprising**
  - Skills recurse through directories, but templates do not.
  - A Rust port should not assume one universal discovery rule.

## 4. Evidence index

- `packages/coding-agent/src/core/skills.ts`
  - `loadSkillsFromDir()`
  - `loadSkillsFromDirInternal()`
  - `SKILL.md` root detection
  - `parseFrontmatter<SkillFrontmatter>()`

- `packages/coding-agent/src/core/prompt-templates.ts`
  - `loadTemplateFromFile()`
  - `parseFrontmatter<Record<string, string>>()`
  - `substituteArgs()`
  - non-recursive `.md` template scanning

- `packages/coding-agent/src/core/resource-loader.ts`
  - `loadContextFileFromDir()`
  - `loadProjectContextFiles()`
  - precedence across agent dir / project dir / explicit paths

- `packages/coding-agent/src/core/system-prompt.ts`
  - `<context_file path="...">`
  - `formatSkillsForPrompt(skills)`
  - metadata footer (`Model name`, `Current date`, `Current working directory`)

- `packages/coding-agent/src/core/tools/read.ts`
  - special handling for `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/`, `examples/`, `SKILL.md`

- `packages/coding-agent/src/core/extensions/loader.ts`
  - confirms markdown/resource loading sits alongside dynamic extension loading, making it part of the broader compatibility surface

### Analyzer
## 1. Behavioral model

This partition is the repo’s **markdown resource discovery layer**.

It turns filesystem content into runtime resources for the agent UI and prompt assembly:

- **Context files**: `AGENTS.md` / `CLAUDE.md` are searched in:
  - the agent config dir(s)
  - every ancestor of `cwd`
- **Skills**: discovered from configured paths, default directories, and package resources.
- **Prompt templates**: loaded from `prompts/*.md` and explicit paths.
- **Themes**: loaded similarly from `themes/`.
- **Package metadata**: normalizes “local vs auto vs package” resource sources and precedence.

For Rust migration, this is the **compatibility surface** you must preserve if you want existing repo conventions to keep working.

## 2. Key flows and invariants

### Context file loading
- `loadProjectContextFiles()` walks upward from `cwd` to `/`.
- It also checks the agent dir(s) first.
- It deduplicates by absolute path.
- Preference/order:
  1. agent-dir context files
  2. ancestor context files from nearest to farthest

### Skill loading
- `loadSkillsFromDir()` has a strong invariant:
  - if a directory contains `SKILL.md`, that directory is a **skill root** and recursion stops there
  - otherwise it recurses into subdirs and loads nested `SKILL.md`
- It validates:
  - name: lowercase, digits, hyphens, max 64, no leading/trailing or double hyphens
  - description: required, max 1024
- It supports:
  - `disable-model-invocation` frontmatter
  - ignore files (`.gitignore`, `.ignore`, `.fdignore`)
  - symlinks
- Important edge case: invalid YAML/frontmatter does **not crash**; it becomes diagnostics.

### Prompt template loading
- `loadPromptTemplates()` is **non-recursive** for direct directories:
  - it scans `.md` files in a directory
  - explicit file paths are also allowed
- Template metadata comes from:
  - frontmatter `description`
  - `argument-hint`
  - fallback description from first non-empty line
- `substituteArgs()` intentionally does **single-pass substitution**:
  - `$1`, `$2`, …
  - `${@:N}` / `${@:N:L}`
  - `$ARGUMENTS`
  - `$@`
- Invariant: argument values are treated literally; no recursive expansion.

### Package/resource precedence
- `DefaultPackageManager` and `DefaultResourceLoader` merge resources from multiple origins.
- Precedence is designed so **project beats user**, and explicit/local beats auto-discovered.
- Resources are deduped/collapsed by name/path depending on type.
- Symlinked user/project dirs are expected and should resolve once, not duplicate.

### Resource loader composition
- `DefaultResourceLoader.reload()` is the main orchestration point.
- It combines:
  - package manager resolved paths
  - skills
  - prompt templates
  - themes
  - context files
  - extension factories/runtime state
- It supports override hooks and “disable” flags (`noSkills`, `noPromptTemplates`, `noThemes`, `noContextFiles`, `noExtensions`).

## 3. Tests / validation

Good coverage exists for the important behaviors:

- `packages/coding-agent/test/resource-loader.test.ts`
  - context loading
  - precedence between project/user
  - symlink de-duplication
  - resource refresh behavior
- `packages/coding-agent/test/skills.test.ts`
  - skill validation
  - recursive discovery
  - SKILL.md root precedence
  - frontmatter parsing and diagnostics
- `packages/coding-agent/test/prompt-templates.test.ts`
  - argument parsing
  - substitution semantics
  - edge cases around quoting and slicing
- `packages/coding-agent/test/package-manager.test.ts`
  - manifest-driven discovery
  - auto-discovery
  - precedence and overrides

These tests act as the behavioral spec you’d want to port to Rust.

## 4. Risks, unknowns, and verification steps

### Main migration risk
Rust has no native equivalent to this repo’s **markdown-as-code convention layer**. If you rewrite in Rust, you must decide whether to:
- preserve `.md` skill/prompt/context semantics exactly
- change them and provide a migration path
- or keep a JS compatibility layer for resource loading

### Unknowns / coupling
- `themes` and some package discovery details are adjacent to this partition but not fully re-read here.
- `resource-loader` also depends on extension/runtime pieces, so a Rust port may need a separate plugin/plugin-ABI decision.
- The exact precedence and dedupe rules are partly encoded in `package-manager.ts` and should be treated as contract, not implementation detail.

### How to verify during migration
- Re-run the existing tests above against the Rust implementation.
- Add parity tests for:
  - ancestor `AGENTS.md` / `CLAUDE.md` ordering
  - SKILL.md root vs nested recursion
  - prompt template substitution edge cases
  - symlinked resource de-duplication
  - project-vs-user collision resolution

If you want, I can turn this into a **Rust migration design map** for this partition (data model, loader API, and compatibility rules).

### Online Researcher
## 1. Relevant external facts

- **No external library behavior is required for this partition** beyond the repo’s own TS loader contracts.
- The important “API surface” here is internal, not third-party:
  - `DefaultResourceLoader`
  - `loadProjectContextFiles()`
  - `loadSkillsFromDir()`, `loadSkills()`, `loadSkillFromFile()`
  - `loadPromptTemplates()`, `expandPromptTemplate()`
  - `parseCommandArgs()`, `substituteArgs()`
  - `formatSkillsForPrompt()`
- The only markdown conventions that matter are repo-defined:
  - `SKILL.md`
  - `AGENTS.md`
  - `CLAUDE.md`
  - `prompts/*.md`

## 2. Local implications

For a Rust migration, this partition says the main risk is **behavioral parity in markdown resource loading**, not just file I/O.

You’ll need to preserve or explicitly redesign:

- **Discovery rules**
  - recursive skill discovery
  - root `SKILL.md` handling
  - non-recursive prompt template loading
  - project context file lookup up the directory chain
- **Precedence/merging**
  - user vs project vs explicit paths
  - collision handling for skills
  - reload semantics
- **Parsing/rendering**
  - frontmatter validation
  - argument-hint metadata for prompts
  - `/template` expansion and arg substitution
  - formatting skills into the system prompt
- **UX compatibility**
  - compact markdown-file classification in the reader UI
  - slash-command exposure for skills/templates

Practically: this partition is the migration spec for the **resource subsystem**. If Rust rewrites the core agent runtime, this subsystem must remain source-compatible with existing repo conventions or you’ll break user workflows.

## 3. Version/API assumptions

- No external version pin is needed for this partition.
- Assume the existing TS behavior in:
  - `packages/coding-agent/src/core/resource-loader.ts`
  - `packages/coding-agent/src/core/skills.ts`
  - `packages/coding-agent/src/core/prompt-templates.ts`
  is the compatibility target.
- If the Rust rewrite changes any of the above semantics, treat it as a breaking change for users’ markdown-based agent setup.

## 4. Unverified or unnecessary research

- I did **not** need external docs for this partition.
- I did **not** verify third-party markdown/frontmatter libraries because the migration concern is the repo’s own loading contract.
- I did **not** inspect the adjacent `themes` / `workflows` loading paths in depth; they may be relevant later, but this partition is specifically about skills, prompts, context files, and markdown resource loading.