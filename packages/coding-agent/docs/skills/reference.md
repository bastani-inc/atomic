---
title: Skill reference
description: SKILL.md frontmatter fields and validation rules.
---

# Skill reference

## Frontmatter

Per the [Agent Skills specification](https://agentskills.io/specification#frontmatter-required):

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Spec required (optional in Atomic) | Max 64 chars. Lowercase `a-z`, `0-9`, hyphens. Defaults to the parent directory name if omitted. |
| `description` | Yes | Max 1,024 chars. What the skill does and when to use it. |
| `license` | No | License name or reference to a bundled file. |
| `compatibility` | No | Max 500 chars. Environment requirements. |
| `metadata` | No | Arbitrary key-value mapping. |
| `allowed-tools` | No | Space-delimited list of pre-approved tools (experimental). |
| `disable-model-invocation` | No | When `true`, hides the skill from the system prompt. Users must invoke it with `/skill:name`. |

### Name rules

- 1 to 64 characters
- Lowercase letters, numbers, and hyphens only
- No leading or trailing hyphens
- No consecutive hyphens
- Match the parent directory name for portability with the Agent Skills specification

Valid: `pdf-processing`, `data-analysis`, `code-review`
Invalid: `PDF-Processing`, `-pdf`, `pdf--processing`

### Description best practices

The description determines when the agent loads the skill. Be specific.

Good:
```yaml
description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents.
```

Poor:
```yaml
description: Helps with PDFs.
```

## Validation

Atomic validates skills against the Agent Skills standard. Most issues produce warnings but still load the skill:

- Name exceeds 64 characters or contains invalid characters
- Name starts or ends with a hyphen, or contains consecutive hyphens
- Description exceeds 1,024 characters

Unknown frontmatter fields are ignored.

Declared skills with missing or empty descriptions are not loaded. Malformed `SKILL.md` files and `SKILL.md` files without a description produce warnings and are not loaded. Other Markdown files without valid skill frontmatter are ignored.

Symlinks pointing to the same real skill file are deduplicated silently. Name collisions (the same name declared by different real files) produce diagnostics and keep the first-winner precedence for `/skill:name`. Atomic retains the other files as source-qualified candidates as described in [Skill commands](/skills#skill-commands).
