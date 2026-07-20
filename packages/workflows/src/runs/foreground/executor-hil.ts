import { createHash } from "node:crypto";
import { createAskUserQuestionToolDefinition } from "@bastani/atomic";
import { stageUiBroker } from "../../shared/stage-ui-broker.js";
import { buildStagePromptAdapter } from "../../shared/stage-prompt.js";
import type {
  WorkflowCustomUiFactory,
  WorkflowCustomUiOptions,
  WorkflowUIAdapter,
  WorkflowUIContext,
} from "../../shared/types.js";
import type { PendingPrompt, CustomPromptIdentitySource } from "../../shared/store-types.js";
import { selectPromptCallsiteFrame } from "../shared/prompt-callsite.js";
import { currentPromptCallerStack } from "../../shared/prompt-callsite-context.js";
import type { ResumeContinuationReason } from "./executor-stage-types.js";

export type PrimitivePromptDescriptor =
  | { readonly kind: "input"; readonly message: string; readonly initial?: string }
  | { readonly kind: "confirm"; readonly message: string }
  | { readonly kind: "select"; readonly message: string; readonly choices: readonly string[] }
  | { readonly kind: "editor"; readonly message: string; readonly initial?: string };

export interface CustomPromptDescriptor<T> {
  readonly kind: "custom";
  readonly message: string;
  readonly factory: WorkflowCustomUiFactory<T>;
  readonly options?: WorkflowCustomUiOptions;
  readonly customIdentityHash: string;
  readonly customIdentitySource: CustomPromptIdentitySource;
}

export type PromptDescriptor<T = unknown> = PrimitivePromptDescriptor | CustomPromptDescriptor<T>;

export function isCustomPromptDescriptor<T>(descriptor: PromptDescriptor<T>): descriptor is CustomPromptDescriptor<T> {
  return descriptor.kind === "custom";
}

export function fallbackForPromptDescriptor(descriptor: PrimitivePromptDescriptor): unknown {
  switch (descriptor.kind) {
    case "input":
    case "editor":
      return descriptor.initial ?? "";
    case "confirm":
      return false;
    case "select":
      return descriptor.choices[0] ?? "";
  }
}

export function makePrompt(descriptor: PromptDescriptor): PendingPrompt {
  return {
    id: `hil-${crypto.randomUUID()}`,
    kind: descriptor.kind,
    message: descriptor.message,
    ...(!isCustomPromptDescriptor(descriptor) && descriptor.kind === "select" ? { choices: descriptor.choices } : {}),
    ...(!isCustomPromptDescriptor(descriptor) && (descriptor.kind === "input" || descriptor.kind === "editor") && descriptor.initial !== undefined ? { initial: descriptor.initial } : {}),
    ...(isCustomPromptDescriptor(descriptor) ? {
      customIdentityHash: descriptor.customIdentityHash,
      customIdentitySource: descriptor.customIdentitySource,
    } : {}),
    createdAt: Date.now(),
  };
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

function promptDescriptorHash(descriptor: PromptDescriptor): string {
  if (isCustomPromptDescriptor(descriptor)) {
    return stableHash({
      kind: "custom",
      customIdentityHash: descriptor.customIdentityHash,
    });
  }
  return stableHash({
    kind: descriptor.kind,
    message: descriptor.message,
    choices: descriptor.kind === "select" ? descriptor.choices : [],
    initial: descriptor.kind === "input" || descriptor.kind === "editor" ? descriptor.initial ?? null : null,
  });
}

export function promptReplayKey(descriptor: PromptDescriptor): string {
  return `prompt:${descriptor.kind}:${promptDescriptorHash(descriptor)}:${promptCallsiteHash()}`;
}

function promptCallsiteHash(): string {
  const frame = selectPromptCallsiteFrame(currentPromptCallerStack() ?? new Error().stack ?? "") ?? "unknown";
  return stableHash(frame);
}

export function hilAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("atomic-workflows: HIL aborted");
}

function resolveCustomPromptIdentity<T>(
  factory: WorkflowCustomUiFactory<T>,
  options: WorkflowCustomUiOptions | undefined,
): Pick<CustomPromptDescriptor<T>, "customIdentityHash" | "customIdentitySource"> {
  const replayIdentity = options?.replayIdentity?.trim();
  if (replayIdentity !== undefined && replayIdentity.length > 0) {
    return {
      customIdentityHash: stableHash({ source: "caller", value: replayIdentity }),
      customIdentitySource: "caller",
    };
  }
  if (factory.name.trim().length > 0) {
    return {
      customIdentityHash: stableHash({ source: "factory", value: factory.name }),
      customIdentitySource: "factory",
    };
  }
  try {
    const source = Function.prototype.toString.call(factory);
    if (source.trim().length > 0) {
      return {
        customIdentityHash: stableHash({ source: "factory", value: source }),
        customIdentitySource: "factory",
      };
    }
  } catch {
    // Fall through to callsite-only identity below.
  }
  return {
    customIdentityHash: stableHash({ source: "callsite" }),
    customIdentitySource: "callsite",
  };
}

