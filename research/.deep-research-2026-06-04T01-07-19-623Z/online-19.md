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