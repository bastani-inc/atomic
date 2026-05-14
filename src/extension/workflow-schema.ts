import { Type, type Static } from "typebox";

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

const DirectTaskSchema = Type.Object({
  name: Type.String({ description: "Task/stage label." }),
  prompt: Type.Optional(Type.String({ description: "Prompt text for this task." })),
  task: Type.Optional(Type.String({ description: "Task text for this task." })),
  context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")])),
  cwd: Type.Optional(Type.String()),
  output: Type.Optional(Type.Union([Type.String(), Type.Literal(false)])),
  outputMode: Type.Optional(Type.Union([Type.Literal("inline"), Type.Literal("file-only")])),
  reads: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Literal(false)])),
  progress: Type.Optional(Type.Boolean()),
  worktree: Type.Optional(Type.Boolean()),
  maxOutput: Type.Optional(Type.Object({
    bytes: Type.Optional(Type.Number()),
    lines: Type.Optional(Type.Number()),
  })),
  artifacts: Type.Optional(Type.Boolean()),
  sessionDir: Type.Optional(Type.String()),
  model: Type.Optional(Type.Any()),
  tools: Type.Optional(Type.Any()),
  toolNames: Type.Optional(Type.Array(Type.String())),
  noTools: Type.Optional(Type.Any()),
  thinkingLevel: Type.Optional(Type.String()),
  mcp: Type.Optional(Type.Object({
    allow: Type.Optional(Type.Array(Type.String())),
    deny: Type.Optional(Type.Array(Type.String())),
  })),
});

const ParallelChainStepSchema = Type.Object({
  parallel: Type.Array(DirectTaskSchema),
  concurrency: Type.Optional(Type.Number()),
  failFast: Type.Optional(Type.Boolean()),
  worktree: Type.Optional(Type.Boolean()),
});

export const WorkflowParametersSchema = Type.Object({
  workflow: Type.Optional(Type.String({
    description: "Named workflow ID for named-workflow execution.",
  })),
  inputs: Type.Optional(Type.Record(Type.String(), Type.Any(), {
    default: {},
    description: "Key/value inputs passed to a named workflow run.",
  })),
  action: Type.Optional(Type.Union([
    Type.Literal("run"),
    Type.Literal("list"),
    Type.Literal("get"),
    Type.Literal("inputs"),
    Type.Literal("status"),
    Type.Literal("interrupt"),
    Type.Literal("resume"),
    Type.Literal("doctor"),
  ])),
  runId: Type.Optional(Type.String({
    description: "Run identifier for status/interrupt/resume.",
  })),
  task: Type.Optional(Type.Union([
    DirectTaskSchema,
    Type.String({ description: "Root task text for direct chain/parallel execution." }),
  ])),
  chainName: Type.Optional(Type.String()),
  tasks: Type.Optional(Type.Array(DirectTaskSchema)),
  chain: Type.Optional(Type.Array(Type.Union([DirectTaskSchema, ParallelChainStepSchema]))),
  concurrency: Type.Optional(Type.Number()),
  async: Type.Optional(Type.Boolean()),
  intercom: Type.Optional(IntercomOptionsSchema),
  context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")])),
  cwd: Type.Optional(Type.String()),
  output: Type.Optional(Type.Union([Type.String(), Type.Literal(false)])),
  outputMode: Type.Optional(Type.Union([Type.Literal("inline"), Type.Literal("file-only")])),
  chainDir: Type.Optional(Type.String()),
  maxOutput: Type.Optional(Type.Object({
    bytes: Type.Optional(Type.Number()),
    lines: Type.Optional(Type.Number()),
  })),
  artifacts: Type.Optional(Type.Boolean()),
  sessionDir: Type.Optional(Type.String()),
  progress: Type.Optional(Type.Boolean()),
  worktree: Type.Optional(Type.Boolean()),
});

export type WorkflowParameters = Static<typeof WorkflowParametersSchema>;
