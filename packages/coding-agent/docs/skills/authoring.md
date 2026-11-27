---
title: "Write a custom skill"
sidebarTitle: "Write a skill"
description: "Structure a skill directory or standalone file, write SKILL.md instructions, and follow a complete worked example."
---

Create a custom skill to teach Atomic a repeatable workflow, domain convention, or script-backed procedure that loads only when relevant. Save project skills in `.atomic/skills/<name>/SKILL.md` or personal global skills in `~/.atomic/agent/skills/<name>/SKILL.md`.

## Skill structure

A skill is usually a directory containing a required `SKILL.md` file plus any optional scripts, references, or assets it needs:

```text
my-skill/
├── SKILL.md              # Required: YAML frontmatter + instructions
├── scripts/              # Optional helper scripts
│   └── process.sh
├── references/           # Optional detailed docs loaded on demand
│   └── api-reference.md
└── assets/               # Optional templates or static files
    └── template.json
```

Once a directory contains `SKILL.md`, Atomic treats that directory as a single skill root and stops recursing inside it. Markdown files under `references/` are never mistaken for separate skills, and subdirectories cannot declare nested skills.

<Note>
You can also create a single-file skill directly inside `~/.atomic/agent/skills/<name>.md` or `.atomic/skills/<name>.md` (always set `name:` in frontmatter so standalone files do not default to `skills` and collide). In `~/.agents/skills/` and `.agents/skills/`, root `.md` files are ignored—place each skill inside its own subdirectory with `SKILL.md`.
</Note>

## Create your first skill

<Steps>
  <Step title="Create the skill folder">
    Create a directory named after your skill in your project (`.atomic/skills/my-skill`) or global agent folder (`~/.atomic/agent/skills/my-skill`):

    ```bash
    mkdir -p .atomic/skills/my-skill/scripts .atomic/skills/my-skill/references
    ```
  </Step>
  <Step title="Write SKILL.md">
    Add YAML frontmatter with `name` and `description`, followed by concise Markdown instructions. Reference supporting files with relative paths and invoke helper scripts through `skill://` addresses so commands work from any working directory:

    ````markdown
    ---
    name: my-skill
    description: Process input files with the team validator and report schema errors. Use when validating release manifests.
    ---

    # My Skill

    ## One-time setup

    If dependencies are not installed yet, run `npm install` once inside this skill's directory (for example `cd .atomic/skills/my-skill && npm install`).

    ## Usage

    Run the validator from any working directory:

    ```bash
    bash skill://my-skill/scripts/process.sh <input>
    ```

    Read `references/api-reference.md` for full error code definitions.
    ````
  </Step>
  <Step title="Reload and test">
    Run `/reload` in an active Atomic session, then test the skill with `/skill:my-skill` or ask a matching question in chat to confirm the model loads it from its description.
  </Step>
</Steps>

<Warning>
Quote any `description` that contains a colon followed by a space (for example `description: "Search docs: fast local lookup"`). An unquoted `: ` triggers a YAML parse error and prevents the skill from loading.
</Warning>

## Referencing files and scripts

- **Reference documents.** Write relative paths from the skill folder in prose, such as `references/api-reference.md`. When Atomic loads a skill, it tells the model `Base directory for this skill: skill://<name>/`, so the model reads supporting files via `skill://<name>/references/api-reference.md` without ever needing an absolute path (see [Skill addresses](/skills#skill-addresses)).
- **Helper scripts.** Invoke scripts with unquoted `skill://` paths—such as `bash skill://my-skill/scripts/process.sh` or `node skill://my-skill/scripts/check.js`—so they work regardless of the user's current working directory. Either make scripts executable (`chmod +x`) or invoke them with an explicit interpreter (`bash`, `node`, `python3`).

## Writing effective instructions

Keep `SKILL.md` concise and lead with the intended outcome:

- State clear completion and stop conditions so the agent knows when to finish.
- Give a short reason for important constraints rather than relying on blanket `ALWAYS`/`NEVER` rules.
- Use explicit decision rules for judgment calls.
- Move bulky or model-specific reference tables into `references/` so they load only when needed.
- Ask for observed tool output or verification results rather than reconstructed reasoning.

## Worked example

```text
brave-search/
├── SKILL.md
├── package.json
├── search.js
└── content.js
```

`SKILL.md`:

````markdown
---
name: brave-search
description: Web search and content extraction via the Brave Search API. Use when searching documentation, facts, or web pages.
---

# Brave Search

## One-time setup

Install dependencies once from the skill folder (for example `cd ~/.atomic/agent/skills/brave-search && npm install`), and set `BRAVE_API_KEY` in your environment.

## Search

```bash
node skill://brave-search/search.js "query"           # Basic search
node skill://brave-search/search.js "query" --content # Include extracted page content
```

## Extract a page

```bash
node skill://brave-search/content.js https://example.com
```
````

## Next steps

Review [Frontmatter fields](/skills/reference#frontmatter) and [Validation rules](/skills/reference#validation) before publishing your skill or bundling it in an [Atomic package](/packages/authoring).
