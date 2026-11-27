---
title: "Skill format reference"
sidebarTitle: "Skill format"
description: "Reference for SKILL.md frontmatter fields, naming rules, validation behavior, collision qualifiers, and XML expansion format."
---

## Frontmatter

Atomic implements the [Agent Skills specification](https://agentskills.io/specification#frontmatter-required):

| Field | Required | Used by Atomic | Description |
| --- | --- | --- | --- |
| `name` | Spec required (optional in Atomic) | Yes | Max 64 characters. Lowercase `a-z`, `0-9`, and hyphens. Defaults to the parent directory name if omitted. Standalone root `.md` files must set `name` explicitly or they default to `skills` and collide. |
| `description` | Yes | Yes | Max 1,024 characters. Non-empty summary of what the skill does and when to use it. |
| `disable-model-invocation` | No | Yes | Strict boolean `true` hides the skill from the automatic system prompt list so it runs only via `/skill:name`. A string `"true"` does not disable model invocation. |
| `license` | No | Ignored | License name or reference to a bundled file. Accepted for spec portability. |
| `compatibility` | No | Ignored | Environment requirements (spec max 500 chars; not enforced by Atomic). |
| `metadata` | No | Ignored | Arbitrary key-value mapping. Accepted for spec portability. |
| `allowed-tools` | No | Ignored | Space-delimited tool list from the Agent Skills spec. Parsed without error; does not grant or pre-approve tool permissions in Atomic. |

### Name rules

- 1 to 64 characters
- Lowercase ASCII letters (`a-z`), digits (`0-9`), and hyphens (`-`) only
- No leading or trailing hyphens, and no consecutive hyphens (`--`)
- Match the parent directory name for portability with the Agent Skills specification (Atomic does not warn when `name` differs from the parent directory)

Valid: `pdf-processing`, `data-analysis`, `code-review`

Invalid: `PDF-Processing`, `-pdf`, `pdf--processing`

### Description best practices

The description controls when the model chooses to load the skill. Be concrete about triggers and quote any value containing `: ` so YAML parses it cleanly.

```yaml
# Good
description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents.

# Poor
description: Helps with PDFs.
```

## Validation

Atomic validates `name` and `description` against the Agent Skills standard. Most constraint violations emit warnings while still loading the skill:

- `name` exceeds 64 characters or contains invalid characters
- `name` starts or ends with a hyphen, or contains consecutive hyphens
- `description` exceeds 1,024 characters (the full description still loads)

Unknown frontmatter fields are ignored.

Declared skills (`SKILL.md` files and root `.md` files with skill frontmatter) with a missing, empty, or whitespace-only `description` emit a warning and are skipped. Malformed YAML frontmatter in `SKILL.md` also emits a warning and skips that file. Non-skill Markdown files without valid skill frontmatter (such as `README.md`) are ignored silently.

Symlinks pointing to the same real file are deduplicated silently. Name collisions (the same `name` declared by two or more distinct real files) emit diagnostics, keep the first skill in [resource precedence order](/packages/reference#resource-precedence-order) for bare `/skill:name`, and generate `@source` qualified aliases for the colliding candidates.

## Collision qualifiers and expansion

### Source-qualifier resolution

Qualified aliases (`<name>@<qualifier>`) exist only when two or more distinct files share the same skill name. Atomic assigns qualifiers in this order until every candidate is unique:

1. **Source family:** `project`, `user`, or `builtin` when that family has only one colliding candidate.
2. **Package name:** If one family has multiple candidates from packages, use the npm package name without leading `@` or the git `owner/repo` path.
3. **Shortest unique parent path:** If multiple candidates remain in the same family, use the shortest unique parent directory suffix.
4. **Hash fallback:** If paths still collide, fall back to `<family>-<8-hex-hash>`.
5. **Cross-family disambiguation:** If two different families produce the same qualifier, Atomic prefixes each as `<family>/<qualifier>`.

Aliases recalculate on `/reload`, so a qualified alias disappears as soon as its name collision is resolved.

### Expansion format and error behavior

When a `/skill:<selector>` command expands, Atomic wraps the skill body (with frontmatter stripped) in a `<skill>` XML block recording the selector, its `skill://` address, a stable candidate ID, and the base folder for relative paths:

```xml
<skill name="brave-search" location="skill://brave-search" candidate="skill_0123456789abcdef0123">
References are relative to skill://brave-search/.

...skill instructions...
</skill>
```

Any arguments after `/skill:<selector>` are trimmed and appended after `</skill>`, separated by a blank line with no `User:` prefix.

Qualified selectors are exact: an unknown or ambiguous `/skill:<name>@<qualifier>` never falls back to the bare winner. Atomic reports an expansion diagnostic and returns the original prompt text unchanged (sending it verbatim to the model).

### Programmatic and RPC catalog access

- **Extensions:** `ctx.getSkillCatalog()` exposes the loaded catalog, and `atomic.getCommands()` returns the advertised `/skill:name` and `/skill:name@qualifier` command names (see [Extension API reference](/extensions/api-reference)).
- **RPC:** `get_commands` returns the same advertised skill command names (see [RPC protocol](/rpc/protocol)).
- **SDK:** Use `DefaultResourceLoader` (`additionalSkillPaths`, `noSkills`, `skillsOverride`) to inspect or override loaded skills (see [SDK skills](/sdk/reference#skills)).
