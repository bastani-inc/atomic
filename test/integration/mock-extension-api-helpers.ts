/**
 * Integration tests: MockExtensionAPI registration.
 * Verifies factory(pi) registers workflow tool, slash commands,
 * and message renderers against a minimal MockExtensionAPI.
 *
 * cross-ref: spec §5.2 workflow tool, §5.3 slash commands,
 *            §5.6 renderer registration, §8.3 Phase B tests
 */

import assert from "node:assert/strict";
import factory, {
  WORKFLOW_TOOL_DESCRIPTION,
  makeExecuteWorkflowTool,
  type ExtensionAPI,
  type PiToolOpts,
  type PiCommandOptions,
  type PiFlagNamedOpts,
  type PiMessageRendererResult,
  type WorkflowToolArgs,
} from "../../packages/workflows/src/extension/index.js";
import type { WorkflowToolResult } from "../../packages/workflows/src/extension/render-result.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { cancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { renderCall } from "../../packages/workflows/src/extension/render-call.js";
import { renderResult } from "../../packages/workflows/src/extension/render-result.js";
import { waitForRun } from "../support/helpers.ts";
import { store as defaultStore } from "../../packages/workflows/src/shared/store.ts";
import { WORKFLOW_STAGE_SUBAGENT_GUARD_ENV } from "@bastani/atomic";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";

delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];


export type {
  ExtensionAPI,
  PiCommandOptions,
  PiFlagNamedOpts,
  PiMessageRendererResult,
  PiToolOpts,
  WorkflowToolArgs,
};

export {
  factory,
  WORKFLOW_TOOL_DESCRIPTION,
  makeExecuteWorkflowTool,
  createExtensionRuntime,
  cancellationRegistry,
  renderCall,
  renderResult,
  waitForRun,
  defaultStore,
  visibleWidth,
};

// ---------------------------------------------------------------------------
// MockExtensionAPI
// ---------------------------------------------------------------------------

export interface RegisteredTool {
  opts: PiToolOpts<WorkflowToolArgs, WorkflowToolResult>;
}

export interface RegisteredCommand {
  name: string;
  options: PiCommandOptions;
}

export interface RegisteredRenderer {
  event: string;
  renderer: (payload: Record<string, unknown>) => PiMessageRendererResult;
}

export interface RegisteredFlag {
  name: string;
  options: PiFlagNamedOpts;
}

export interface SentMessage {
  customType?: string;
  content?: string;
  display?: boolean;
  details?: unknown;
}

export function makeMock(): ExtensionAPI & {
  tools: RegisteredTool[];
  commands: RegisteredCommand[];
  renderers: RegisteredRenderer[];
  flags: RegisteredFlag[];
  sent: SentMessage[];
} {
  const tools: RegisteredTool[] = [];
  const commands: RegisteredCommand[] = [];
  const renderers: RegisteredRenderer[] = [];
  const flags: RegisteredFlag[] = [];
  const sent: SentMessage[] = [];

  const api: ExtensionAPI & {
    tools: RegisteredTool[];
    commands: RegisteredCommand[];
    renderers: RegisteredRenderer[];
    flags: RegisteredFlag[];
    sent: SentMessage[];
  } = {
    tools,
    commands,
    renderers,
    flags,
    sent,
    // Keep integration tests deterministic: the startup registry already
    // contains bundled workflows, and project/global async discovery can spawn
    // background work that outlives each lightweight mock factory instance.
    disableAsyncDiscovery: true,

    registerTool<TArgs, TResult>(opts: PiToolOpts<TArgs, TResult>) {
      tools.push({ opts: opts as unknown as PiToolOpts<WorkflowToolArgs, WorkflowToolResult> });
    },

    registerCommand(name: string, options: PiCommandOptions) {
      commands.push({ name, options });
    },

    registerMessageRenderer(event: string, renderer: (payload: Record<string, unknown>) => PiMessageRendererResult) {
      renderers.push({ event, renderer });
    },

    registerFlag(name: string, options: PiFlagNamedOpts) {
      flags.push({ name, options });
    },
    // Chat surfaces dispatch via emitChatSurface → pi.sendMessage. Mirror
    // the recipient so tests can assert against the message stream.
    sendMessage(msg: SentMessage) {
      sent.push(msg);
    },
  };

  return api;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Test shim for the pi-conformant tool execute signature.
 * Pi calls execute as `(toolCallId, params, signal, onUpdate, ctx)` and the
 * tool returns `{ content, details }` per AgentToolResult. These tests assert
 * against the workflow-specific `details` payload, so this helper unwraps it.
 */
export async function runTool(
  execute: PiToolOpts<WorkflowToolArgs, WorkflowToolResult>["execute"],
  params: WorkflowToolArgs,
): Promise<WorkflowToolResult> {
  const out = await execute("test-tool-call", params, undefined, undefined, {} as never);
  return out.details;
}

export function recordWorkflowRun(
  id: string,
  name: string,
  status: "running" | "completed" | "failed" | "killed",
  error?: string,
): void {
  defaultStore.recordRunStart({
    id,
    name,
    inputs: {},
    stages: [],
    status: "running",
    startedAt: Date.now(),
  });
  if (status !== "running") {
    defaultStore.recordRunEnd(id, status, undefined, error);
  }
}

export function getCommand(commands: RegisteredCommand[], name: string): RegisteredCommand | undefined {
  return commands.find((c) => c.name === name);
}

export function getRenderer(
  renderers: RegisteredRenderer[],
  event: string,
): ((payload: Record<string, unknown>) => PiMessageRendererResult) | undefined {
  return renderers.find((r) => r.event === event)?.renderer;
}

export function rendererOutputText(output: PiMessageRendererResult): string {
  if (output === undefined || output === null) {
    throw new Error("Expected renderer to return output");
  }
  // Lifecycle banners are wrapped in a render component (the host adds a
  // renderer's result directly as a TUI child, so a bare string crashes
  // `Container.render()`). Normalize to text for content assertions.
  if (typeof output === "string") {
    return output;
  }
  return output.render(120).join("\n");
}

export function expectRegisteredCommand(
  commands: RegisteredCommand[],
  name: string,
): RegisteredCommand {
  const cmd = getCommand(commands, name);
  if (cmd === undefined) {
    throw new Error(`Expected command "${name}" to be registered`);
  }

  assert.equal(cmd.name, name);
  assert.equal(typeof cmd.options.description, "string");
  assert.ok(cmd.options.description.length > 0);
  assert.equal(typeof cmd.options.handler, "function");
  return cmd;
}

export const EXPECTED_WORKFLOW_DESCRIPTION_TOKENS = [
  "named builtin, project, user, or package workflows",
  "direct one-off",
  "custom TypeScript workflow",
  "inline with normal coding tools",
  "discover with list/get/inputs",
  "status/stages/stage details",
  "prompt answers",
  "pause/resume/interrupt/kill",
  "reload workflow resources",
  "sessionFile/transcriptPath",
  "Windows backslashes",
  "rg/grep",
  "path-only by default",
  "explicit tail/limit",
  "missing transcript paths",
] as const;

// ---------------------------------------------------------------------------
// Describe blocks
// ---------------------------------------------------------------------------

