---
title: "Shell aliases"
sidebarTitle: "Shell aliases"
description: "Expand Bash or Zsh aliases in Atomic shell commands with shellCommandPrefix and understand platform caveats."
---

Atomic runs Bash in non-interactive mode (`bash -c`), which does not expand shell aliases by default. Use `shellCommandPrefix` in settings to enable aliases before each shell command.

## Configure `shellCommandPrefix`

Add `shellCommandPrefix` to `~/.atomic/agent/settings.json` or a trusted project's `.atomic/settings.json` (project settings replace the global value; legacy `~/.pi/agent/settings.json` is also read):

```json
{
  "shellCommandPrefix": "shopt -s expand_aliases\neval \"$(grep '^alias ' ~/.zshrc)\""
}
```

Adjust the rc file path (`~/.zshrc`, `~/.bashrc`, or another profile file) to match where your aliases are defined.

## Scope, caveats, and Windows behavior

- **Applies to both model and interactive shell commands:** Atomic prepends `shellCommandPrefix` followed by a newline (`<prefix>\n<command>`) to every model `bash` tool call and every interactive `!` and `!!` command.
- **Keep the prefix silent and error-free:** Any syntax error, `set -e` failure, or `exit` inside `shellCommandPrefix` aborts every shell command. Any text printed to stdout by the prefix is prepended to every command output returned to the model.
- **Limitations of `grep '^alias '` and Bash syntax:** `grep '^alias ' ~/.zshrc` imports only single-line alias definitions starting at column 0. It skips shell functions, exported environment variables, indented or conditional aliases, and Zsh-only syntax such as `alias -g` or `alias -s` (which fails in Bash). Because `shopt -s expand_aliases` is Bash-specific, it also fails if no `bash` binary exists on a Unix system and Atomic falls back to `/bin/sh`.
- **Blueprint worktrees:** In restored blueprint worktrees with `$ENVRC`, Atomic appends the blueprint environment prefix after `shellCommandPrefix` automatically.
- **Native Windows conflict:** On native Windows, Atomic prepends `shellCommandPrefix` to **both** model `bash` tool calls (which run in Bash) and interactive `!` and `!!` commands (which run in PowerShell), while the model `powershell` tool ignores `shellCommandPrefix`. Because Bash and PowerShell have incompatible syntax, putting PowerShell syntax in `shellCommandPrefix` breaks every model `bash` tool call, and putting Bash syntax breaks every `!` and `!!` command. Leave `shellCommandPrefix` unset on native Windows unless you intentionally disable one side (for example, by excluding `bash`). Inside WSL, both `bash` tool calls and `!`/`!!` run in Bash, so Bash syntax works for both.

See [Settings: Shell](/settings#shell) and [Windows setup](/windows) for full shell configuration details.
