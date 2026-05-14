#!/usr/bin/env bun
/**
 * Scriptable workflow SDK runner.
 *
 * Usage:
 *   bun src/cli/workflow-sdk.ts --workflow deep-research-codebase prompt="map src" max_partitions=2
 *   bun src/cli/workflow-sdk.ts --workflow deep-research-codebase ./inputs.json
 */

import { runWorkflowSdkEntrypoint } from "../runs/shared/workflow-sdk-entrypoint.js";

function usage(): string {
  return [
    "Usage:",
    "  bun src/cli/workflow-sdk.ts --workflow <name> [key=value ...] [--workflow-stub-agent]",
    "  bun src/cli/workflow-sdk.ts --workflow <name> <inputs.json> [--workflow-stub-agent]",
    "  bun src/cli/workflow-sdk.ts --workflow <name> '{\"prompt\":\"map src\"}' [--workflow-stub-agent]",
    "  bun src/cli/workflow-sdk.ts --workflow <name> --inputs <path> [--workflow-stub-agent]",
    "",
    "Named workflow input values from key=value args are parsed as booleans, numbers, JSON values, or strings, then validated against the workflow input schema.",
  ].join("\n");
}

const result = await runWorkflowSdkEntrypoint();

if (!result.handled) {
  console.error(usage());
  process.exit(2);
}

if (result.status === "failed") {
  console.error(result.error);
  process.exit(1);
}

console.log(JSON.stringify(result.details, null, 2));
