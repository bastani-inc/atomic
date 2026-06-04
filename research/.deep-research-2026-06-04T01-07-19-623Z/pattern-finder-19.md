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