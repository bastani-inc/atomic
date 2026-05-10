/**
 * `runWorkflow` primitive — the public entry point for spawning a
 * workflow run via the atomic daemon JSON-RPC.
 *
 * Resolves/auto-spawns the daemon via `ensureStarted`, then sends a
 * `workflow/start` JSON-RPC request. In foreground mode (default), the
 * returned promise resolves after the daemon emits a `run/ended`
 * notification for the run. In `detach: true` mode the promise resolves
 * as soon as the daemon acknowledges the start.
 */

import { ensureStarted } from "../runtime/daemon.ts";
import type { MessageConnection } from "vscode-jsonrpc";
import type { RegistrableWorkflow } from "../types.ts";
import { validateInputs } from "./inputs.ts";
import { getSource, getName, getAgent } from "./metadata.ts";

// ─── runWorkflow ────────────────────────────────────────────────────────────

/** Options for `runWorkflow()`. */
export interface RunWorkflowOptions {
  /** Compiled workflow definition (the default export of a workflow module). */
  workflow: RegistrableWorkflow;
  /**
   * Raw input map. The primitive runs the same validation pipeline the
   * atomic CLI uses: required-field check, default fill-in, enum and
   * integer parsing. Pass an empty object for free-form workflows that
   * don't take any user input.
   */
  inputs?: Record<string, string>;
  /**
   * Kept for compatibility; may be forwarded as environment information
   * or ignored in v2. The daemon manages the working directory internally.
   */
  cwd?: string;
  /**
   * When true, send `workflow/start` and return immediately without
   * waiting for the run to finish. The caller may subscribe to
   * notifications on the returned `daemon` connection.
   */
  detach?: boolean;
  /**
   * Optional path to the atomic binary. Maps to `atomicBinary` in
   * `ensureStarted`. When unset, the SDK auto-resolves via
   * `ATOMIC_BINARY` env var, then `Bun.which("atomic")`.
   */
  pathToAtomicExecutable?: string;
  /** Endpoint file path override (forwarded to `ensureStarted`). */
  endpointFile?: string;
  /** Pre-shared token override (forwarded to `ensureStarted`). */
  token?: string;
}

/** Result of a successful `runWorkflow()` call. */
export interface RunWorkflowResult {
  /** Run id returned by the daemon. */
  runId: string;
  /** Live connection to the daemon. Caller may subscribe to notifications or dispose. */
  daemon: MessageConnection;
}

/**
 * Run a compiled workflow via the atomic daemon JSON-RPC.
 *
 * Validates inputs, ensures the daemon is running (spawning it if
 * necessary), then sends `workflow/start`. In foreground mode (default),
 * waits for the `run/ended` notification before resolving. In
 * `detach: true` mode resolves as soon as the daemon acknowledges the
 * start request.
 *
 * @example
 * ```ts
 * import workflow from "./hello.ts";
 * import { runWorkflow } from "@bastani/atomic-sdk/workflows";
 *
 * const { runId } = await runWorkflow({ workflow, inputs: { greeting: "hi" } });
 * console.log("Run completed:", runId);
 * ```
 */
export async function runWorkflow(
  options: RunWorkflowOptions,
): Promise<RunWorkflowResult> {
  const { workflow, inputs = {}, detach, pathToAtomicExecutable, endpointFile, token } = options;

  const resolved = validateInputs(workflow, inputs);

  const conn = await ensureStarted({
    atomicBinary: pathToAtomicExecutable,
    endpointFile,
    token,
  });

  const result = await conn.sendRequest("workflow/start", {
    source: getSource(workflow),
    workflowName: getName(workflow),
    agent: getAgent(workflow),
    inputs: resolved,
  }) as { runId: string; attachable: true };

  const { runId } = result;

  if (!detach) {
    // Attach semantics: wait for run/ended notification for this run.
    await new Promise<void>((resolve) => {
      conn.onNotification("run/ended", (params: { runId: string }) => {
        if (params.runId === runId) {
          resolve();
        }
      });
    });
  }

  return { runId, daemon: conn };
}
