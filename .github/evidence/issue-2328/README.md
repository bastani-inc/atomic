# Issue 2328 evidence

Real interactive CLI captures from an isolated sandbox. `~/.atomic/agent` was not used.

```sh
ATOMIC_CODING_AGENT_DIR=/tmp/a2328/agent \
ATOMIC_OFFLINE=1 \
bun run packages/coding-agent/src/cli.ts --no-session --offline --approve --no-context-files --no-themes --no-prompt-templates
```

Working directory: `/tmp/a2328/project` (`--approve` so project skills load).

## Sandbox layout

Two user-level `tdd` skills plus the real bundled `tdd`:

- `/tmp/a2328/user-alpha/skills/tdd/SKILL.md` (settings `packages` entry)
- `/tmp/a2328/user-beta/skills/tdd/SKILL.md` (settings `packages` entry)
- `packages/subagents/skills/tdd/SKILL.md` (builtin)

Project + user + builtin `impeccable`:

- `/tmp/a2328/project/.atomic/skills/impeccable/SKILL.md`
- `/tmp/a2328/agent/skills/impeccable/SKILL.md`
- `packages/workflows/skills/impeccable/SKILL.md` (builtin)

## Images

| File | What it shows |
| --- | --- |
| `01-resources-collisions.png` | Startup RESOURCES: losers stay selectable (`/skill:name@source`), not `(skipped)` |
| `02-autocomplete-tdd.png` | `/skill:tdd@` lists `user-alpha`, `user-beta`, and `builtin` |
| `03-autocomplete-impeccable.png` | `/skill:impeccable@` lists `project`, `user`, and `builtin` |
| `04-catalog-resolution.png` | Same sandbox catalog: `@user` is ambiguous; unknown selectors list exact choices |

## PR body snippet

Copy into the PR like [#2381](https://github.com/bastani-inc/atomic/pull/2381):

```markdown
## Real CLI tmux evidence

Isolated sandbox (`ATOMIC_CODING_AGENT_DIR=/tmp/a2328/agent`, `--no-session --offline --approve`). Two user-level `tdd` packages plus bundled `tdd`; project/user/builtin `impeccable`.

### RESOURCES keeps shadowed candidates

Bare `/skill:tdd` stays the user-alpha winner. Losers are `/skill:tdd@user-beta` and `/skill:tdd@builtin`, not skipped.

![RESOURCES collisions](https://raw.githubusercontent.com/bastani-inc/atomic/<commit>/.github/evidence/issue-2328/01-resources-collisions.png)

### `/skill:tdd@` autocomplete

![tdd autocomplete](https://raw.githubusercontent.com/bastani-inc/atomic/<commit>/.github/evidence/issue-2328/02-autocomplete-tdd.png)

### `/skill:impeccable@` autocomplete

![impeccable autocomplete](https://raw.githubusercontent.com/bastani-inc/atomic/<commit>/.github/evidence/issue-2328/03-autocomplete-impeccable.png)

### Qualified lookup failures

`/skill:tdd@user` is ambiguous. `/skill:tdd@missing` lists the exact selectors. Neither falls back to the winner.

![catalog resolution](https://raw.githubusercontent.com/bastani-inc/atomic/<commit>/.github/evidence/issue-2328/04-catalog-resolution.png)
```
