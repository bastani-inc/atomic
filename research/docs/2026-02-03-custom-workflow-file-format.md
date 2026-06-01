# Custom Workflow File Format

**Date:** 2026-02-03
**Status:** Documentation
**Author:** Research Agent

## Executive Summary

This document provides comprehensive documentation on how to create custom workflow files in Atomic. It covers the file format, required and optional exports, search paths for workflow discovery, and the precedence rules for local vs global workflows.

---

## Table of Contents

1. [Overview](#overview)
2. [File Location](#file-location)
3. [Required Exports](#required-exports)
4. [Optional Exports](#optional-exports)
5. [Precedence Rules](#precedence-rules)
6. [Example Workflow File](#example-workflow-file)
7. [API Reference](#api-reference)

---

## Overview

Atomic allows you to define custom workflows as TypeScript files that are automatically discovered and registered as slash commands. Custom workflows extend Atomic's built-in capabilities by enabling:

- **Project-specific workflows**: Workflows tailored to your codebase
- **Reusable patterns**: Share workflow definitions across projects
- **Workflow composition**: Reference custom workflows from other workflows using name strings

Custom workflows are loaded during application initialization via `loadWorkflowsFromDisk()`.

---

## File Location

Custom workflow files can be placed in two locations:

### Project-Local Workflows (Highest Priority)

```
.atomic/workflows/
```

Place workflow files in this directory for project-specific workflows that should only apply to the current project. These workflows:

- Take precedence over global workflows with the same name
- Are typically checked into version control
- Can reference project-specific code or configuration

**Example path:** `.atomic/workflows/my-workflow.ts`

### User-Global Workflows (Lower Priority)

```
~/.atomic/workflows/
```

Place workflow files here for personal workflows that should be available across all projects. These workflows:

- Are overridden by local workflows with the same name
- Are stored in your home directory
- Are useful for personal productivity workflows

**Example path:** `~/.atomic/workflows/my-workflow.ts`

### Search Path Constant

The search paths are defined in `src/ui/commands/workflow-commands.ts`:

```typescript
export const CUSTOM_WORKFLOW_SEARCH_PATHS = [
    ".atomic/workflows", // Local project workflows (highest priority)
    "~/.atomic/workflows", // Global user workflows
];
```

---

## Required Exports

Every custom workflow file must export a `default` function that creates a compiled workflow graph.

### `default` (Required)

The default export must be a function that returns a `CompiledGraph`:

```typescript
export default function createWorkflow(
    config?: Record<string, unknown>,
): CompiledGraph<YourState> {
    return graph<YourState>().start(/* ... */).then(/* ... */).end().compile();
}
```

**Function Signature:**

- **Parameters:** `config?: Record<string, unknown>` - Optional configuration object
- **Returns:** `CompiledGraph<TState>` - A compiled workflow graph

**Validation:** During loading, Atomic checks that `typeof module.default === 'function'`. If this check fails, a warning is logged and the workflow is skipped.

---

## Optional Exports

In addition to the required `default` export, you can provide optional exports to customize how the workflow appears and behaves.

### `name` (Optional)

A string that sets the workflow name. This becomes the slash command name (e.g., `name = "my-workflow"` creates `/my-workflow`).

```typescript
export const name = "my-workflow";
```

**Default:** If not provided, the filename (without `.ts` extension) is used.

### `description` (Optional)

A human-readable description shown in help text and autocomplete.

```typescript
export const description = "My custom workflow for feature implementation";
```

**Default:** If not provided, defaults to `"Custom workflow: {name}"`.

### `aliases` (Optional)

Alternative names that can be used to invoke the workflow.

```typescript
export const aliases = ["mw", "my-wf"];
```

This allows the workflow to be invoked as `/mw` or `/my-wf` in addition to `/my-workflow`.

### `defaultConfig` (Optional)

Default configuration values passed to the workflow when created.

```typescript
export const defaultConfig = {
    maxIterations: 50,
    checkpointing: true,
    verbose: false,
};
```

These values are merged with any config passed at runtime, with runtime config taking precedence.

---

## Precedence Rules

When multiple workflows share the same name, Atomic uses the following precedence order:

| Priority    | Location               | Source      |
| ----------- | ---------------------- | ----------- |
| 1 (Highest) | `.atomic/workflows/`   | `"local"`   |
| 2           | `~/.atomic/workflows/` | `"global"`  |
| 3 (Lowest)  | Built-in               | `"builtin"` |

### How Precedence Works

1. **Local overrides global**: A workflow in `.atomic/workflows/my-workflow.ts` will override `~/.atomic/workflows/my-workflow.ts`
2. **Custom overrides built-in**: Both local and global workflows override built-in workflows with the same name
3. **First match wins**: Within the same priority level, the first discovered workflow is used
4. **Aliases are tracked**: If workflow A has alias "x", and workflow B is named "x", the alias prevents B from being loaded

### Logging Behavior

When a workflow is skipped due to precedence rules, no warning is logged (this is intentional to allow seamless overriding).

When a workflow file fails to load due to errors, a warning is logged:

```
Failed to load workflow from /path/to/workflow.ts: [error message]
```

When a file doesn't export a default function:

```
Workflow file /path/to/workflow.ts does not export a default function, skipping
```

---

## Example Workflow File

Here's a complete example of a custom workflow file:

```typescript
// .atomic/workflows/feature-builder.ts

import {
    graph,
    agentNode,
    clearContextNode,
    loopNode,
} from "@bastani/atomic/graph";
import type { BaseState, NodeDefinition } from "@bastani/atomic/graph/types";

// ============================================================================
// EXPORTS
// ============================================================================

/** Workflow name - becomes the slash command /feature-builder */
export const name = "feature-builder";

/** Human-readable description for help text */
export const description =
    "Build features iteratively with research and implementation phases";

/** Alternative command names */
export const aliases = ["fb", "build-feature"];

/** Default configuration */
export const defaultConfig = {
    maxIterations: 10,
    checkpointing: true,
};

// ============================================================================
// STATE DEFINITION
// ============================================================================

interface FeatureBuilderState extends BaseState {
    /** User's feature request */
    featureRequest: string;
    /** Research findings */
    research?: string;
    /** Implementation status */
    implemented: boolean;
    /** Current iteration */
    iteration: number;
    /** Maximum iterations */
    maxIterations: number;
}

// ============================================================================
// NODES
// ============================================================================

const researchNode: NodeDefinition<FeatureBuilderState> = agentNode({
    id: "research",
    name: "Research Phase",
    description: "Research the codebase for relevant patterns",
    prompt: (state) => `
    Research the codebase to understand how to implement:
    ${state.featureRequest}

    Focus on:
    1. Existing patterns to follow
    2. Files that need modification
    3. Potential challenges
  `,
});

const implementNode: NodeDefinition<FeatureBuilderState> = agentNode({
    id: "implement",
    name: "Implementation Phase",
    description: "Implement the feature based on research",
    prompt: (state) => `
    Based on the research:
    ${state.research}

    Implement the feature: ${state.featureRequest}

    Follow existing patterns and best practices.
  `,
});

const checkCompletionNode: NodeDefinition<FeatureBuilderState> = {
    id: "check-completion",
    name: "Check Completion",
    type: "decision",
    execute: async (state) => {
        return {
            implemented: state.iteration >= 1, // Simplified check
            iteration: state.iteration + 1,
        };
    },
};

// ============================================================================
// WORKFLOW
// ============================================================================

/**
 * Create the feature-builder workflow.
 *
 * @param config - Optional configuration
 * @returns Compiled workflow graph
 */
export default function createWorkflow(config?: Record<string, unknown>) {
    const maxIterations =
        typeof config?.maxIterations === "number" ? config.maxIterations : 10;

    return graph<FeatureBuilderState>()
        .start(researchNode)
        .then(clearContextNode({ id: "clear-research" }))
        .loop(implementNode, checkCompletionNode, {
            until: (state) =>
                state.implemented || state.iteration >= maxIterations,
            maxIterations,
        })
        .end()
        .compile({
            checkpointing: config?.checkpointing !== false,
        });
}
```

### Usage

After placing this file in `.atomic/workflows/feature-builder.ts`:

```bash
# Using the primary name
/feature-builder implement user authentication with JWT

# Using an alias
/fb implement user authentication with JWT
```

### Minimal Example

Here's the absolute minimum required for a custom workflow:

```typescript
// .atomic/workflows/simple.ts

import { graph, agentNode } from "@bastani/atomic/graph";
import type { BaseState } from "@bastani/atomic/graph/types";

interface SimpleState extends BaseState {
    task: string;
}

export default function createWorkflow() {
    return graph<SimpleState>()
        .start(
            agentNode({
                id: "execute",
                prompt: (state) => `Execute this task: ${state.task}`,
            }),
        )
        .end()
        .compile();
}
```

This creates a `/simple` command (name derived from filename).

---

## API Reference

### Loading Functions

#### `loadWorkflowsFromDisk()`

Load workflow definitions from .ts files on disk.

```typescript
import { loadWorkflowsFromDisk } from "@bastani/atomic/ui/commands/workflow-commands";

const workflows = await loadWorkflowsFromDisk();
```

**Returns:** `Promise<WorkflowMetadata[]>` - Array of loaded workflow metadata

#### `discoverWorkflowFiles()`

Discover workflow files from disk without loading them.

```typescript
import { discoverWorkflowFiles } from "@bastani/atomic/ui/commands/workflow-commands";

const files = discoverWorkflowFiles();
// [{ path: ".atomic/workflows/my-workflow.ts", source: "local" }]
```

**Returns:** `{ path: string; source: "local" | "global" }[]`

#### `getAllWorkflows()`

Get all workflows including built-in and dynamically loaded.

```typescript
import { getAllWorkflows } from "@bastani/atomic/ui/commands/workflow-commands";

const allWorkflows = getAllWorkflows();
```

**Returns:** `WorkflowMetadata[]`

### Types

#### `WorkflowMetadata`

```typescript
interface WorkflowMetadata<TState extends BaseState = AtomicWorkflowState> {
    /** Command name (without leading slash) */
    name: string;
    /** Human-readable description */
    description: string;
    /** Alternative names for the command */
    aliases?: string[];
    /** Function to create the workflow graph */
    createWorkflow: (config?: Record<string, unknown>) => CompiledGraph<TState>;
    /** Optional default configuration */
    defaultConfig?: Record<string, unknown>;
    /** Source: built-in, global (~/.atomic/workflows), or local (.atomic/workflows) */
    source?: "builtin" | "global" | "local";
}
```

---

## Related Documentation

- `src/ui/commands/workflow-commands.ts` - Workflow loading and registration
- `src/graph/builder.ts` - Graph builder fluent API
- `src/graph/nodes.ts` - Node factory functions
- `research/docs/2026-02-03-workflow-composition-patterns.md` - Workflow composition patterns
