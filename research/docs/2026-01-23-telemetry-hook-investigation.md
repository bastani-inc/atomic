# Telemetry Hook Investigation - SessionEnd Not Firing

**Date**: 2026-01-23
**Issue**: SessionEnd hooks don't fire when manually testing with `claude` command, but work when AI spawns agents

## Root Cause Analysis

### Issue #1: Hooks in Wrong File Location ⚠️ **CRITICAL**

Claude Code **ONLY** reads hooks from `settings.json` files, NOT from standalone `hooks.json` files.

**Current (incorrect) configuration:**

- `.claude/hooks/hooks.json` ❌ - Not read by Claude Code
- `.github/hooks/hooks.json` ❌ - Not read by Claude Code (wrong directory)
- `.claude/settings.json` ✅ - Correct location, but **MISSING hooks configuration**

**What Claude Code actually reads:**

```
~/.claude/settings.json          # User-level settings (global)
.claude/settings.json            # Project-level settings
.claude/settings.local.json      # Local project settings (git-ignored)
```

### Issue #2: Wrong Hook Name

In `.claude/hooks/hooks.json`, the hook is named `"Stop"` instead of `"SessionEnd"`.

**Difference between Stop and SessionEnd:**
| Hook | Fires When |
|------|------------|
| `Stop` | Claude finishes responding to a prompt |
| `SessionEnd` | Claude Code session terminates (exit/ctrl+c) |

Using `"Stop"` means the hook fires after EVERY response, not when the session ends.

### Issue #3: Wrong Case in Hook Names

In `.github/hooks/hooks.json`, hooks use lowercase variations:

- `"sessionStart"` ❌ → Should be `"SessionStart"` ✅
- `"sessionEnd"` ❌ → Should be `"SessionEnd"` ✅
- `"userPromptSubmitted"` ❌ → Should be `"UserPromptSubmit"` ✅

Hook names are **case-sensitive** in Claude Code.

## Current Configuration State

### `.claude/settings.json` (Current)

```json
{
  "env": {
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "includeCoAuthoredBy": false,
  "permissions": {
    "defaultMode": "bypassPermissions"
  },
  "enableAllProjectMcpServers": true,
  "extraKnownMarketplaces": { ... },
  "enabledPlugins": { ... }
}
```

**Problem**: No `hooks` field at all!

### `.claude/hooks/hooks.json` (Incorrect location)

```json
{
    "version": 1,
    "hooks": {
        "Stop": [
            // ❌ Wrong hook name + wrong file location
            {
                "type": "command",
                "bash": "./.claude/hooks/telemetry-stop.sh",
                "cwd": ".",
                "timeoutSec": 30
            }
        ]
    }
}
```

## Why It Works When AI Tests

When the AI spawns agents using the Task tool, Claude Code likely:

1. Uses the `.github/hooks/hooks.json` configuration through a different mechanism
2. Or uses the Ralph plugin hooks system
3. Or the hooks are being triggered by a different event entirely

The `.github/hooks/` configuration is used by the Ralph loop system (copilot-cli), which is separate from the standard `claude` command.

## Solution

Move the hook configuration from `.claude/hooks/hooks.json` into `.claude/settings.json` with the correct hook name.

### Corrected Configuration for `.claude/settings.json`

```json
{
    "env": {
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
    },
    "includeCoAuthoredBy": false,
    "permissions": {
        "defaultMode": "bypassPermissions"
    },
    "enableAllProjectMcpServers": true,
    "extraKnownMarketplaces": {
        "atomic-plugins": {
            "source": {
                "source": "github",
                "repo": "bastani/atomic"
            }
        }
    },
    "enabledPlugins": {
        "ralph@atomic-plugins": true
    },
    "hooks": {
        "SessionEnd": [
            {
                "hooks": [
                    {
                        "type": "command",
                        "command": "./.claude/hooks/telemetry-stop.sh",
                        "timeout": 30
                    }
                ]
            }
        ]
    }
}
```

**Note**: The structure is slightly different:

- No `"version": 1` field
- No `"bash"` field - use `"command"` instead
- No `"cwd"` field needed (runs in project directory by default)
- Use `"timeout"` instead of `"timeoutSec"` (in seconds)
- No `"matcher"` field for SessionEnd (not applicable)

## Verification Steps

After applying the fix:

1. **Restart any active Claude Code sessions** (configuration is captured at startup)
2. Test manually:
    ```bash
    claude
    # Type a simple command like "explain-code"
    # Exit with /exit or ctrl+c twice
    ```
3. Check that telemetry event was created:
    ```bash
    cat .atomic/telemetry/*.jsonl | tail -1 | jq
    ```
4. Verify the event has `eventName: "agent_session"` and `toolName: "claude"`

## References

- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks)
- [Claude Code Hooks Guide](https://code.claude.com/docs/en/hooks-guide)
- [Claude Code Settings Guide](https://code.claude.com/docs/en/settings)

## Additional Notes

The `.github/hooks/hooks.json` configuration is still used by the Ralph loop system (copilot-cli), which is why those hooks work in that context. The Ralph loop uses a different hook system and reads from `.github/hooks/`.

The timeout of 30 seconds is reasonable for the telemetry hook, which should complete quickly.
