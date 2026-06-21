import type { CreateAgentSessionOptions } from "@bastani/atomic";
import { Type, type Static } from "typebox";
import type { WorkflowModelValue } from "../shared/types.js";

type ArrayElement<T> = T extends readonly (infer Element)[] ? Element : never;

const SdkSessionOptionSchema = <Key extends keyof CreateAgentSessionOptions>(_key: Key) =>
  Type.Unsafe<NonNullable<CreateAgentSessionOptions[Key]>>({});

const SdkSessionOptionArrayElementSchema = <Key extends keyof CreateAgentSessionOptions>(_key: Key) =>
  Type.Unsafe<ArrayElement<NonNullable<CreateAgentSessionOptions[Key]>>>({});

const IntercomOptionsSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  delivery: Type.Optional(Type.Union([
    Type.Literal("off"),
    Type.Literal("notify"),
    Type.Literal("result"),
    Type.Literal("control-and-result"),
  ])),
  parentSession: Type.Optional(Type.String()),
  notifyOn: Type.Optional(Type.Array(Type.Union([
    Type.Literal("active_long_running"),
    Type.Literal("needs_attention"),
    Type.Literal("completed"),
    Type.Literal("failed"),
  ]))),
});

const MaxOutputSchema = Type.Object({
  bytes: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number()),
});

const McpOptionsSchema = Type.Object({
  allow: Type.Optional(Type.Array(Type.String())),
  deny: Type.Optional(Type.Array(Type.String())),
});

const JsonSchemaObject = Type.Unsafe<Record<string, unknown>>({
  type: "object",
  additionalProperties: true,
  description: "Plain JSON Schema used as final-answer tool arguments for this workflow item.",
});

const BashCommandRuleSchema = Type.Union([
  Type.String(),
  Type.Object({ prefix: Type.String() }, { additionalProperties: false }),
  Type.Object({ glob: Type.String() }, { additionalProperties: false }),
  Type.Object({
    regex: Type.String(),
    flags: Type.Optional(Type.String()),
  }, { additionalProperties: false }),
]);

const BashCommandPolicySchema = Type.Object({
  default: Type.Optional(Type.Union([Type.Literal("allow"), Type.Literal("deny")])),
  allow: Type.Optional(Type.Array(BashCommandRuleSchema)),
  deny: Type.Optional(Type.Array(BashCommandRuleSchema)),
  match: Type.Optional(Type.Union([Type.Literal("whole"), Type.Literal("segments")])),
}, { additionalProperties: false });

