import type { WorkflowExecutionPolicy, WorkflowInputValues, WorkflowSerializableValue } from "../shared/types.js";
import type { ExtensionAPI, PiCommandContext, PiCommandOptions } from "./public-types.js";
import { workflowPolicyFromContext } from "./workflow-policy.js";

export const WORKFLOW_COMMAND_OUTPUT_CUSTOM_TYPE = "workflows:command-output";

export interface WorkflowCommandOutputDetails {
  readonly command: string;
  readonly workflowName?: string;
}

export function emitWorkflowCommandOutput(
  pi: ExtensionAPI,
  content: string,
  details: WorkflowCommandOutputDetails,
): void {
  if (typeof pi.sendMessage !== "function") return;
  void pi.sendMessage<WorkflowCommandOutputDetails>({
    customType: WORKFLOW_COMMAND_OUTPUT_CUSTOM_TYPE,
    content,
    display: true,
    details,
  });
}

export interface WorkflowCommandReporter {
  info(message: string): void;
  error(message: string): void;
}

export function formatAvailableWorkflowNames(names: readonly string[]): string {
  return names.length > 0 ? names.join(", ") : "(none)";
}

export class WorkflowHeadlessCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowHeadlessCommandError";
  }
}

export function createWorkflowCommandReporter(
  ctx: PiCommandContext,
  policy: WorkflowExecutionPolicy = workflowPolicyFromContext(ctx),
  pi?: ExtensionAPI,
): WorkflowCommandReporter {
  return {
    info(message: string): void {
      if (policy.mode === "non_interactive") {
        if (pi) emitWorkflowCommandOutput(pi, message, { command: "message" });
        return;
      }
      ctx.ui.notify(message, "info");
    },
    error(message: string): void {
      if (policy.mode === "non_interactive") throw new WorkflowHeadlessCommandError(message);
      ctx.ui.notify(message, "error");
    },
  };
}

export type WorkflowCommandHandler = PiCommandOptions["handler"];

interface ParsedWorkflowSlashCommand {
  name: string;
  args: string;
}

function parseWorkflowSlashCommand(text: string): ParsedWorkflowSlashCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const firstSpace = trimmed.indexOf(" ");
  const name = firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace);
  const args = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);
  return { name, args };
}

export function registerWorkflowCommand(
  pi: ExtensionAPI,
  name: string,
  options: PiCommandOptions,
  registry: Map<string, WorkflowCommandHandler>,
): void {
  pi.registerCommand?.(name, options);
  registry.set(name, options.handler);
}

export function installInputInterceptor(
  pi: ExtensionAPI,
  commands: Map<string, WorkflowCommandHandler>,
): void {
  if (typeof pi.on !== "function") return;
  pi.on("input", async (event, ctx) => {
    const text = (event as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string") return undefined;
    const parsedCommand = parseWorkflowSlashCommand(text);
    if (!parsedCommand) return undefined;
    const { name, args } = parsedCommand;
    const handler = commands.get(name);
    if (!handler) return undefined;
    const commandCtx = ctx as PiCommandContext;
    try {
      await handler(args, commandCtx);
    } catch (err) {
      if (commandCtx.hasUI === false) throw err;
      const message = err instanceof Error ? err.message : String(err);
      commandCtx.ui.notify(`/${name} failed: ${message}`, "error");
    }
    return { action: "handled" };
  });
}

export function stripYesFlag(tokens: string[]): {
  tokens: string[];
  yes: boolean;
} {
  const yes = tokens.some((t) => t === "--yes" || t === "-y");
  return { tokens: tokens.filter((t) => t !== "--yes" && t !== "-y"), yes };
}

export function tokenizeWorkflowArgs(args: string): string[] {
  const tokens: string[] = [];
  let buf = "";
  let quote: '"' | "'" | undefined;
  let hasBuf = false;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i]!;
    if (quote !== undefined) {
      buf += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      buf += ch;
      hasBuf = true;
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (hasBuf) {
        tokens.push(buf);
        buf = "";
        hasBuf = false;
      }
      continue;
    }
    buf += ch;
    hasBuf = true;
  }
  if (hasBuf) tokens.push(buf);
  return tokens;
}

export function parseWorkflowArgs(tokens: string[]): WorkflowInputValues {
  const result: Record<string, WorkflowSerializableValue> = {};
  for (const token of tokens) {
    if (
      (token.startsWith("{") && token.endsWith("}")) ||
      (token.startsWith("[") && token.endsWith("]"))
    ) {
      try {
        const parsed = JSON.parse(token) as unknown;
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          Object.assign(result, parsed as WorkflowInputValues);
        }
        continue;
      } catch {}
    }
    const eqIdx = token.indexOf("=");
    if (eqIdx > 0) {
      const key = token.slice(0, eqIdx);
      const raw = token.slice(eqIdx + 1);
      let value: WorkflowSerializableValue = raw;
      try {
        value = JSON.parse(raw) as WorkflowSerializableValue;
      } catch {}
      result[key] = value;
    }
  }
  return result;
}
