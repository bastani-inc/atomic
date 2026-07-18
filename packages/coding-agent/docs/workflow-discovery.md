# Discover, configure, and distribute workflows

Put workflow definitions where Atomic can find them, reload safely, configure runtime defaults, and distribute reusable definitions through Atomic packages.

## Workflow Locations

Atomic discovers workflow definitions in this order:

| Location | Scope | Notes |
|----------|-------|-------|
| `.atomic/extensions/workflow/config.json` | Project | `workflows.<name>.path`; project entries override global entries |
| `.atomic/workflows/*.{ts,js,mjs,cjs}` | Project | Legacy `.pi/workflows/` is also checked |
| `~/.atomic/agent/extensions/workflow/config.json` | Global | `workflows.<name>.path` for user-wide configured paths |
| `~/.atomic/agent/workflows/*.{ts,js,mjs,cjs}` | Global | Legacy `~/.pi/agent/workflows/` is also checked |
| Installed Atomic packages | Package | Uses package metadata or conventional `workflows/` directories |
| Bundled workflows | Built-in | Shipped with `@bastani/workflows` |

A workflow module may export one default workflow definition and/or named workflow definitions. Discovery checks the default export first, then named exports.

Every runtime export of a discovered workflow file is validated as a workflow definition. A named export that is not a workflow definition — a widget factory, shared constant, or utility function — is rejected with an `INVALID_DEFINITION` discovery diagnostic (`export is not an object`), even when the module also has a valid default export (the valid workflow still loads; the diagnostic flags the extra export as skipped). Type-only exports (`export type` / `export interface`) are erased at runtime and never flagged.

To co-locate reusable helpers with your workflows — for example a `ctx.ui.custom<T>` widget factory you want to import in tests without running the workflow — put them in a subdirectory and import them from the workflow file. Discovery scans only the top level of each workflow directory, so subdirectories such as `.atomic/workflows/lib/` are never treated as workflow modules:

```text
.atomic/workflows/
  release-picker.ts      # only runtime export: workflow({...})
  lib/
    table-selector.ts    # widget factory + helpers; not scanned by discovery
```

```ts
// .atomic/workflows/release-picker.ts
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";
import { tableSelectorFactory } from "./lib/table-selector.js";
```

```ts
// .atomic/workflows/lib/table-selector.ts
import type { WorkflowCustomUiFactory } from "@bastani/workflows";

export const tableSelectorFactory: WorkflowCustomUiFactory<{ id: string; name: string }> = (
  tui,
  theme,
  _keybindings,
  done,
) => ({
  render: (width) => ["..."],
  invalidate: () => {},
  handleInput: (data) => {
    /* ... done({ id, name }) on Enter ... */
  },
});
```

