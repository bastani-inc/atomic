import { z, type ZodTypeAny } from "zod";

// ---------------------------------------------------------------------------
// Shared primitive schemas
// ---------------------------------------------------------------------------

export const AgentTypeSchema = z.enum(["claude", "copilot", "opencode"]);
export type AgentType = z.infer<typeof AgentTypeSchema>;

export const WorkflowOverallStatusSchema = z.enum(["complete", "error", "cancelled"]);
export type WorkflowOverallStatus = z.infer<typeof WorkflowOverallStatusSchema>;

// Opaque passthrough for WorkflowStatusSnapshot — spec says "passthrough record"
export const WorkflowStatusSnapshotSchema = z.record(z.string(), z.unknown());
export type WorkflowStatusSnapshot = z.infer<typeof WorkflowStatusSnapshotSchema>;

// Opaque passthrough for SavedMessage — spec says "passthrough"
export const SavedMessageSchema = z.record(z.string(), z.unknown());
export type SavedMessage = z.infer<typeof SavedMessageSchema>;

export const WorkflowDescriptorSchema = z.object({
  name: z.string(),
  source: z.string(),
  agent: AgentTypeSchema,
  displayName: z.string().optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
});
export type WorkflowDescriptor = z.infer<typeof WorkflowDescriptorSchema>;

export const BrokenEntrySchema = z.object({
  source: z.string(),
  error: z.string(),
});
export type BrokenEntry = z.infer<typeof BrokenEntrySchema>;

