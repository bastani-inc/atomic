---
date: 2026-03-04 07:53:42 UTC
researcher: OpenCode
git_commit: ec23c76b1c507ce7874eeebaabd7ca42cee01695
branch: lavaman131/hotfix/claude-code-config
repository: claude-code-config
topic: "Why skills/sub-agents are not detected in Claude Agent SDK, and whether configs are copied/discovered across .opencode/.claude/.github and ~/.atomic mirrors"
tags:
    [
        research,
        codebase,
        claude-agent-sdk,
        opencode-sdk,
        copilot-sdk,
        config-sync,
        skills,
        sub-agents,
        commands,
    ]
status: complete
last_updated: 2026-03-04
last_updated_by: OpenCode
last_updated_note: "Revised spec summary to explicitly mark SCM skills as the only intentional exception (local init copy), while non-SCM assets are globally mirrored to ~/.atomic"
---

# Research

## Research Question

Figure out why skills and sub-agents are not being detected in Claude Agent SDK. Ensure understanding of whether all skills, commands, and agents are being copied from `.opencode`, `.claude`, and `.github` into `~/.atomic/.opencode`, `~/.atomic/.claude`, and `~/.atomic/.copilot`, and verify discovery behavior for custom agents/skills/commands across Claude, OpenCode, and Copilot SDK integrations.

## Summary

The implementation separates global baseline sync, project-local SCM skill provisioning, and provider-native runtime discovery. The key behavior is:

What exists today:

- Non-SCM template assets are globally mirrored to `~/.atomic`: `.claude -> ~/.atomic/.claude`, `.opencode -> ~/.atomic/.opencode`, `.github -> ~/.atomic/.copilot`.
- The only intentional exception is SCM skills (`gh-*`, `sl-*`): they are excluded from global sync and copied/reconciled into project-local `.claude` / `.opencode` / `.github` during `atomic init` (and chat auto-init when missing).
- Claude sub-agents are loaded programmatically into Claude SDK `options.agents` from project/user/atomic directories, and slash agent dispatch is passed as `options.agent`.
- Perceived Claude detection gaps come from split discovery channels: Atomic UI discovers from broader project/user/atomic paths, while Claude native runtime setting sources remain `.claude`/`~/.claude` and runtime does not set `CLAUDE_CONFIG_DIR`.
- Disk skills are often executed through Atomic's command path (`SKILL.md` content injection) in addition to provider-native skill systems.

## Detailed Findings

### 1) Atomic global copy/sync behavior