const StageSessionOptionProperties = {
  schema: Type.Optional(JsonSchemaObject),
  cwd: Type.Optional(Type.String()),
  agentDir: Type.Optional(Type.String()),
  authStorage: Type.Optional(SdkSessionOptionSchema("authStorage")),
  modelRegistry: Type.Optional(SdkSessionOptionSchema("modelRegistry")),
  model: Type.Optional(Type.Unsafe<WorkflowModelValue>({ description: "Primary model id or SDK model object. String ids may include a reasoning suffix, e.g. openai/gpt-5:high; valid levels: off|minimal|low|medium|high|xhigh. A parenthesized context-window token may precede or follow the suffix, e.g. github-copilot/claude-opus-4.8 (1m):high or github-copilot/claude-opus-4.8:high (1m). Use (long) for a generic long-context marker, or a rounded size matching the model's long tier (e.g. (1m) or (1.1m)); both select the model's advertised long tier." })),
  contextWindow: Type.Optional(Type.Number({ description: "Context-window token budget for the stage session (e.g. 1000000). Non-strict by default: an unsupported value keeps the model's default window. Prefer the per-model `(1m)` token in a model/fallbackModels entry when only specific models should use a larger window." })),
  contextWindowStrict: Type.Optional(Type.Boolean({ description: "Treat an unsupported contextWindow as an error instead of falling back to the model's default window." })),
  thinkingLevel: Type.Optional(SdkSessionOptionSchema("thinkingLevel")),
  scopedModels: Type.Optional(Type.Array(SdkSessionOptionArrayElementSchema("scopedModels"))),
  noTools: Type.Optional(Type.Unsafe<NonNullable<CreateAgentSessionOptions["noTools"]>>({
    enum: ["all", "builtin"],
  })),
  tools: Type.Optional(Type.Array(Type.String())),
  customTools: Type.Optional(Type.Array(SdkSessionOptionArrayElementSchema("customTools"))),
  bashPolicy: Type.Optional(BashCommandPolicySchema),
  resourceLoader: Type.Optional(SdkSessionOptionSchema("resourceLoader")),
  sessionManager: Type.Optional(SdkSessionOptionSchema("sessionManager")),
  settingsManager: Type.Optional(SdkSessionOptionSchema("settingsManager")),
  sessionStartEvent: Type.Optional(SdkSessionOptionSchema("sessionStartEvent")),
  fallbackModels: Type.Optional(Type.Array(Type.String({ description: "Fallback model id; may include a reasoning suffix like :low or :off." }))),
  fallbackThinkingLevels: Type.Optional(Type.Array(Type.String({ description: "Deprecated compatibility helper aligned to fallbackModels; ignored when the fallback model has a :level suffix." }))),
  mcp: Type.Optional(McpOptionsSchema),
  sessionDir: Type.Optional(Type.String()),
  context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")])),
  forkFromSessionFile: Type.Optional(Type.String()),
};

const WorkflowTaskOptionProperties = {
  output: Type.Optional(Type.Union([Type.String(), Type.Literal(false)])),
  outputMode: Type.Optional(Type.Union([Type.Literal("inline"), Type.Literal("file-only")])),
  reads: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Literal(false)])),
  worktree: Type.Optional(Type.Boolean()),
  gitWorktreeDir: Type.Optional(Type.String()),
  baseBranch: Type.Optional(Type.String()),
  maxOutput: Type.Optional(MaxOutputSchema),
  artifacts: Type.Optional(Type.Boolean()),
};

const DirectTaskSchema = Type.Object({
  name: Type.String({ description: "Task/stage label." }),
  prompt: Type.Optional(Type.String({ description: "Prompt text for this task." })),
  task: Type.Optional(Type.String({ description: "Task text for this task." })),
  ...StageSessionOptionProperties,
  ...WorkflowTaskOptionProperties,
});

const ParallelChainStepSchema = Type.Object({
  parallel: Type.Array(DirectTaskSchema),
  concurrency: Type.Optional(Type.Number()),
  failFast: Type.Optional(Type.Boolean()),
  worktree: Type.Optional(Type.Boolean()),
  gitWorktreeDir: Type.Optional(Type.String()),
  baseBranch: Type.Optional(Type.String()),
});

