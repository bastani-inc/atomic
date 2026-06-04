## 1. Relevant external facts

- **Atomic/pi skill format**: `SKILL.md` is a markdown skill file with frontmatter; the loader parses `name`, `description`, and `disable-model-invocation` and validates name/description constraints.  
  - Source: `packages/coding-agent/src/core/skills.ts`
- **Directory discovery rules**: skill loading treats a directory containing `SKILL.md` as a terminal skill root and does not recurse further into that subtree.  
  - Source: `packages/coding-agent/src/core/skills.ts`
- **Ignore-file behavior**: `.gitignore`, `.ignore`, and `.fdignore` are honored during skill discovery.  
  - Source: `packages/coding-agent/src/core/skills.ts`
- **Package-based skill discovery**: packages can advertise skills via `package.json -> pi.skills`. The subagent layer also scans installed packages, config dirs, and global npm root.  
  - Source: `packages/subagents/src/agents/skills.ts`
- **Priority rules**: discovered skills are ordered by source priority; project skills outrank user skills, which outrank extensions/builtins.  
  - Source: `packages/subagents/src/agents/skills.ts`
- **Builtin agent/chain format**: subagent agents and chains are markdown-based artifacts discovered from directories, with builtins shipped as markdown definitions.  
  - Source: `packages/subagents/src/agents/agents.ts`, `packages/subagents/agents/*.md`
- **Chain serialization**: chains are loaded/saved via `.chain.md` and `.chain.json`.  
  - Source: `packages/subagents/src/agents/chain-serializer.ts`

## 2. Local implications

- A TS→Rust migration should **preserve the same discovery contract** first, not invent new agent/skill formats unless you want a breaking change.
- The Rust runtime will need equivalents for:
  - markdown frontmatter parsing,
  - recursive filesystem scanning with ignore rules,
  - package metadata lookup (`pi.skills`),
  - source-priority precedence/override logic,
  - chain parsing for `.chain.md` / `.chain.json`,
  - builtin markdown agent loading.
- If Rust changes any of those semantics, it will affect:
  - which skills/agents appear,
  - which one wins on name collisions,
  - whether user/project overrides still shadow builtins,
  - whether existing markdown-based assets remain usable.
- For migration safety, I’d treat the current TS loaders as the **compatibility spec** and reimplement them in Rust before expanding the format.

## 3. Version/API assumptions

- No external version pin was needed for this partition.
- Assumed current behavior is the repo’s source of truth:
  - `SKILL.md` frontmatter format,
  - `pi.skills` package metadata,
  - `.chain.md` / `.chain.json` support,
  - source precedence rules in `packages/subagents/src/agents/skills.ts`.

## 4. Unverified or unnecessary research

- I did **not** need external web research to answer this partition; the repo files are enough.
- I did **not** inventory every builtin markdown agent by name/content.
- I did **not** verify Rust-specific implementation libraries yet; that’s the next research step for the migration plan.