export const RunInfoSchema = z.object({
  runId: z.string(),
  workflowName: z.string(),
  agent: AgentTypeSchema,
  status: z.string(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
});
export type RunInfo = z.infer<typeof RunInfoSchema>;

// ---------------------------------------------------------------------------
// Method schemas
// ---------------------------------------------------------------------------

// protocol/getVersion
export const ProtocolGetVersionParamsSchema = z.object({});
export type ProtocolGetVersionParams = z.infer<typeof ProtocolGetVersionParamsSchema>;

export const ProtocolGetVersionResultSchema = z.object({
  protocolVersion: z.string(),
  sdkVersion: z.string(),
  atomicVersion: z.string(),
});
export type ProtocolGetVersionResult = z.infer<typeof ProtocolGetVersionResultSchema>;

// connect
export const ConnectParamsSchema = z.object({
  token: z.string().optional(),
  clientName: z.string(),
});
export type ConnectParams = z.infer<typeof ConnectParamsSchema>;

export const ConnectResultSchema = z.object({ ok: z.literal(true) });
export type ConnectResult = z.infer<typeof ConnectResultSchema>;

// protocol/sendTelemetry
export const ProtocolSendTelemetryParamsSchema = z.object({
  event: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type ProtocolSendTelemetryParams = z.infer<typeof ProtocolSendTelemetryParamsSchema>;

export const ProtocolSendTelemetryResultSchema = z.object({ ok: z.literal(true) });
export type ProtocolSendTelemetryResult = z.infer<typeof ProtocolSendTelemetryResultSchema>;

// workflow/list
export const WorkflowListParamsSchema = z.object({});
export type WorkflowListParams = z.infer<typeof WorkflowListParamsSchema>;

export const WorkflowListResultSchema = z.array(WorkflowDescriptorSchema);
export type WorkflowListResult = z.infer<typeof WorkflowListResultSchema>;

// workflow/refresh
export const WorkflowRefreshParamsSchema = z.object({});
export type WorkflowRefreshParams = z.infer<typeof WorkflowRefreshParamsSchema>;

export const WorkflowRefreshResultSchema = z.object({
  count: z.number(),
  broken: z.array(BrokenEntrySchema),
});
export type WorkflowRefreshResult = z.infer<typeof WorkflowRefreshResultSchema>;

// workflow/start
export const WorkflowStartParamsSchema = z.object({
  source: z.string(),
  workflowName: z.string(),
  agent: AgentTypeSchema,
  inputs: z.record(z.string(), z.unknown()),
});
export type WorkflowStartParams = z.infer<typeof WorkflowStartParamsSchema>;

export const WorkflowStartResultSchema = z.object({
  runId: z.string(),
  attachable: z.literal(true),
});
export type WorkflowStartResult = z.infer<typeof WorkflowStartResultSchema>;

// run/list
export const RunListParamsSchema = z.object({
  scope: z.enum(["active", "completed", "all"]).optional(),
});
export type RunListParams = z.infer<typeof RunListParamsSchema>;

export const RunListResultSchema = z.array(RunInfoSchema);
export type RunListResult = z.infer<typeof RunListResultSchema>;

// run/get
export const RunGetParamsSchema = z.object({ runId: z.string() });
export type RunGetParams = z.infer<typeof RunGetParamsSchema>;

export const RunGetResultSchema = RunInfoSchema.nullable();
export type RunGetResult = z.infer<typeof RunGetResultSchema>;

// run/status
export const RunStatusParamsSchema = z.object({ runId: z.string() });
export type RunStatusParams = z.infer<typeof RunStatusParamsSchema>;

export const RunStatusResultSchema = WorkflowStatusSnapshotSchema.nullable();
export type RunStatusResult = z.infer<typeof RunStatusResultSchema>;

// run/transcript
export const RunTranscriptParamsSchema = z.object({
  runId: z.string(),
  sessionName: z.string(),
});
export type RunTranscriptParams = z.infer<typeof RunTranscriptParamsSchema>;

export const RunTranscriptResultSchema = z.array(SavedMessageSchema);
export type RunTranscriptResult = z.infer<typeof RunTranscriptResultSchema>;

// run/stop
export const RunStopParamsSchema = z.object({ runId: z.string() });
export type RunStopParams = z.infer<typeof RunStopParamsSchema>;

export const RunStopResultSchema = z.object({ ok: z.literal(true) });
export type RunStopResult = z.infer<typeof RunStopResultSchema>;

// run/getAttachInfo
export const RunGetAttachInfoParamsSchema = z.object({ runId: z.string() });
export type RunGetAttachInfoParams = z.infer<typeof RunGetAttachInfoParamsSchema>;

export const RunGetAttachInfoResultSchema = z.object({
  subscriptionId: z.string(),
  foregroundStage: z.string().nullable(),
});
export type RunGetAttachInfoResult = z.infer<typeof RunGetAttachInfoResultSchema>;

// run/setForeground
export const RunSetForegroundParamsSchema = z.object({
  runId: z.string(),
  stageName: z.string().optional(),
});
export type RunSetForegroundParams = z.infer<typeof RunSetForegroundParamsSchema>;

export const RunSetForegroundResultSchema = z.object({ ok: z.literal(true) });
export type RunSetForegroundResult = z.infer<typeof RunSetForegroundResultSchema>;

// pane/sendInput
export const PaneSendInputParamsSchema = z.object({
  runId: z.string(),
  stageName: z.string(),
  data: z.string(),
});
export type PaneSendInputParams = z.infer<typeof PaneSendInputParamsSchema>;

export const PaneSendInputResultSchema = z.object({ ok: z.literal(true) });
export type PaneSendInputResult = z.infer<typeof PaneSendInputResultSchema>;

// pane/getScrollback
export const PaneGetScrollbackParamsSchema = z.object({
  runId: z.string(),
  stageName: z.string(),
  fromOffset: z.number().optional(),
});
export type PaneGetScrollbackParams = z.infer<typeof PaneGetScrollbackParamsSchema>;

export const PaneGetScrollbackResultSchema = z.object({
  data: z.string(),
  headOffset: z.number(),
});
export type PaneGetScrollbackResult = z.infer<typeof PaneGetScrollbackResultSchema>;

// panel/get
export const PanelGetParamsSchema = z.object({ runId: z.string() });
export type PanelGetParams = z.infer<typeof PanelGetParamsSchema>;

export const PanelGetResultSchema = WorkflowStatusSnapshotSchema;
export type PanelGetResult = z.infer<typeof PanelGetResultSchema>;

// panel/subscribe
export const PanelSubscribeParamsSchema = z.object({
  runId: z.string().optional(),
});
export type PanelSubscribeParams = z.infer<typeof PanelSubscribeParamsSchema>;

export const PanelSubscribeResultSchema = z.object({ subscriptionId: z.string() });
export type PanelSubscribeResult = z.infer<typeof PanelSubscribeResultSchema>;

// panel/unsubscribe
export const PanelUnsubscribeParamsSchema = z.object({ subscriptionId: z.string() });
export type PanelUnsubscribeParams = z.infer<typeof PanelUnsubscribeParamsSchema>;

export const PanelUnsubscribeResultSchema = z.object({ ok: z.literal(true) });
export type PanelUnsubscribeResult = z.infer<typeof PanelUnsubscribeResultSchema>;

// agent/spawn
export const AgentSpawnParamsSchema = z.object({
  runId: z.string(),
  stageName: z.string(),
  agent: AgentTypeSchema,
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()).optional(),
});
export type AgentSpawnParams = z.infer<typeof AgentSpawnParamsSchema>;

export const AgentSpawnResultSchema = z.object({
  pid: z.number(),
  scrollbackBytes: z.literal(0),
});
export type AgentSpawnResult = z.infer<typeof AgentSpawnResultSchema>;

// agent/kill
export const AgentKillParamsSchema = z.object({
  pid: z.number(),
  signal: z.enum(["SIGTERM", "SIGKILL"]).optional(),
});
export type AgentKillParams = z.infer<typeof AgentKillParamsSchema>;

export const AgentKillResultSchema = z.object({ ok: z.literal(true) });
export type AgentKillResult = z.infer<typeof AgentKillResultSchema>;

// ---------------------------------------------------------------------------
// Notification schemas (params only)
// ---------------------------------------------------------------------------

export const PanelUpdateNotificationParamsSchema = z.object({
  runId: z.string(),
  snapshot: WorkflowStatusSnapshotSchema,
});
export type PanelUpdateNotificationParams = z.infer<typeof PanelUpdateNotificationParamsSchema>;

export const PanelForegroundChangeNotificationParamsSchema = z.object({
  runId: z.string(),
  stageName: z.string().nullable(),
});
export type PanelForegroundChangeNotificationParams = z.infer<
  typeof PanelForegroundChangeNotificationParamsSchema
>;

export const PaneOutputNotificationParamsSchema = z.object({
  runId: z.string(),
  stageName: z.string(),
  data: z.string(),
  offset: z.number(),
});
export type PaneOutputNotificationParams = z.infer<typeof PaneOutputNotificationParamsSchema>;

export const PaneExitNotificationParamsSchema = z.object({
  runId: z.string(),
  stageName: z.string(),
  exitCode: z.number(),
  signal: z.string().optional(),
});
export type PaneExitNotificationParams = z.infer<typeof PaneExitNotificationParamsSchema>;

export const RunStartedNotificationParamsSchema = z.object({
  runId: z.string(),
  workflowName: z.string(),
  agent: AgentTypeSchema,
});
export type RunStartedNotificationParams = z.infer<typeof RunStartedNotificationParamsSchema>;

export const RunEndedNotificationParamsSchema = z.object({
  runId: z.string(),
  overall: WorkflowOverallStatusSchema,
  fatalError: z.string().optional(),
});
export type RunEndedNotificationParams = z.infer<typeof RunEndedNotificationParamsSchema>;

export const ServerClosingNotificationParamsSchema = z.object({
  reason: z.enum(["shutdown", "fatal"]),
});
export type ServerClosingNotificationParams = z.infer<typeof ServerClosingNotificationParamsSchema>;

// ---------------------------------------------------------------------------
// Central registries
// ---------------------------------------------------------------------------

export interface MethodSchemaEntry {
  params: ZodTypeAny;
  result: ZodTypeAny;
}

export const MethodSchemas: Record<string, MethodSchemaEntry> = {
  "protocol/getVersion": {
    params: ProtocolGetVersionParamsSchema,
    result: ProtocolGetVersionResultSchema,
  },
  connect: {
    params: ConnectParamsSchema,
    result: ConnectResultSchema,
  },
  "protocol/sendTelemetry": {
    params: ProtocolSendTelemetryParamsSchema,
    result: ProtocolSendTelemetryResultSchema,
  },
  "workflow/list": {
    params: WorkflowListParamsSchema,
    result: WorkflowListResultSchema,
  },
  "workflow/refresh": {
    params: WorkflowRefreshParamsSchema,
    result: WorkflowRefreshResultSchema,
  },
  "workflow/start": {
    params: WorkflowStartParamsSchema,
    result: WorkflowStartResultSchema,
  },
  "run/list": {
    params: RunListParamsSchema,
    result: RunListResultSchema,
  },
  "run/get": {
    params: RunGetParamsSchema,
    result: RunGetResultSchema,
  },
  "run/status": {
    params: RunStatusParamsSchema,
    result: RunStatusResultSchema,
  },
  "run/transcript": {
    params: RunTranscriptParamsSchema,
    result: RunTranscriptResultSchema,
  },
  "run/stop": {
    params: RunStopParamsSchema,
    result: RunStopResultSchema,
  },
  "run/getAttachInfo": {
    params: RunGetAttachInfoParamsSchema,
    result: RunGetAttachInfoResultSchema,
  },
  "run/setForeground": {
    params: RunSetForegroundParamsSchema,
    result: RunSetForegroundResultSchema,
  },
  "pane/sendInput": {
    params: PaneSendInputParamsSchema,
    result: PaneSendInputResultSchema,
  },
  "pane/getScrollback": {
    params: PaneGetScrollbackParamsSchema,
    result: PaneGetScrollbackResultSchema,
  },
  "panel/get": {
    params: PanelGetParamsSchema,
    result: PanelGetResultSchema,
  },
  "panel/subscribe": {
    params: PanelSubscribeParamsSchema,
    result: PanelSubscribeResultSchema,
  },
  "panel/unsubscribe": {
    params: PanelUnsubscribeParamsSchema,
    result: PanelUnsubscribeResultSchema,
  },
  "agent/spawn": {
    params: AgentSpawnParamsSchema,
    result: AgentSpawnResultSchema,
  },
  "agent/kill": {
    params: AgentKillParamsSchema,
    result: AgentKillResultSchema,
  },
};

export const NotificationSchemas: Record<string, ZodTypeAny> = {
  "panel/update": PanelUpdateNotificationParamsSchema,
  "panel/foregroundChange": PanelForegroundChangeNotificationParamsSchema,
  "pane/output": PaneOutputNotificationParamsSchema,
  "pane/exit": PaneExitNotificationParamsSchema,
  "run/started": RunStartedNotificationParamsSchema,
  "run/ended": RunEndedNotificationParamsSchema,
  "server/closing": ServerClosingNotificationParamsSchema,
};
