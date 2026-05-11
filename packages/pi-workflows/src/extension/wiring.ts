/**
 * Runtime wiring helpers — construct StageAdapters and WorkflowUIAdapter from
 * pi runtime surfaces.
 *
 * The pi ExtensionAPI is structurally typed here: only the `exec` surface is
 * required to build stage adapters.  When `exec` is absent (degraded / test
 * runtime), `buildRuntimeAdapters` returns an empty adapter set; stage-runner's
 * built-in error messages will fire if any adapter is actually invoked.
 *
 * `buildUIAdapter` maps the pi `ctx.ui` dialog methods (input/confirm/select/
 * editor) to the WorkflowUIAdapter surface.  Returns `undefined` when pi.ui is
 * absent or lacks all dialog methods, preserving the executor's existing
 * fallback behaviour.
 *
 * Each stage adapter spawns `pi --mode json` as a one-shot subprocess and
 * extracts the final assistant text from the NDJSON event stream.
 *
 * cross-ref: packages/pi-workflows/src/runs/sync/stage-runner.ts
 *            packages/pi-workflows/src/extension/index.ts
 *            research/docs/2026-05-11-pi-coding-agent-reference.md §4.3 pi --mode json
 *            @earendil-works/pi-coding-agent dist/core/extensions/types.d.ts
 */

import type { StageAdapters } from "../runs/sync/stage-runner.js";
import type { SubagentStageOpts, CompleteStageOpts, WorkflowUIAdapter, StageExecutionMeta } from "../shared/types.js";
import { readWorkflowEnv } from "../integrations/subagents.js";

// ---------------------------------------------------------------------------
// Minimal pi surface
// ---------------------------------------------------------------------------

/** ExecResult shape returned by pi.exec() — structurally matched, not imported. */
export interface PiExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

/**
 * Minimal pi runtime surface needed to build stage adapters.
 * Structurally typed so it works against both the real ExtensionAPI and mocks.
 */
export interface RuntimeWiringSurface {
  /**
   * Execute a shell command.
   * Present on the real pi ExtensionAPI; may be absent in degraded / test runtimes.
   * Used by prompt and complete adapters only — NOT used by the subagent adapter.
   */
  exec?: (command: string, args: string[]) => Promise<PiExecResult>;

  /**
   * pi-subagents integration surface.
   * Typed as unknown for compatibility with ExtensionAPI — narrowed at point of use.
   */
  subagents?: unknown;

  /**
   * Generic tool-call surface on the pi runtime.
   * Used as secondary fallback for subagent delegation when pi.subagents is absent.
   */
  callTool?: (name: string, args: Record<string, unknown>) => Promise<string>;
}

// ---------------------------------------------------------------------------
// NDJSON extraction
// ---------------------------------------------------------------------------

/**
 * Extract the final assistant text from pi `--mode json` NDJSON output.
 * Searches backwards for the last `message_end` event whose message.role
 * is "assistant", then concatenates all `text`-typed content blocks.
 *
 * Returns an empty string when no matching event is found (caller decides
 * whether to treat this as an error).
 */
