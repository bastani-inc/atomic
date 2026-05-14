---
source_url: https://github.com/nicobailon/pi-subagents
fetched_at: 2026-05-14 07:07:16 UTC
fetch_method: github_mcp_server get_file_contents/get_commit/get_latest_release
commit: 635112deea068528d89694e58ca068ddc1fe4b2d
release: v0.24.2
---

# nicobailon/pi-subagents GitHub Source Capture

This source note records GitHub MCP research against `nicobailon/pi-subagents` at commit [`635112deea068528d89694e58ca068ddc1fe4b2d`](https://github.com/nicobailon/pi-subagents/commit/635112deea068528d89694e58ca068ddc1fe4b2d), release [`v0.24.2`](https://github.com/nicobailon/pi-subagents/releases/tag/v0.24.2).

## Files inspected with GitHub MCP

- Repository root listing: `README.md`, `CHANGELOG.md`, `package.json`, `agents/`, `prompts/`, `skills/`, `src/`, `test/`.
- `package.json` for package metadata, `files`, and `pi.extensions`/`pi.skills`/`pi.prompts` registration.
- `src/extension/schemas.ts` for TypeBox `SubagentParams` and nested task/chain/control schemas.
- `src/extension/index.ts` for extension registration, `subagent` tool registration, renderer hooks, slash bridge hookup, notifications, and lifecycle events.
- `src/runs/foreground/subagent-executor.ts` for execution/action routing across management, control, single, parallel, chain, async, fork, session, artifact, and intercom behavior.
- `src/runs/foreground/chain-execution.ts` and `src/shared/settings.ts` for chain/parallel step types, template resolution, chain directories, behavior resolution, and per-step output/progress/read injection.
- `src/agents/agents.ts` and `src/agents/agent-management.ts` for agent/chain discovery and management actions.
- `src/slash/slash-commands.ts` for `/run`, `/chain`, `/parallel`, `/run-chain`, and `/subagents-doctor` command behavior.
- `src/shared/types.ts` for result/status/state/config/action constants and recursion-depth helpers.
- `skills/pi-subagents/SKILL.md` for workflow/skill guidance and API examples.
- `prompts/` directory listing for packaged prompt shortcuts.
- Latest release and commit metadata through GitHub MCP.
