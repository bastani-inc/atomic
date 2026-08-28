# Coding with AI Agents

> **Source:** <https://docs.qlty.sh/cli/coding-with-ai-agents.md> (retrieved 2026-08-26).
> Copied verbatim from the upstream page; only the MDX `<Note>` wrapper was rendered as a
> Markdown blockquote and relative links were expanded to absolute URLs.

## Use Qlty CLI with AI Coding Agents

Qlty CLI gives your AI coding tools a universal "quality gate" for code linting, auto-formatting, and maintainability checks. When you let your coding agent run Qlty as part of its workflow, it can automatically clean up code, catch issues early, and ship changes that pass the same standards you expect from human contributors.

## Requirements

* Qlty CLI installed and available on `$PATH`.
* A Qlty analysis config (`.qlty/qlty.toml`) tailored to your project.

## Compatibility

Qlty can be integrated with most AI coding agents that can run shell commands. Popular options include:

* Claude Code
* GitHub Copilot
* Cursor IDE
* OpenAI Codex
* Other agents that can run shell commands

> **Note:** Network access must be available from the agent environment.

## Integration methods

Because `qlty` is a command-line tool, it can be integrated into your AI agent's workflow in several ways:

1. Project memory/instructions (simplest) -- e.g. `CLAUDE.md`
2. Git hooks -- This method works automatically for both humans and agents.
3. Agent-specific hooks -- e.g. Claude Code [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks)

The `qlty` command is run with CLI arguments and reads code files from the local filesystem. Output is printed to standard out, and exit codes indicate success or failure. This simple interface avoids the need for Model Context Protocol (MCP) server or API integration.

### Project memory integration

Each AI Agent offer ways to integrate custom instructions. When coding, agents read these instructions and follow them as part of their workflow. You can add instructions to run the `qlty` command at the right time.

The necessary instructions can be as simple as the following:

```md
- Before committing, ALWAYS run auto-formatting with `qlty fmt`
- Before finishing, ALWAYS run `qlty check --fix --level=low` and fix any lint errors
```

You can customize these instructions to fit the particulars of your desired workflow.

Each AI coding agent has different paths that it will check for instructions files. Some examples include:

* Claude Code: `CLAUDE.md`
* Cursor: `AGENTS.md`
* OpenAI Codex: `AGENTS.md`
* GitHub Copilot: `.github/copilot-instructions.md`

Please refer to the documentation of your chosen agent for details on how to add custom instructions.

### Git hooks integration

The Qlty CLI can be run through Git hooks to enforce quality gates for both human and AI commits. This method works with any AI agent that can commit code via Git.

The typical configuration is to set up a pre-commit hook to run `qlty fmt` and a pre-push hook to run `qlty check`. See [Qlty Git Hooks](https://docs.qlty.sh/cli/git-hooks.md) for more details.
