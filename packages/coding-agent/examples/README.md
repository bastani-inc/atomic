# Examples

Example code for the Atomic SDK and extensions.

## Directories

### [sdk/](sdk/)
Programmatic usage via `createAgentSession()`. Shows how to customize models, prompts, tools, extensions, and session management.

### [extensions/](extensions/)
Example extensions demonstrating:
- Lifecycle event handlers (tool interception, safety gates, context modifications)
- Custom tools (todo lists, questions, subagents, output truncation)
- Commands and keyboard shortcuts
- Custom UI (footers, headers, editors, overlays)
- Git integration (checkpoints, auto-commit)
- System prompt modifications and custom compaction
- External integrations (SSH, file watchers, system theme sync)
- Custom providers (Anthropic with custom streaming, GitLab Duo)

### [worker-fleet/](worker-fleet/)
Recipes for running and autoscaling workflow worker hosts: a container image, a Helm chart with KEDA, Terraform for
Azure, AWS and Google Cloud scaling groups, a GitHub Actions workflow, and command provisioner presets.

## Documentation

- [SDK Reference](sdk/README.md)
- [Extensions Documentation](../docs/extensions.md)
- [Skills Documentation](../docs/skills.md)
