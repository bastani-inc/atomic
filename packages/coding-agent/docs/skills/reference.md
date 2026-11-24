---
title: "Skill format reference"
sidebarTitle: "Skills"
description: "Reference for SKILL.md frontmatter fields, naming rules, validation behavior, and collision handling."
---

## Frontmatter

Per the [Agent Skills specification](https://agentskills.io/specification#frontmatter-required):

| Field | Required | Used by Atomic | Description |
| --- | --- | --- | --- |
| `name` | Spec required (optional in Atomic) | Yes | Max 64 chars. Lowercase `a-z`, `0-9`, and hyphens. Defaults to the parent directory name if omitted. Standalone root `.md` files must set `name` explicitly or they default to `skills` and collide. |
| `description` | Yes | Yes | Max 1,024 chars. Non-empty summary of what the skill does and when to use it. |
| `disable-model-invocation` | No | Yes | Strict boolean `true` hides the skill from the system prompt so it runs only when invoked via `/skill:name`. A string `"true"` does not disable model invocation. |
| `license` | No | Ignored | License name or reference to a bundled file. Accepted for spec portability. |
| `compatibility` | No | Ignored | Environment requirements (spec max 500 chars; not enforced by Atomic). |
| `metadata` | No | Ignored | Arbitrary key-value mapping. Accepted for spec portability. |
| `allowed-tools` | No | Ignored | Space-delimited tool list from the Agent Skills spec. Atomic parses it without error but does not grant or pre-approve tool permissions from it. |

### Name rules

- 1 to 64 characters
- Lowercase letters, numbers, and hyphens only
- No leading or trailing hyphens
- No consecutive hyphens
- Match the parent directory name for portability with the Agent Skills specification (Atomic does not warn when `name` differs from the parent directory)

Valid: `pdf-processing`, `data-analysis`, `code-review`

Invalid: `PDF-Processing`, `-pdf`, `pdf--processing`

### Description best practices

The description determines when the agent loads the skill. Be specific, and quote descriptions that contain `: ` so YAML parses them cleanly.

Good:

```yaml
description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents.
```

Poor:

```yaml
description: Helps with PDFs.
```

## Validation

Atomic validates `name` and `description` against the Agent Skills standard. Most issues produce warnings while still loading the skill:

- `name` exceeds 64 characters or contains invalid characters
- `name` starts or ends with a hyphen, or contains consecutive hyphens
- `description` exceeds 1,024 characters (the full description still loads)

Unknown frontmatter fields are ignored.

Declared skills (`SKILL.md` files and root `.md` files with skill frontmatter) with a missing, empty, or whitespace-only `description` produce a warning and are not loaded. Malformed `SKILL.md` frontmatter also produces a warning and prevents loading. Non-skill Markdown files without valid skill frontmatter (such as `README.md`) are ignored silently.

Symlinks pointing to the same real skill file are deduplicated silently. Name collisions (the same name declared by two or more distinct real files) emit diagnostics, keep the first skill in [discovery precedence order](/skills#precedence-order) for bare `/skill:name`, and create `@source` qualified aliases only for colliding skills. See [Skill commands](/skills#skill-commands).
