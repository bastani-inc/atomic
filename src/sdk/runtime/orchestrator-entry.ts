#!/usr/bin/env bun
/**
 * SDK-owned orchestrator entry script.
 *
 * Run as the tmux pane command for every workflow spawned by `runWorkflow`.
 * Reads the workflow source path, agent, and base64-encoded inputs from
 * positional argv, imports the workflow module, validates the default
 * export, and hands off to `runOrchestrator()`.
 *
 * Argv layout (after `bun <this-file>`):
 *   argv[2] = absolute path to the workflow's source file
 *             (the `source` field from `defineWorkflow({ source: ... })`)
 *   argv[3] = agent — one of "claude" | "copilot" | "opencode"
 *   argv[4] = base64-encoded JSON record of structured inputs
 *
 * The dev's CLI never re-imports its own argv[1] — there's no
 * `ATOMIC_ORCHESTRATOR_MODE` env var, no `handleOrchestratorReentry()`,
 * no boilerplate. This file is the only re-exec target.
 *
 * The remaining ATOMIC_WF_* env vars (ID, TMUX, AGENT, CWD) are still set
 * by the launcher script written by `executeWorkflow()` — they describe
 * the runtime environment (which tmux session, which workflow run id,
 * etc.) rather than acting as a re-entry signal.
 */

import { runOrchestrator } from "./executor.ts";
import type { AgentType, WorkflowDefinition } from "../types.ts";
import { isValidAgent } from "../../services/config/definitions.ts";
import { InvalidWorkflowError } from "../errors.ts";

/** Runtime guard for the imported module's default export. */
function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __brand?: unknown }).__brand === "WorkflowDefinition"
  );
}

/** Decode the base64 inputs payload into a string-keyed record. */
function decodeInputs(b64: string): Record<string, string> {
  if (b64 === "") return {};
  let decoded: string;
  try {
    decoded = Buffer.from(b64, "base64").toString("utf-8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

async function main(): Promise<void> {
  const sourcePath = process.argv[2];
  const agentRaw = process.argv[3];
  const inputsB64 = process.argv[4] ?? "";

  if (!sourcePath || !agentRaw) {
    throw new Error(
      "[atomic/orchestrator-entry] Missing positional arguments. " +
        "Expected: <workflowSource> <agent> <inputsB64>",
    );
  }

  if (!isValidAgent(agentRaw)) {
    throw new Error(
      `[atomic/orchestrator-entry] Invalid agent "${agentRaw}". ` +
        `Expected one of: claude, copilot, opencode.`,
    );
  }
  const agent: AgentType = agentRaw;

  // Import the workflow module by its source path. The dev's `defineWorkflow`
  // call passed `source: import.meta.path`, so this is the same path the SDK
  // captured at build time.
  const mod: unknown = await import(sourcePath);
  const def = (mod as { default?: unknown }).default;

  if (!isWorkflowDefinition(def)) {
    throw new InvalidWorkflowError(sourcePath);
  }

  if (def.agent !== agent) {
    throw new Error(
      `[atomic/orchestrator-entry] Workflow at "${sourcePath}" targets ` +
        `agent "${def.agent}" but the orchestrator was started for agent ` +
        `"${agent}". This usually means the wrong workflow file was passed ` +
        `to runWorkflow().`,
    );
  }

  const inputs = decodeInputs(inputsB64);
  await runOrchestrator(def, inputs);
}

if (import.meta.main) {
  await main();
}
