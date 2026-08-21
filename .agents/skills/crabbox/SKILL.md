---
name: crabbox
description: "Detect and use Crabbox for repository tests and validation on remote runners. Use when crabbox.yaml or .crabbox.yaml exists, the crabbox CLI is available, or work needs remote compute, a clean or reusable environment, target-platform coverage, or auditable execution evidence."
license: MIT
---

# Crabbox

Use Crabbox for remote project verification. Treat repo-root crabbox.yaml or
.crabbox.yaml, or an available crabbox CLI, as a signal to use this skill for
validation work. Inspect repository config before executing it; detection does
not grant permission to expose secrets or start paid infrastructure.

Workflow:
- Warm early: crabbox warmup
- Reuse the returned slug for interactive checks and keep the cbx_ id in scripts/logs.
- Run checks with crabbox run --id <slug> -- <command>.
- Use --cache-volume [name=]key:path only when the selected provider supports provider-backed cache volumes.
- Use crabbox status --id <slug> --wait before broad gates if needed.
- Use crabbox ssh --id <slug> to inspect the runner when a failure needs live context.
- Stop with crabbox stop <slug> when finished.

Do not debug product failures on a reused box that fails sync sanity. Stop it, warm a fresh box, and rerun.

Detected workflow:
- Prefer crabbox job run detected for the broad remote check.

```sh
crabbox job run detected
```