export const WorkflowParametersSchema = Type.Object({
  workflow: Type.Optional(Type.String({
    description: "Named workflow ID for named-workflow execution.",
  })),
  inputs: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
    default: {},
    description: "Key/value inputs passed to a named workflow run.",
  })),
  action: Type.Optional(Type.Union([
    Type.Literal("run"),
    Type.Literal("list"),
    Type.Literal("get"),
    Type.Literal("inputs"),
    Type.Literal("status"),
    Type.Literal("stages"),
    Type.Literal("stage"),
    Type.Literal("transcript"),
    Type.Literal("send"),
    Type.Literal("pause"),
    Type.Literal("interrupt"),
    Type.Literal("kill"),
    Type.Literal("resume"),
    Type.Literal("reload"),
  ], {
    description: "Workflow action: run/list/get/inputs/status, inspect stage metadata, send messages or prompt answers, pause/resume/interrupt/kill runs, or reload workflow resources. For transcript inspection, prefer status/stages/stage first to get sessionFile/transcriptPath, quote the exact path without rewriting separators (Windows backslashes are valid), then search it with rg/grep and read small ranges; transcript is path-only by default when sessionFile/transcriptPath exists, explicit tail/limit returns bounded previews, and missing transcript paths fall back to a small preview.",
  })),
  runId: Type.Optional(Type.String({
    description: "Run identifier or unique prefix for status/stages/stage/transcript/send/pause/resume/interrupt/kill. Use '--all' or all:true for supported bulk run-control actions.",
  })),
  all: Type.Optional(Type.Boolean({
    description: "Apply supported run-control actions (pause/interrupt/kill) to all in-flight runs instead of one run; cannot be combined with stageId.",
  })),
  stageId: Type.Optional(Type.String({
    description: "Stage id, unique prefix, or stage name for stage-scoped inspection, transcript, send, pause, or resume.",
  })),
  message: Type.Optional(Type.String({
    description: "Message payload for send/follow-up/prompt/steer/resume, or optional text forwarded when resuming paused work.",
  })),
  statusFilter: Type.Optional(Type.Union([
    Type.Literal("pending"),
    Type.Literal("running"),
    Type.Literal("awaiting_input"),
    Type.Literal("paused"),
    Type.Literal("blocked"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("skipped"),
    Type.Literal("all"),
  ], {
    description: "Filter stages by status for the stages action; use 'all' to include every stage.",
  })),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")], {
    description: "Agent-visible output format for data-bearing inspection actions.",
  })),
  limit: Type.Optional(Type.Integer({
    minimum: 0,
    description: "Transcript-only: explicitly inline at most this many recent entries. Omit both limit and tail to use the path-only default when sessionFile/transcriptPath exists; prefer rg/grep on the exact quoted sessionFile/transcriptPath for targeted lookup without rewriting platform path separators.",
  })),
  tail: Type.Optional(Type.Integer({
    minimum: 0,
    description: "Transcript-only: explicitly inline the last N entries; overrides limit. Use for quick recent-context checks after status/stages/stage expose the transcript path.",
  })),
  includeToolOutput: Type.Optional(Type.Boolean({
    description: "Transcript-only: include captured tool output entries when building inlined snapshot previews; this does not bypass the path-only default. Prefer rg/grep on the exact quoted sessionFile/transcriptPath for large outputs. Live session transcripts may not expose tool output.",
  })),
  text: Type.Optional(Type.String({
    description: "Text to send to a stage for prompt answers, steering, follow-ups, or resume messages.",
  })),
  response: Type.Optional(Type.Unknown({
    description: "Structured response payload for answering a pending stage prompt.",
  })),
  delivery: Type.Optional(Type.Union([
    Type.Literal("auto"),
    Type.Literal("answer"),
    Type.Literal("prompt"),
    Type.Literal("steer"),
    Type.Literal("followUp"),
    Type.Literal("resume"),
  ], {
    description: "Delivery mode for the send action: auto answers pending prompts first, then resumes paused stages, steers streaming stages, or queues a follow-up.",
  })),
  promptId: Type.Optional(Type.String({
    description: "Pending prompt identifier to answer when using the send action.",
  })),
  reason: Type.Optional(Type.String({
    description: "Human-readable reason for the reload action, echoed in the reload result.",
  })),
  task: Type.Optional(Type.Union([
    DirectTaskSchema,
    Type.String({ description: "Root task text for direct chain/parallel execution." }),
  ])),
  chainName: Type.Optional(Type.String()),
  tasks: Type.Optional(Type.Array(DirectTaskSchema)),
  chain: Type.Optional(Type.Array(Type.Union([DirectTaskSchema, ParallelChainStepSchema]))),
  concurrency: Type.Optional(Type.Number()),
  failFast: Type.Optional(Type.Boolean()),
  async: Type.Optional(Type.Boolean()),
  intercom: Type.Optional(IntercomOptionsSchema),
  ...StageSessionOptionProperties,
  ...WorkflowTaskOptionProperties,
  chainDir: Type.Optional(Type.String()),
});

export type WorkflowParameters = Static<typeof WorkflowParametersSchema>;
