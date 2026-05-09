# @bastani/create-atomic-cli

Scaffold a new atomic-powered project. Two templates:

- **Add a workflow to atomic CLI** — registers a custom workflow that
  the `atomic` CLI invokes (project-level `.atomic/workflows/<name>/`
  or global `~/.atomic/workflows/<name>/`). Auto-merges the registry
  entry into `settings.json`.
- **Build my own CLI tool** — generates a standalone CLI compiled with
  `bun build --compile`. Ship a single binary your users run directly.

## Usage

```bash
bun create @bastani/atomic-cli my-app
```

Or non-interactive:

```bash
bun create @bastani/atomic-cli my-app -y
bun create @bastani/atomic-cli my-app --template=atomic-workflow --scope=project --agent=claude
bun create @bastani/atomic-cli my-app --template=standalone-cli --agent=claude
```

## Flags

| Flag                    | Values                              | Default                |
| ----------------------- | ----------------------------------- | ---------------------- |
| `--template <t>`        | `atomic-workflow`, `standalone-cli` | _interactive prompt_   |
| `--scope <s>`           | `project`, `global`                 | `project`              |
| `--agent <a>`           | `claude`, `copilot`, `opencode`     | `claude`               |
| `-y`, `--yes`           | accept all defaults                 | `false`                |
| `-h`, `--help`          | show help                            | —                      |