export function extractAssistantText(ndjson: string): string {
  const lines = ndjson.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event["type"] !== "message_end") continue;
      const msg = event["message"] as Record<string, unknown> | undefined;
      if (!msg || msg["role"] !== "assistant") continue;
      const content = msg["content"];
      if (!Array.isArray(content)) continue;
      const text = (content as Array<Record<string, unknown>>)
        .filter((c) => c["type"] === "text")
        .map((c) => String(c["text"] ?? ""))
        .join("");
      if (text) return text;
    } catch {
      // skip malformed line
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Build StageAdapters from available pi runtime surfaces.
 *
 * Adapters built:
 * - **prompt**: `pi --mode json -p <text> --no-session` → assistant text
 * - **complete**: same + optional `--model` flag from CompleteStageOpts
 * - **subagent**: `pi --mode json -p <task> --no-session`, prefixing context
 *   and agent name into the prompt when present
 *
 * Returns `{}` (no adapters) when `pi.exec` is absent; in that case the
 * stage-runner will throw its standard "adapter not configured" errors.
 *
 * @example
 * ```ts
 * // In extension factory:
 * const adapters = buildRuntimeAdapters(pi);
 * const runtime = createExtensionRuntime({ registry, adapters });
 * ```
 */
export function buildRuntimeAdapters(pi: RuntimeWiringSurface): StageAdapters {
  if (typeof pi.exec !== "function") {
    return {};
  }

  const exec = pi.exec.bind(pi as { exec: RuntimeWiringSurface["exec"] });

  async function runPiJson(args: string[]): Promise<string> {
    const result = await exec!("pi", args);
    // Non-zero exit with no stdout → hard error
    if (result.code !== 0 && !result.stdout.trim()) {
      throw new Error(
        `pi-workflows: pi subprocess exited with code ${result.code}: ${result.stderr.slice(0, 200)}`,
      );
    }
    const text = extractAssistantText(result.stdout);
    if (!text) {
      throw new Error(
        "pi-workflows: pi subprocess produced no assistant text — check pi installation",
      );
    }
    return text;
  }

  /** Collect workflow env vars for injection into subagent child context.
   * Explicit meta (runId/stageId from stage-runner) overrides ambient process.env fallback. */
  function workflowEnvRecord(meta?: StageExecutionMeta): Record<string, string> {
    const raw = readWorkflowEnv();
    const out: Record<string, string> = {};
    // Ambient fallback first
    if (raw.PI_WORKFLOW_RUN_ID) out["PI_WORKFLOW_RUN_ID"] = raw.PI_WORKFLOW_RUN_ID;
    if (raw.PI_WORKFLOW_STAGE_ID) out["PI_WORKFLOW_STAGE_ID"] = raw.PI_WORKFLOW_STAGE_ID;
    // Explicit meta overrides ambient
    if (meta?.runId) out["PI_WORKFLOW_RUN_ID"] = meta.runId;
    if (meta?.stageId) out["PI_WORKFLOW_STAGE_ID"] = meta.stageId;
    return out;
  }

  return {
    prompt: {
      async prompt(text: string, _meta?: StageExecutionMeta): Promise<string> {
        return runPiJson(["--mode", "json", "-p", text, "--no-session"]);
      },
    },

    complete: {
      async complete(text: string, opts?: CompleteStageOpts, _meta?: StageExecutionMeta): Promise<string> {
        const args = ["--mode", "json", "-p", text, "--no-session"];
        if (opts?.model) {
          args.push("--model", opts.model);
        }
        return runPiJson(args);
      },
    },

    subagent: {
      async subagent(opts: SubagentStageOpts, meta?: StageExecutionMeta): Promise<string> {
        // Primary: delegate to pi-subagents public surface.
        // Narrowed at runtime — pi.subagents is typed unknown for ExtensionAPI compat.
        const subagentsAny = pi.subagents as Record<string, unknown> | undefined;
        if (typeof subagentsAny?.["run"] === "function") {
          const runFn = subagentsAny["run"] as (opts: {
            agent: string;
            task: string;
            context?: string;
            env?: Record<string, string>;
            signal?: AbortSignal;
          }) => Promise<string>;
          return runFn({
            agent: opts.agent,
            task: opts.task,
            context: opts.context,
            env: workflowEnvRecord(meta),
            signal: meta?.signal,
          });
        }

        // Secondary: generic callTool fallback when pi.subagents absent.
        if (typeof pi.callTool === "function") {
          const args: Record<string, unknown> = {
            action: "run",
            agent: opts.agent,
            task: opts.task,
            env: workflowEnvRecord(meta),
          };
          if (opts.context !== undefined) {
            args["context"] = opts.context;
          }
          return pi.callTool("subagent", args);
        }

        // Neither surface available — fail with actionable error.
        throw new Error(
          "pi-workflows: subagent delegation requires pi-subagents — install npm:pi-subagents and restart pi.",
        );
      },
    },
  };
}

// ---------------------------------------------------------------------------
// UI adapter — maps pi ctx.ui dialog surface to WorkflowUIAdapter
// ---------------------------------------------------------------------------

/**
 * Subset of pi's ExtensionUIDialogOptions consumed by the adapter.
 * Structurally matched against @earendil-works/pi-coding-agent
 * dist/core/extensions/types.d.ts ExtensionUIDialogOptions.
 */
export interface PiUIDialogOptions {
  /** AbortSignal to programmatically dismiss the dialog. */
  signal?: AbortSignal;
  /** Timeout in milliseconds. */
  timeout?: number;
}

/**
 * Handle returned by pi.ui.custom() to dismiss the overlay.
 */
export interface PiCustomOverlayHandle {
  close(): void;
}

/**
 * Options passed to pi.ui.custom() to open a custom overlay panel.
 */
export interface PiCustomOverlayOpts {
  /** When true, renders as a full-screen overlay rather than an inline widget. */
  overlay: true;
  /** Render callback — returns lines to display. width is terminal columns. */
  render?: (width: number) => string[];
  /** Keyboard input handler — returns true when the key was consumed. */
  onInput?: (data: string) => boolean;
  /** Called when the host UI closes the overlay (e.g. user navigates away). */
  onClose?: () => void;
}

/**
 * Structural type for the pi UI dialog surface.
 * Matches @earendil-works/pi-coding-agent ExtensionUIContext dialog methods.
 * All fields optional — presence is checked at runtime before building adapter.
 */
export interface PiUISurface {
  /** Show a text input dialog. Returns undefined when user dismisses. */
  input?: (title: string, placeholder?: string, opts?: PiUIDialogOptions) => Promise<string | undefined>;
  /** Show a confirmation dialog. */
  confirm?: (title: string, message: string, opts?: PiUIDialogOptions) => Promise<boolean>;
  /** Show a selector and return the user's choice. Returns undefined when user dismisses. */
  select?: (title: string, options: string[], opts?: PiUIDialogOptions) => Promise<string | undefined>;
  /** Show a multi-line editor. Returns undefined when user dismisses. */
  editor?: (title: string, prefill?: string) => Promise<string | undefined>;
}

/**
 * Runtime surface that includes the optional UI dialog surface.
 * Extends RuntimeWiringSurface so buildUIAdapter accepts the same `pi`
 * object passed to buildRuntimeAdapters.
 */
export interface UIWiringSurface {
  ui?: PiUISurface;
}

/**
 * Derive a WorkflowUIAdapter from the pi `ctx.ui` dialog surface.
 *
 * Maps each WorkflowUIContext primitive to the corresponding pi dialog method:
 * - `input(prompt)`   → `pi.ui.input(prompt)` — empty string when dismissed
 * - `confirm(message)` → `pi.ui.confirm(message, message)` — direct boolean
 * - `select(message, options)` → `pi.ui.select(message, [...options])` — first
 *    option when dismissed (select always has ≥1 choice by type invariant)
 * - `editor(initial?)` → `pi.ui.editor("", initial)` — `initial ?? ""` when dismissed
 *
 * Returns `undefined` when `pi.ui` is absent or none of the four dialog
 * methods are present — the executor's existing fallback remains intact.
 *
 * @example
 * ```ts
 * // In extension factory:
 * const ui = buildUIAdapter(pi);
 * const runtime = createExtensionRuntime({ registry, adapters, ui });
 * ```
 */
export function buildUIAdapter(pi: UIWiringSurface): WorkflowUIAdapter | undefined {
  const piUI = pi.ui;
  if (
    piUI === undefined ||
    piUI === null ||
    (typeof piUI.input !== "function" &&
      typeof piUI.confirm !== "function" &&
      typeof piUI.select !== "function" &&
      typeof piUI.editor !== "function")
  ) {
    return undefined;
  }

  return {
    async input(prompt: string): Promise<string> {
      if (typeof piUI.input !== "function") return "";
      const result = await piUI.input(prompt);
      return result ?? "";
    },

    async confirm(message: string): Promise<boolean> {
      if (typeof piUI.confirm !== "function") return false;
      return piUI.confirm(message, message);
    },

    async select<T extends string>(message: string, options: readonly T[]): Promise<T> {
      if (typeof piUI.select !== "function") return options[0];
      const result = await piUI.select(message, [...options]);
      // If user dismissed (undefined), fall back to first option.
      if (result === undefined) return options[0];
      return result as T;
    },

    async editor(initial?: string): Promise<string> {
      if (typeof piUI.editor !== "function") return initial ?? "";
      const result = await piUI.editor("", initial);
      return result ?? initial ?? "";
    },
  };
}