export function customPromptDescriptor<T>(
  factory: WorkflowCustomUiFactory<T>,
  options: WorkflowCustomUiOptions | undefined,
): CustomPromptDescriptor<T> {
  const label = options?.label?.trim();
  return {
    kind: "custom",
    message: label && label.length > 0 ? label : "Custom TUI prompt",
    factory,
    ...(options !== undefined ? { options } : {}),
    ...resolveCustomPromptIdentity(factory, options),
  };
}

export interface MergedHilSignal {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
}

export function mergeHilSignals(primary: AbortSignal, secondary: AbortSignal | undefined): MergedHilSignal {
  if (secondary === undefined) return { signal: primary, dispose: () => undefined };
  const controller = new AbortController();
  const abortFrom = (source: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  const onPrimaryAbort = (): void => abortFrom(primary);
  const onSecondaryAbort = (): void => abortFrom(secondary);
  primary.addEventListener("abort", onPrimaryAbort, { once: true });
  secondary.addEventListener("abort", onSecondaryAbort, { once: true });
  if (primary.aborted) abortFrom(primary);
  else if (secondary.aborted) abortFrom(secondary);
  return {
    signal: controller.signal,
    dispose: () => {
      primary.removeEventListener("abort", onPrimaryAbort);
      secondary.removeEventListener("abort", onSecondaryAbort);
    },
  };
}

function makeRejectingUIContext(msg: (primitive: string) => string): WorkflowUIContext {
  return {
    input: () => Promise.reject(new Error(msg("input"))),
    confirm: () => Promise.reject(new Error(msg("confirm"))),
    select: () => Promise.reject(new Error(msg("select"))),
    editor: () => Promise.reject(new Error(msg("editor"))),
    custom: () => Promise.reject(new Error(msg("custom"))),
  };
}

function makeUnavailableUIContext(): WorkflowUIContext {
  return makeRejectingUIContext(
    (primitive) =>
      `atomic-workflows: HIL ctx.ui.${primitive} is unavailable because Atomic runtime did not provide a UI adapter`,
  );
}

export function makeHeadlessUnavailableUIContext(): WorkflowUIContext {
  return makeRejectingUIContext(
    (primitive) =>
      `atomic-workflows: interactive ctx.ui.${primitive} is unavailable in headless (non-interactive) mode; run the workflow in interactive mode or remove the interactive prompt from this stage`,
  );
}

export function normalizeUIContext(adapter: WorkflowUIAdapter | undefined): WorkflowUIContext {
  const unavailable = makeUnavailableUIContext();
  if (adapter === undefined) return unavailable;
  return {
    input(prompt) {
      return typeof adapter.input === "function"
        ? adapter.input.call(adapter, prompt)
        : unavailable.input(prompt);
    },
    confirm(message) {
      return typeof adapter.confirm === "function"
        ? adapter.confirm.call(adapter, message)
        : unavailable.confirm(message);
    },
    select<T extends string>(message: string, options: readonly T[]): Promise<T> {
      return typeof adapter.select === "function"
        ? adapter.select.call(adapter, message, options) as Promise<T>
        : unavailable.select(message, options);
    },
    editor(initial) {
      return typeof adapter.editor === "function"
        ? adapter.editor.call(adapter, initial)
        : unavailable.editor(initial);
    },
    custom<T>(factory: WorkflowCustomUiFactory<T>, options?: WorkflowCustomUiOptions): Promise<T> {
      return typeof adapter.custom === "function"
        ? adapter.custom.call(adapter, factory, options) as Promise<T>
        : unavailable.custom(factory, options);
    },
  };
}

type AskUserQuestionToolEvent =
  | { phase: "start"; callId?: string; args?: unknown }
  | { phase: "end"; callId?: string; nameMatched: boolean };

function stringField(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

function isAskUserQuestionToolName(name: string | undefined): boolean {
  if (name === undefined) return false;
  return name.toLowerCase().replace(/[^a-z0-9]/g, "") === "askuserquestion";
}

export function askUserQuestionToolEvent(event: unknown): AskUserQuestionToolEvent | undefined {
  if (event === null || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  const type = typeof record["type"] === "string" ? record["type"] : "";
  const toolName = stringField(record, ["toolName", "tool_name", "name"]);
  const callId = stringField(record, ["toolCallId", "tool_call_id", "toolUseId", "tool_use_id", "id"]);

  if (type === "tool_execution_start" && isAskUserQuestionToolName(toolName)) {
    return { phase: "start", callId, args: record["args"] };
  }
  if (type === "tool_execution_end" || type === "tool_execution_error" || type === "tool_result") {
    return { phase: "end", callId, nameMatched: isAskUserQuestionToolName(toolName) };
  }
  return undefined;
}

export const READINESS_GATE_ADVANCE_LABEL = "I'm ready to move on to the next workflow stage.";

const READINESS_GATE_ADVANCE_NORMALIZED = READINESS_GATE_ADVANCE_LABEL.trim().toLowerCase();

export const READINESS_GATE_QUESTION_PARAMS = {
  questions: [
    {
      question: "Are you ready to move on to the next stage?",
      header: "Continue?",
      options: [
        {
          label: READINESS_GATE_ADVANCE_LABEL,
          description: "Complete this stage and advance the workflow.",
        },
        {
          label: "I have more to explore or ask about.",
          description: "Stay in this stage and keep working in the chat composer.",
        },
      ],
    },
  ],
};

export function readinessResultMeansAdvance(result: unknown): boolean {
  if (result === null || typeof result !== "object") return false;
  const details = (result as {
    details?: {
      answers?: ReadonlyArray<{ answer?: unknown; selected?: ReadonlyArray<unknown> }>;
      cancelled?: boolean;
    };
  }).details;
  if (details === undefined || details.cancelled === true) return false;
  const first = details.answers?.[0];
  if (first === undefined) return false;
  const candidates: unknown[] = [first.answer];
  if (Array.isArray(first.selected)) candidates.push(...first.selected);
  return candidates.some(
    (candidate) =>
      typeof candidate === "string" &&
      candidate.trim().toLowerCase() === READINESS_GATE_ADVANCE_NORMALIZED,
  );
}

export function toolResultHasChatAnswer(result: unknown): boolean {
  if (result === null || typeof result !== "object") return false;
  const details = (result as Record<string, unknown>)["details"];
  if (details === null || typeof details !== "object") return false;
  const answers = (details as Record<string, unknown>)["answers"];
  if (!Array.isArray(answers)) return false;
  return answers.some(
    (a) => a !== null && typeof a === "object" && (a as Record<string, unknown>)["kind"] === "chat",
  );
}

export { RESUME_CONTINUATION_PROMPT } from "../../shared/resume-continuation.js";

export function shouldInjectResumeContinuation(state: {
  readonly reason: ResumeContinuationReason | false;
  readonly gateEnabled: boolean;
  readonly aborted: boolean;
}): boolean {
  if (state.reason === false || state.aborted) return false;
  return state.reason === "queued-user-message" || state.gateEnabled;
}

let cachedReadinessGateTool: ReturnType<typeof createAskUserQuestionToolDefinition> | undefined;
function readinessGateTool(): ReturnType<typeof createAskUserQuestionToolDefinition> {
  return (cachedReadinessGateTool ??= createAskUserQuestionToolDefinition());
}

export async function askReadinessViaStageBroker(
  runId: string,
  stageId: string,
  signal: AbortSignal,
): Promise<"advance" | "stay"> {
  const execute = readinessGateTool().execute;
  if (execute === undefined) return "advance";
  const gateContext = {
    hasUI: true,
    ui: {
      custom: (factory: unknown, options?: unknown): Promise<unknown> =>
        stageUiBroker.requestCustomUi(
          runId,
          stageId,
          factory as Parameters<typeof stageUiBroker.requestCustomUi>[2],
          options as Parameters<typeof stageUiBroker.requestCustomUi>[3],
          signal,
        ),
    },
  };
  const gatePromptId = `readiness-gate-${stageId}-${crypto.randomUUID()}`;
  const gateAdapter = buildStagePromptAdapter(
    gatePromptId,
    "readiness_gate",
    READINESS_GATE_QUESTION_PARAMS,
    Date.now(),
  );
  if (gateAdapter) stageUiBroker.provideStagePrompt(runId, stageId, gateAdapter);
  try {
    const result = await execute(
      gatePromptId,
      READINESS_GATE_QUESTION_PARAMS as Parameters<typeof execute>[1],
      signal,
      undefined,
      gateContext as unknown as Parameters<typeof execute>[4],
    );
    return readinessResultMeansAdvance(result) ? "advance" : "stay";
  } finally {
    stageUiBroker.clearStagePrompt(runId, stageId);
  }
}
