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