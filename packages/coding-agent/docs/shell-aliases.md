---
title: "Shell aliases"
description: "Enable Bash and Zsh shell aliases for Atomic commands using shellCommandPrefix."
---

# Shell aliases

Atomic runs Bash in non-interactive mode (`bash -c`), which does not expand shell aliases by default.

To enable your aliases, add `shellCommandPrefix` to `~/.atomic/agent/settings.json` (legacy `~/.pi/agent/settings.json` is also read):

```json
{
  "shellCommandPrefix": "shopt -s expand_aliases\neval \"$(grep '^alias ' ~/.zshrc)\""
}
```

Adjust the path (`~/.zshrc`, `~/.bashrc`, or another rc file) to match your shell config.

On native Windows, `!` and `!!` commands run in PowerShell rather than Bash, so `shellCommandPrefix` must use PowerShell syntax there. See [Settings: Shell](/settings#shell) and [Windows](/windows) for details.