Workflow files are loaded via [jiti](https://github.com/unjs/jiti), so TypeScript works without compilation.

## Reloading workflow resources

Run `/workflow reload` after adding, editing, renaming, or deleting workflow modules or changing workflow config. Reload rescans project and user conventional directories, legacy `.pi` locations, configured file/directory paths, and package resources without restarting Atomic. The workflow tool's `reload` action uses the same in-process path.

Reload builds a complete replacement registry before publishing it. Concurrent requests are serialized and coalesced, stale discovery from an earlier session cannot overwrite newer state, and a fatal refresh failure retains the previous registry. Reload is safe while workflows are running: existing runs keep the definition and runtime snapshot they started with, while subsequent list/get/inputs/help/completion/invocation calls use the newly published registry.

A successful rescan may still contain per-resource diagnostics. Both reload surfaces now show `CONFIG_INVALID`, `IMPORT_FAILED`, `INVALID_DEFINITION`, `PATH_NOT_FOUND`, and duplicate-name diagnostics instead of reporting bare success while silently skipping a resource. Valid sibling workflows remain available. Fix the reported source/path and reload again; no process restart is required.

## Workflow Configuration

Configured workflow paths live in workflow extension config. Project config paths are relative to the project root. Global config paths are relative to `~/.atomic/agent`.

Project config:

```text
.atomic/extensions/workflow/config.json
```

Global config:

```text
~/.atomic/agent/extensions/workflow/config.json
```

Example config:

```json
{
  "workflows": {
    "team": { "path": "./workflows/team.ts" },
    "shared": { "path": "/shared/team/workflows" }
  },
  "defaultConcurrency": 4,
  "maxDepth": 4,
  "persistRuns": true,
  "statusFile": false,
  "resumeInFlight": "ask",
  "workflowNotifications": {
    "enabled": true,
    "notifyOn": ["completed", "failed", "blocked", "awaiting_input"]
  }
}
```

Runtime config defaults:

| Key | Default | Purpose |
|-----|---------|---------|
| `defaultConcurrency` | `4` | Default concurrency for direct parallel/grouped execution |
| `maxDepth` | `4` | Maximum workflow nesting depth |
| `persistRuns` | `true` | Append workflow lifecycle metadata to session transcripts; DBOS remains the status/resume/history catalog |
| `statusFile` | `false` | Write a derived status file; defaults under `.atomic/workflows/status.json` when enabled |
| `resumeInFlight` | `"ask"` | Behavior when discovering resumable in-flight work |
| `workflowNotifications.enabled` | `true` | Emit terminal workflow lifecycle notices into the active main chat |
| `workflowNotifications.notifyOn` | `["completed", "failed", "blocked", "awaiting_input"]` | Lifecycle states to track; terminal `completed`/`failed`/`blocked` states create main-chat notices, while `awaiting_input` is tracked for dedupe/restore without waking the main agent |

Invalid JSON or invalid shapes produce `CONFIG_INVALID` diagnostics. Missing config files are ignored.

## Package Setup

Atomic packages can ship workflows through package metadata or conventional directories. A package manifest can declare workflows next to extensions, skills, prompt templates, and themes:

> **Package trust:** Workflow files and package extensions are executable TypeScript. Install only packages you trust. Host-discovered project package resources load only after project trust is granted; workflow stage sessions inherit the parent's trust and resource snapshot. Configured and conventional workflow-directory discovery is a separate extension scan, so do not treat a directory location as a security sandbox.

```json
{
  "name": "my-atomic-workflows",
  "keywords": ["atomic-package", "pi-package"],
  "atomic": {
    "extensions": ["./src/index.ts"],
    "workflows": ["./workflows"]
  }
}
```

Paths are relative to the package root and may use glob patterns. Include `atomic-package` for Atomic package discovery and `pi-package` when you want compatibility with existing package-gallery tooling.

For new Atomic package examples, prefer `atomic.workflows` and `atomic.extensions`. `pi.workflows` and `pi.extensions` remain supported for compatibility with existing packages. Workflows can be declared with `atomic.workflows` or discovered from conventional `workflows/` / `workflow/` directories. Unlike other resource types, package workflows still fall back to conventional directories when a package manifest exists but omits the workflow key. App-level config prefers `atomicConfig` where available; legacy `piConfig` is still read as a shim.

Convention directory example:

```text
my-atomic-workflows/
  package.json
  workflows/
    release-plan.ts
    review-loop.ts
  src/
    index.ts
```

Install packages globally or locally:

```bash
atomic install npm:my-atomic-workflows
atomic install git:github.com/user/my-atomic-workflows
atomic install ./local-workflow-package -l
```

By default, `atomic install` writes to global settings (`~/.atomic/agent/settings.json`). Use `-l` to write to project settings (`.atomic/settings.json`). Project settings can be committed so a team gets the same workflow package set.

To temporarily try a package for one run, use `--extension` or `-e`:

```bash
atomic -e npm:my-atomic-workflows
atomic -e ./local-workflow-package
```

Workflow stage sessions inherit the same package and temporary `-e` resource discovery snapshot as the main chat. That means a workflow loaded from an external package or directory can start stages that see the package's extensions/tools, subagents and agent definitions, skills, prompt templates, themes, workflows, and trusted borrowed project-local resources without sharing the parent chat's resource-loader instance. Passing an explicit `resourceLoader` in stage options still opts that stage out of this inheritance.

## Settings

Settings can list package sources directly:

```json
{
  "packages": [
    "npm:my-atomic-workflows@1.0.0",
    "git:github.com/user/team-workflows@v2",
    "./tools/local-workflows"
  ]
}
```

Use object form to filter which workflows load from a package:

```json
{
  "packages": [
    {
      "source": "npm:my-atomic-workflows",
      "workflows": ["workflows/*.ts", "!workflows/experimental/**"]
    }
  ]
}
```

`workflows` patterns follow package filtering rules:

- Omit `workflows` to load every workflow allowed by the package manifest.
- Use `[]` to load no workflows from that package.
- Use `!pattern` to exclude matches.
- Use `+path` to force-include an exact path.
- Use `-path` to force-exclude an exact path.

You can also run `atomic config` to enable or disable package resources interactively. Workflow package filters are saved as `workflows` patterns in settings.


## Package README details: discovery and notifications

These operational details were moved from the package README so this page remains the canonical source.

### Custom workflow directories

Adding workflow files under `.atomic/workflows/` (project scope) or `~/.atomic/agent/workflows/` (user scope) makes them discoverable automatically. To register additional discovery paths, add a workflow extension config file at `.atomic/extensions/workflow/config.json` for a project or `~/.atomic/agent/extensions/workflow/config.json` for your user account:

```json
{
  "workflows": {
    "team": { "path": "/shared/team/workflows" }
  }
}
```

After Atomic is running, use `/workflow reload` or the workflow tool's `reload` action to rescan all workflow sources in process. Additions, edits, renames, deletions, config changes, and package-resource changes become visible immediately to list/get/inputs/help/completion/invocation surfaces. Reload requests are serialized/coalesced and publish a complete replacement registry; an in-flight workflow keeps its original definition while later calls use the new registry. Fatal refresh failures retain the prior registry, and skipped malformed or missing resources are reported with actionable diagnostics while valid siblings remain available.

### Workflow lifecycle notifications

Workflow lifecycle notices are enabled by default. They send steer prompts into the main chat/model context when a run completes, fails, or ends blocked. Awaiting-input prompts are tracked for dedupe/restore, but they do not wake the main chat agent. Configure lifecycle tracking in the same extension config file:

```json
{
  "workflowNotifications": {
    "enabled": true,
    "notifyOn": ["completed", "failed", "blocked", "awaiting_input"]
  }
}
```

Set `enabled` to `false` to disable all lifecycle notices, or narrow `notifyOn` to a non-empty list of selected events. Completion, failure, and blocked lifecycle notices are emitted for top-level workflow runs, use steer delivery, and wake an idle model so the lifecycle update enters the model context when it happens. Nested child workflow completion/failure is reflected inside the expanded parent graph instead of producing separate top-level completion cards. Awaiting-input states are tracked for dedupe/restore, but workflows do not enqueue main-chat `/workflow connect` cards for them; prompt state remains visible through workflow status/connect surfaces, avoiding stale actionable cards if a prompt resolves while the main chat is streaming.

When a stage human-in-the-loop prompt is answered from the workflow TUI/stage chat, workflows also emits a separate display-only `workflows:hil-answer-notice` custom message. It records the answer for user-visible audit, but it does not wake the main agent, enter LLM context, or authorize answering later workflow prompts. Answers sent by the main-chat `workflow` tool do not emit this notice because the tool result already tells the main agent what happened.

## Package README details: discovery sources

## Custom workflow discovery

`@bastani/workflows` discovers workflow files from project-local paths, user-global paths, configured workflow paths, installed Atomic package resources, and bundled workflows:

| Location                           | Scope      | Example path                                                                           |
| ---------------------------------- | ---------- | -------------------------------------------------------------------------------------- |
| `.atomic/workflows/*.ts`           | Project    | `.atomic/workflows/my-workflow.ts`                                                     |
| `~/.atomic/agent/workflows/*.ts`   | User       | `~/.atomic/agent/workflows/my-workflow.ts`                                             |
| `workflows.<name>.path` in config  | Configured | see config example below                                                               |
| Installed Atomic package workflows | Package    | `atomic.workflows`, legacy `pi.workflows`, or `workflows/` / `workflow/` directories   |
| Bundled workflows                  | Built-in   | shipped with `@bastani/workflows`                                                      |

Config-based discovery (`~/.atomic/agent/extensions/workflow/config.json` or `.atomic/extensions/workflow/config.json`):

```json
{
  "workflows": {
    "my-team-workflows": { "path": "/shared/team/workflows" }
  },
  "workflowNotifications": {
    "enabled": true,
    "notifyOn": ["completed", "failed", "blocked", "awaiting_input"]
  }
}
```