- Global sync is implemented in `syncAtomicGlobalAgentConfigs(...)`, with template-to-destination mapping and agent-specific exclusions.
    - Mapping includes Copilot templates sourced from `.github` and copied to `~/.atomic/.copilot`.
    - Source: [`src/utils/atomic-global-config.ts#L18`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/utils/atomic-global-config.ts#L18), [`src/utils/atomic-global-config.ts#L22`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/utils/atomic-global-config.ts#L22), [`src/utils/atomic-global-config.ts#L128`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/utils/atomic-global-config.ts#L128), [`src/utils/atomic-global-config.ts#L139`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/utils/atomic-global-config.ts#L139).
- SCM-managed skills are intentionally excluded from global sync and then pruned if stale.
    - Source: [`src/utils/atomic-global-config.ts#L10`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/utils/atomic-global-config.ts#L10), [`src/utils/atomic-global-config.ts#L125`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/utils/atomic-global-config.ts#L125), [`src/utils/atomic-global-config.ts#L146`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/utils/atomic-global-config.ts#L146).
- Sync execution points:
    - Postinstall always attempts sync.
    - Chat/init call `ensureAtomicGlobalAgentConfigs(...)` only when installation type is not `source`.
    - Source: [`src/scripts/postinstall.ts#L32`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/scripts/postinstall.ts#L32), [`src/commands/chat.ts#L217`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/commands/chat.ts#L217), [`src/commands/init.ts#L392`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/commands/init.ts#L392), [`src/utils/config-path.ts#L44`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/utils/config-path.ts#L44).

### 2) Claude sub-agent detection path (SDK-level)

- Claude client loads configured agents during `createSession()` via `loadConfiguredAgents(...)`, which delegates to `loadCopilotAgents(projectRoot)`.
    - Source: [`src/sdk/clients/claude.ts#L368`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/sdk/clients/claude.ts#L368), [`src/sdk/clients/claude.ts#L1822`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/sdk/clients/claude.ts#L1822), [`src/sdk/clients/claude.ts#L1824`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/sdk/clients/claude.ts#L1824).
- Loaded agents are merged into `config.agents`, then forwarded into SDK `options.agents`.
    - Source: [`src/sdk/clients/claude.ts#L1848`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/sdk/clients/claude.ts#L1848), [`src/sdk/clients/claude.ts#L600`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/sdk/clients/claude.ts#L600).
- Agent invocation from slash command path is passed structurally and reaches Claude query options as `options.agent`.
    - Source: [`src/ui/commands/agent-commands.ts#L325`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/ui/commands/agent-commands.ts#L325), [`src/sdk/clients/claude.ts#L889`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/sdk/clients/claude.ts#L889), [`src/sdk/clients/claude.stream-agent-option.test.ts#L45`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/sdk/clients/claude.stream-agent-option.test.ts#L45).

### 3) Claude skill/command detection path differs from Atomic UI discovery

- Claude options include filesystem setting sources `local/project/user` (Claude-native locations).
    - Source: [`src/sdk/init.ts#L30`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/sdk/init.ts#L30).
- Chat explicitly does not set `CLAUDE_CONFIG_DIR`; instead it only runs a merge utility that writes merged content into `~/.atomic/.claude`.
    - Source: [`src/commands/chat.ts#L236`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/commands/chat.ts#L236), [`src/commands/chat.ts#L239`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/commands/chat.ts#L239), [`src/utils/claude-config.ts#L27`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/utils/claude-config.ts#L27), [`src/utils/claude-config.ts#L61`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/utils/claude-config.ts#L61).
- `CLAUDE_CONFIG_DIR` is not set anywhere in runtime code (only mentioned in comments/docs in code).
    - Source: [`src/commands/chat.ts#L236`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/commands/chat.ts#L236), [`src/utils/claude-config.ts#L15`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/utils/claude-config.ts#L15).
- Therefore, copied `~/.atomic/.claude` skill/command content is not the direct Claude-native filesystem source unless mirrored through another path; Claude-native source-of-truth remains `.claude`/`~/.claude` for `settingSources`.

### 4) Atomic UI discovery path for skills/agents is broader than Claude-native path

- Command initialization registers builtins/workflows, then discovers disk skills and disk agent commands.
    - Source: [`src/ui/commands/index.ts#L87`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/ui/commands/index.ts#L87), [`src/ui/commands/index.ts#L99`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/ui/commands/index.ts#L99), [`src/ui/commands/index.ts#L103`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/ui/commands/index.ts#L103).
- Skill discovery scans project + user + atomic directories across `.claude`, `.opencode`, `.github`, `~/.copilot`, and `~/.atomic/...` locations.
    - Source: [`src/ui/commands/skill-commands.ts#L56`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/ui/commands/skill-commands.ts#L56), [`src/ui/commands/skill-commands.ts#L63`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/ui/commands/skill-commands.ts#L63), [`src/ui/commands/skill-commands.ts#L69`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/ui/commands/skill-commands.ts#L69), [`src/ui/commands/skill-commands.ts#L220`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/ui/commands/skill-commands.ts#L220).
- Skill execution usually injects loaded `SKILL.md` content into conversation with a `<skill-loaded ...>` directive and explicitly tells the model not to call the Skill tool for that skill command path.
    - Source: [`src/ui/commands/skill-commands.ts#L336`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/ui/commands/skill-commands.ts#L336), [`src/ui/commands/skill-commands.ts#L396`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/ui/commands/skill-commands.ts#L396), [`src/ui/commands/skill-commands.ts#L406`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/ui/commands/skill-commands.ts#L406).
- This creates a split where UI can show/execute skills even when native SDK skill enumeration differs.

### 5) Custom discovery behavior by SDK integration

- **Claude integration:** custom sub-agents are programmatically injected via `options.agents`; skills are not similarly programmatically injected as directory lists.
    - Source: [`src/sdk/types.ts#L162`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/sdk/types.ts#L162), [`src/sdk/clients/claude.ts#L600`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/sdk/clients/claude.ts#L600).
- **OpenCode integration:** runtime prepares merged config dir (`~/.atomic/.opencode` base + user/global + project overlays), and sets `OPENCODE_CONFIG_DIR`.
    - Source: [`src/utils/opencode-config.ts#L19`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/utils/opencode-config.ts#L19), [`src/commands/chat.ts#L224`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/commands/chat.ts#L224), [`src/commands/chat.ts#L226`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/commands/chat.ts#L226).
- **Copilot integration:** manually loads custom agents from local/global/atomic paths and passes `customAgents`; separately builds and passes `skillDirectories` across project/home/atomic.
    - Source: [`src/config/copilot-manual.ts#L142`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/config/copilot-manual.ts#L142), [`src/sdk/clients/copilot.ts#L1093`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/sdk/clients/copilot.ts#L1093), [`src/sdk/clients/copilot.ts#L1101`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/sdk/clients/copilot.ts#L1101), [`src/sdk/clients/copilot.ts#L1163`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/sdk/clients/copilot.ts#L1163).

### 6) Observed filesystem state during this research session

- SCM skills exist in repo-local config trees:
    - `.claude/skills/gh-commit/SKILL.md`
    - `.opencode/skills/gh-commit/SKILL.md`
    - `.github/skills/gh-commit/SKILL.md`
- Corresponding files are absent from `~/.atomic` mirrors:
    - `~/.atomic/.claude/skills/gh-commit/SKILL.md` (not found)
    - `~/.atomic/.opencode/skills/gh-commit/SKILL.md` (not found)
    - `~/.atomic/.copilot/skills/gh-commit/SKILL.md` (not found)
- This matches the managed SCM exclusion/pruning logic in global sync.

### 7) Config-location mismatch in project guidance vs runtime/docs

- Project guidance documents list Copilot global config as `~/.config/.copilot`.
    - Source: [`AGENTS.md#L93`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/AGENTS.md#L93), [`CLAUDE.md#L93`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/CLAUDE.md#L93).
- Runtime code and bundled docs use `~/.copilot` (with XDG override references in docs for default path behavior).
    - Source: [`src/config/copilot-manual.ts#L148`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/config/copilot-manual.ts#L148), [`src/utils/mcp-config.ts#L130`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/utils/mcp-config.ts#L130), [`docs/copilot-cli/usage.md#L256`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/docs/copilot-cli/usage.md#L256), [`docs/copilot-cli/skills.md#L16`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/docs/copilot-cli/skills.md#L16).

## Code References

- [`src/utils/atomic-global-config.ts#L128`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/utils/atomic-global-config.ts#L128) - Main global sync function (`.claude/.opencode/.github` templates to `~/.atomic` destinations).
- [`src/utils/atomic-global-config.ts#L125`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/utils/atomic-global-config.ts#L125) - SCM skills excluded from global sync by design.
- [`src/commands/chat.ts#L217`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/commands/chat.ts#L217) - Global sync ensure call is gated to non-source installs.
- [`src/commands/chat.ts#L236`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/commands/chat.ts#L236) - Explicitly avoids setting `CLAUDE_CONFIG_DIR`.
- [`src/utils/claude-config.ts#L23`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/utils/claude-config.ts#L23) - Claude merge utility writes merged output into `~/.atomic/.claude` by default.
- [`src/sdk/init.ts#L30`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/sdk/init.ts#L30) - Claude `settingSources` are `local/project/user`.
- [`src/sdk/clients/claude.ts#L1824`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/sdk/clients/claude.ts#L1824) - Loads configured agents per session.
- [`src/sdk/clients/claude.ts#L600`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/sdk/clients/claude.ts#L600) - Forwards custom agents into Claude SDK options.
- [`src/sdk/clients/claude.ts#L889`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/sdk/clients/claude.ts#L889) - Forwards selected sub-agent name as `options.agent`.
- [`src/ui/commands/index.ts#L99`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/ui/commands/index.ts#L99) - UI command registry discovers disk skills.
- [`src/ui/commands/skill-commands.ts#L56`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/ui/commands/skill-commands.ts#L56) - Skill discovery paths include `.claude/.opencode/.github` + user + atomic paths.
- [`src/ui/commands/skill-commands.ts#L336`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/ui/commands/skill-commands.ts#L336) - Skill-loaded directive path used during command execution.
- [`src/ui/commands/agent-commands.ts#L34`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/ui/commands/agent-commands.ts#L34) - Agent discovery paths include project directories.
- [`src/ui/commands/agent-commands.ts#L45`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/ui/commands/agent-commands.ts#L45) - Global/atomic agent discovery paths.
- [`src/config/copilot-manual.ts#L142`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/config/copilot-manual.ts#L142) - Custom agent loader path precedence across atomic/home/project.
- [`src/sdk/clients/copilot.ts#L1101`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/sdk/clients/copilot.ts#L1101) - Copilot skill directory candidates passed to SDK.
- [`src/utils/opencode-config.ts#L41`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/utils/opencode-config.ts#L41) - OpenCode merged config layering from atomic/user/project.
- [`src/utils/mcp-config.ts#L130`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/utils/mcp-config.ts#L130) - Copilot user config location in code is `~/.copilot`.
- [`AGENTS.md#L93`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/AGENTS.md#L93) - Project guidance lists `~/.config/.copilot`.

## Architecture Documentation

The runtime currently composes configuration/discovery in four layers:

1. **Template sync layer**
    - Copies packaged templates to `~/.atomic` mirrors (with managed SCM skill exclusions).

2. **Provider-specific runtime prep layer**
    - OpenCode: merged config dir and `OPENCODE_CONFIG_DIR`.
    - Claude: merge helper updates `~/.atomic/.claude` but runtime remains on `settingSources` (`.claude`/`~/.claude`).
    - Copilot: explicit `customAgents` and `skillDirectories` injection.

3. **UI command-discovery layer**
    - Independently discovers and registers skills/agents from project, user, and atomic paths for slash-command UX and capabilities prompt.

4. **Execution layer**
    - Sub-agents: structural dispatch (`options.agent`) for Claude/OpenCode and Task-tool steering for Copilot.
    - Skills: often loaded and injected by Atomic command system (`<skill-loaded ...>`) instead of only relying on native SDK discovery.

## External Documentation Confirmations

- Claude settings/skill/sub-agent path behavior:
    - https://code.claude.com/docs/en/settings#settings-files
    - https://code.claude.com/docs/en/skills#where-skills-live
    - https://code.claude.com/docs/en/sub-agents#choose-the-subagent-scope
- OpenCode config precedence and config-dir behavior:
    - https://opencode.ai/docs/config/#precedence-order
    - https://opencode.ai/docs/config/#custom-directory
    - https://opencode.ai/docs/skills/#place-files
- Copilot CLI locations:
    - https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/configure-copilot-cli
    - https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli
    - https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-skills

## Historical Context (from research/)

- `research/docs/2026-02-25-global-config-sync-mechanism.md` - Documents the same `~/.atomic` sync flow and SCM-skill exclusion behavior.
- `research/docs/2026-02-25-install-postinstall-analysis.md` - Documents postinstall sync lifecycle and validation behavior.
- `research/docs/2026-02-17-legacy-code-removal-skills-migration.md` - Captures migration history from legacy command patterns to SKILL.md-centric behavior.
- `research/docs/2026-02-08-skill-loading-from-configs-and-ui.md` - Historical baseline for disk skill loading and UI-based skill dispatch model.

## Related Research

- `research/docs/2026-03-02-copilot-sdk-ui-alignment.md`
- `research/docs/2026-02-23-sdk-subagent-api-research.md`
- `research/docs/2026-02-12-sub-agent-sdk-integration-analysis.md`
- `research/docs/2026-01-31-claude-agent-sdk-research.md`
- `research/docs/2026-01-31-opencode-sdk-research.md`
- `research/docs/2026-01-31-github-copilot-sdk-research.md`

## Open Questions

- The repository guidance (`AGENTS.md`/`CLAUDE.md`) and runtime/docs differ on Copilot global path (`~/.config/.copilot` vs `~/.copilot`); this remains an explicit source-of-truth ambiguity.
- Claude runtime currently avoids `CLAUDE_CONFIG_DIR` while maintaining `~/.atomic/.claude` merges; this keeps a split between atomic mirror state and Claude-native filesystem setting sources.

## Follow-up Research 2026-03-04 07:59:17 UTC

### Follow-up Clarification

User clarified that SCM skills are the explicit exception: they are expected to be copied to local project config folders (`.opencode`, `.github`, `.claude`) during `atomic init`, rather than globally mirrored under `~/.atomic`.

### Verification in Codebase

- Global sync excludes SCM-prefixed skills (`gh-*`, `sl-*`) by design.
    - Source: [`src/utils/atomic-global-config.ts#L10`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/utils/atomic-global-config.ts#L10), [`src/utils/atomic-global-config.ts#L125`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/utils/atomic-global-config.ts#L125), [`src/utils/atomic-global-config.ts#L146`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/utils/atomic-global-config.ts#L146).
- `atomic init` copies selected SCM skill variants into project-local config directories and reconciles unselected variants.
    - Source: [`src/commands/init.ts#L166`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/commands/init.ts#L166), [`src/commands/init.ts#L181`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/commands/init.ts#L181), [`src/commands/init.ts#L400`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/commands/init.ts#L400), [`src/commands/init.ts#L413`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/commands/init.ts#L413).
- Chat auto-init path also enforces project-local SCM skill setup when missing.
    - Source: [`src/commands/chat.ts#L247`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/commands/chat.ts#L247), [`src/commands/chat.ts#L251`](https://github.com/bastani/atomic/blob/ec23c76b1c507ce7874eeebaabd7ca42cee01695/src/commands/chat.ts#L251).

## Follow-up Research 2026-03-04 08:01:25 UTC

### Follow-up Request

User requested revising the spec wording so the SCM-skill exception is explicit and treated as expected behavior.

### Revision Applied

- Updated the top-level `## Summary` to state that non-SCM assets are globally mirrored to `~/.atomic`.
- Explicitly marked SCM skills (`gh-*`, `sl-*`) as the only intentional exception, copied to project-local config folders during `atomic init` / chat auto-init.
- Removed SCM exception wording from `## Open Questions` since this behavior is now documented as confirmed design.
