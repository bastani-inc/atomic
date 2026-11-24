---
title: "Write a custom skill"
sidebarTitle: "Write a skill"
description: "Structure a skill directory or standalone file, write SKILL.md instructions, and follow a complete worked example."
---

## Skill structure

A skill is usually a directory containing a `SKILL.md` file plus any scripts, references, or assets it needs.

```text
my-skill/
├── SKILL.md              # Required: frontmatter + instructions
├── scripts/              # Helper scripts
│   └── process.sh
├── references/           # Detailed docs loaded on demand
│   └── api-reference.md
└── assets/
    └── template.json
```

Once a directory contains `SKILL.md`, Atomic stops recursing inside it. Supporting Markdown files under `references/` are never mistaken for nested skills, and nested subdirectories cannot define separate skills.

You can also create a single-file skill directly inside `~/.atomic/agent/skills/<name>.md` or `.atomic/skills/<name>.md` (not `.agents/skills/`, which requires subdirectories with `SKILL.md`). For standalone root `.md` files, always set `name:` in frontmatter; omitting `name:` falls back to the parent directory name (`skills`), which causes all nameless root files to collide.

### SKILL.md format

````markdown
---
name: my-skill
description: What this skill does and when to use it. Be specific.
---

# My Skill

## Setup

Run once before first use:
```bash
cd /path/to/skill && npm install
```

## Usage

```bash
./scripts/process.sh <input>
```
````

Quote any `description` value that contains a YAML colon followed by a space (for example `description: "Search docs: fast local lookup"`). An unquoted colon causes a YAML parse error and prevents the skill from loading.

Use relative paths from the skill directory:

```markdown
See the API reference at `references/api-reference.md` for details.
```

Atomic tells the model to resolve relative paths against the skill's directory (the parent of `SKILL.md`) and pass absolute paths to tools. Make helper scripts executable (`chmod +x scripts/process.sh`) or document running them with an explicit interpreter such as `node`, `bash`, or `python3`.

Keep instructions concise and lead with the intended outcome:

- State observable completion and stop conditions.
- Give a short reason for material constraints.
- Use decision rules for judgment calls instead of `ALWAYS` or `NEVER` language.
- Put detailed or model-specific material in `references/` so it loads only when needed.
- Require evidence or validation results where correctness matters. Do not ask models to reproduce private reasoning or repeatedly verify their own work.

## Example

```text
brave-search/
├── SKILL.md
├── search.js
└── content.js
```

**SKILL.md:**

````markdown
---
name: brave-search
description: Web search and content extraction via Brave Search API. Use for searching documentation, facts, or any web content.
---

# Brave Search

## Setup

```bash
cd /path/to/brave-search && npm install
```

## Search

```bash
./search.js "query"              # Basic search
./search.js "query" --content    # Include page content
```

## Extract page content

```bash
./content.js https://example.com
```
````

## Next steps

Check the skill reference for [frontmatter fields](/skills/reference#frontmatter) and [validation rules](/skills/reference#validation) before sharing your skill.
