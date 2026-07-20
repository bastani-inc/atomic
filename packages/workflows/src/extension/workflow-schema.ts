import { Type, type Static } from "typebox";

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
    Type.Literal("quit"),
    Type.Literal("resume"),
    Type.Literal("reload"),
  ], {
    description: "Workflow action: run/list/get/inputs/status, inspect stage metadata, send messages or prompt answers, pause/resume/interrupt/quit runs, or reload workflow resources. 'status' without runId lists every workflow run in the current session with concise per-run summaries (status, timing, active stages, awaiting-input prompts); filter the listing with statusFilter. 'status' with runId returns one run's full detail. For transcript inspection, prefer status/stages/stage first to get sessionFile/transcriptPath, quote the exact path without rewriting separators (Windows backslashes are valid), then search it with rg/grep and read small ranges; transcript is path-only by default when sessionFile/transcriptPath exists, explicit tail/limit returns bounded previews, and missing transcript paths fall back to a small preview.",
  })),
  runId: Type.Optional(Type.String({
    description: "Run identifier or unique prefix for status/stages/stage/transcript/send/pause/resume/interrupt/quit. Omit runId with action 'status' to list all session runs and their statuses. Use '--all' or all:true for supported bulk run-control actions.",
  })),
  all: Type.Optional(Type.Boolean({
    description: "Apply supported run-control actions (pause/interrupt/quit) to all in-flight runs instead of one run; cannot be combined with stageId.",
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
    Type.Literal("cancelled"),
    Type.Literal("killed"),
    Type.Literal("all"),
  ], {
    description: "Filter stages (stages action) or listed runs (status action without runId) by status; 'all' (default) includes everything. For the status listing, run statuses match directly, 'awaiting_input' selects runs with at least one stage awaiting input or pending human prompt, and in-flight runs are listed first.",
  })),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")], {
    description: "Agent-visible output format for data-bearing inspection actions (status, stages, stage, transcript); 'json' returns the full structured result.",
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
}, { additionalProperties: false });

export type WorkflowParameters = Static<typeof WorkflowParametersSchema>;
