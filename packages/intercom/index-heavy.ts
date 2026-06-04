import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import { randomUUID } from "crypto";
import { appendFileSync } from "node:fs";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import { renderContactSupervisorResult, renderIntercomResult } from "./result-renderers.js";
import { APP_NAME, getEnvValue } from "@bastani/atomic";
import { IntercomClient } from "./broker/client.ts";
import { spawnBrokerIfNeeded } from "./broker/spawn.ts";
import { SessionListOverlay } from "./ui/session-list.ts";
import { ComposeOverlay, type ComposeResult } from "./ui/compose.ts";
import { InlineMessageComponent } from "./ui/inline-message.ts";
import { loadConfig, type IntercomConfig } from "./config.ts";
import type { SessionInfo, Message, Attachment } from "./types.ts";
import { ReplyTracker } from "./reply-tracker.ts";

if (process.env.ATOMIC_TEST_LAZY_IMPORT_SENTINEL === "1") {
  process.env.ATOMIC_INTERCOM_HEAVY_IMPORTED = "1";
}

if (process.env.ATOMIC_TEST_LAZY_IMPORT_SENTINEL_FILE) {
  appendFileSync(process.env.ATOMIC_TEST_LAZY_IMPORT_SENTINEL_FILE, "intercom\n");
}

const SUBAGENT_CONTROL_INTERCOM_EVENT = "subagent:control-intercom";
const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT = "subagent:result-intercom-delivery";
const INBOUND_FLUSH_DELAY_MS = 200;
const INBOUND_IDLE_RETRY_MS = 500;
const DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX = "subagent-chat";
const ENV_PREFIX = APP_NAME.toUpperCase();
const SUBAGENT_ORCHESTRATOR_TARGET_ENV = `${ENV_PREFIX}_SUBAGENT_ORCHESTRATOR_TARGET`;
const SUBAGENT_RUN_ID_ENV = `${ENV_PREFIX}_SUBAGENT_RUN_ID`;
const SUBAGENT_CHILD_AGENT_ENV = `${ENV_PREFIX}_SUBAGENT_CHILD_AGENT`;
const SUBAGENT_CHILD_INDEX_ENV = `${ENV_PREFIX}_SUBAGENT_CHILD_INDEX`;
const SUBAGENT_INTERCOM_SESSION_NAME_ENV = `${ENV_PREFIX}_SUBAGENT_INTERCOM_SESSION_NAME`;

interface ChildOrchestratorMetadata {
  orchestratorTarget: string;
  runId: string;
  agent: string;
  index: string;
  sessionName?: string;
}

interface InboundMessageEntry {
  from: SessionInfo;
  message: Message;
  replyCommand?: string;
  bodyText: string;
}

type ContactSupervisorReason = "need_decision" | "progress_update" | "interview_request";

interface SupervisorInterviewQuestion extends Record<string, unknown> {
  id: string;
  type: "single" | "multi" | "text" | "image" | "info";
  question: string;
  options?: unknown[];
}

interface SupervisorInterviewRequest extends Record<string, unknown> {
  title?: string;
  description?: string;
  questions: SupervisorInterviewQuestion[];
}

interface SupervisorInterviewReply {
  responses: Array<{ id: string; value: unknown }>;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function formatAttachments(attachments: Attachment[]): string {
  let text = "";
  for (const att of attachments) {
    if (att.language) {
      text += `\n\n---\n📎 ${att.name}\n~~~${att.language}\n${att.content}\n~~~`;
    } else {
      text += `\n\n---\n📎 ${att.name}\n${att.content}`;
    }
  }
  return text;
}
function readChildOrchestratorMetadata(): ChildOrchestratorMetadata | null {
  const orchestratorTarget = getEnvValue(SUBAGENT_ORCHESTRATOR_TARGET_ENV)?.trim();
  const runId = getEnvValue(SUBAGENT_RUN_ID_ENV)?.trim();
  const agent = getEnvValue(SUBAGENT_CHILD_AGENT_ENV)?.trim();
  const index = getEnvValue(SUBAGENT_CHILD_INDEX_ENV)?.trim();
  if (!orchestratorTarget || !runId || !agent || !index) {
    return null;
  }
  const sessionName = getEnvValue(SUBAGENT_INTERCOM_SESSION_NAME_ENV)?.trim();
  return {
    orchestratorTarget,
    runId,
    agent,
    index,
    ...(sessionName ? { sessionName } : {}),
  };
}
function formatChildOrchestratorMessage(kind: "ask" | "update" | "interview", metadata: ChildOrchestratorMetadata, message: string): string {
  const heading = kind === "ask"
    ? "Subagent needs a supervisor decision."
    : kind === "interview"
      ? "Subagent requests a structured supervisor interview."
      : "Subagent progress update.";
  return [
    heading,
    `Run: ${metadata.runId}`,
    `Agent: ${metadata.agent}`,
    `Child index: ${metadata.index}`,
    metadata.sessionName ? `Child intercom target: ${metadata.sessionName}` : undefined,
    "",
    message,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function validateSupervisorInterviewRequest(input: unknown): { ok: true; interview: SupervisorInterviewRequest } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "interview must be an object with a questions array" };
  }

  const raw = input as Record<string, unknown>;
  if (raw.title !== undefined && typeof raw.title !== "string") {
    return { ok: false, error: "interview.title must be a string when provided" };
  }
  if (raw.description !== undefined && typeof raw.description !== "string") {
    return { ok: false, error: "interview.description must be a string when provided" };
  }
  if (!Array.isArray(raw.questions) || raw.questions.length === 0) {
    return { ok: false, error: "interview.questions must be a non-empty array" };
  }

  const validTypes = new Set(["single", "multi", "text", "image", "info"]);
  const ids = new Set<string>();
  const questions: SupervisorInterviewQuestion[] = [];

  for (let index = 0; index < raw.questions.length; index++) {
    const questionInput = raw.questions[index];
    if (!questionInput || typeof questionInput !== "object" || Array.isArray(questionInput)) {
      return { ok: false, error: `interview.questions[${index}] must be an object` };
    }
    const question = questionInput as Record<string, unknown>;
    if (typeof question.id !== "string" || question.id.trim() === "") {
      return { ok: false, error: `interview.questions[${index}].id must be a non-empty string` };
    }
    const id = question.id.trim();
    if (ids.has(id)) {
      return { ok: false, error: `interview question id must be unique: ${id}` };
    }
    ids.add(id);

    if (typeof question.type !== "string" || !validTypes.has(question.type)) {
      return { ok: false, error: `interview.questions[${index}].type must be one of: single, multi, text, image, info` };
    }
    if (typeof question.question !== "string" || question.question.trim() === "") {
      return { ok: false, error: `interview.questions[${index}].question must be a non-empty string` };
    }
    if (question.context !== undefined && typeof question.context !== "string") {
      return { ok: false, error: `interview.questions[${index}].context must be a string when provided` };
    }
    let options: unknown[] | undefined;
    if (question.options !== undefined) {
      if (!Array.isArray(question.options)) {
        return { ok: false, error: `interview.questions[${index}].options must be an array when provided` };
      }
      options = [];
      for (let optionIndex = 0; optionIndex < question.options.length; optionIndex++) {
        const option = question.options[optionIndex];
        if (typeof option === "string") {
          const label = option.trim();
          if (!label) {
            return { ok: false, error: `interview.questions[${index}].options[${optionIndex}] must not be empty` };
          }
          options.push(label);
        } else if (!option || typeof option !== "object" || Array.isArray(option) || typeof (option as { label?: unknown }).label !== "string" || (option as { label: string }).label.trim() === "") {
          return { ok: false, error: `interview.questions[${index}].options[${optionIndex}] must be a non-empty string or an object with a non-empty label` };
        } else {
          options.push({ ...option, label: (option as { label: string }).label.trim() });
        }
      }
    }
    if ((question.type === "single" || question.type === "multi") && (!options || options.length === 0)) {
      return { ok: false, error: `interview.questions[${index}].options must be a non-empty array for ${question.type} questions` };
    }
    if (question.type !== "single" && question.type !== "multi" && options) {
      return { ok: false, error: `interview.questions[${index}].options is only valid for single and multi questions` };
    }

    questions.push({
      ...question,
      id,
      type: question.type as SupervisorInterviewQuestion["type"],
      question: question.question.trim(),
      ...(options ? { options } : {}),
    });
  }

  return {
    ok: true,
    interview: {
      ...raw,
      ...(typeof raw.title === "string" ? { title: raw.title.trim() } : {}),
      ...(typeof raw.description === "string" ? { description: raw.description.trim() } : {}),
      questions,
    },
  };
}

function interviewOptionLabel(option: unknown): string {
  return typeof option === "string" ? option : (option as { label: string }).label;
}

function interviewExampleValue(question: SupervisorInterviewQuestion): unknown {
  if (question.type === "multi") {
    return question.options?.slice(0, 2).map(interviewOptionLabel) ?? [];
  }
  if (question.type === "single") {
    return question.options?.[0] !== undefined ? interviewOptionLabel(question.options[0]) : "option label";
  }
  if (question.type === "image") {
    return "image/file reference or description";
  }
  return "answer text";
}

function formatSupervisorInterviewRequest(interview: SupervisorInterviewRequest, message?: string): string {
  const lines: string[] = [];
  const title = interview.title?.trim();
  if (title) lines.push(`Interview: ${title}`);
  const description = interview.description?.trim();
  if (description) lines.push(description);
  const note = message?.trim();
  if (note) lines.push(`Child note: ${note}`);
  if (lines.length > 0) lines.push("");

  lines.push("Questions:");
  interview.questions.forEach((question, index) => {
    lines.push(`${index + 1}. [${question.id}] (${question.type}) ${question.question}`);
    if (typeof question.context === "string" && question.context.trim()) {
      lines.push(`   Context: ${question.context.trim()}`);
    }
    if (question.options?.length) {
      lines.push("   Options:");
      for (const option of question.options) {
        lines.push(`   - ${interviewOptionLabel(option)}`);
      }
    }
  });

  const responseExample = {
    responses: interview.questions
      .filter((question) => question.type !== "info")
      .map((question) => ({
        id: question.id,
        value: interviewExampleValue(question),
      })),
  };

  lines.push(
    "",
    "Supervisor reply instructions:",
    "Reply with plain JSON or a fenced ```json block using this stable shape. Use the question ids exactly. Info questions are context-only and do not need responses. For single questions, value is one option label. For multi questions, value is an array of option labels. For text/image questions, value is a string unless the question asks otherwise.",
    "",
    "```json",
    JSON.stringify(responseExample, null, 2),
    "```",
  );

  return lines.join("\n");
}

function validateSupervisorInterviewReply(value: unknown, interview: SupervisorInterviewRequest): SupervisorInterviewReply {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("reply JSON must be an object with a responses array");
  }

  const responsesInput = (value as Record<string, unknown>).responses;
  if (!Array.isArray(responsesInput)) {
    throw new Error("reply JSON must include a responses array");
  }

  const questionById = new Map(interview.questions
    .filter((question) => question.type !== "info")
    .map((question) => [question.id, question]));
  const seenIds = new Set<string>();
  const responses: SupervisorInterviewReply["responses"] = [];

  for (let index = 0; index < responsesInput.length; index++) {
    const response = responsesInput[index];
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error(`responses[${index}] must be an object`);
    }

    const raw = response as Record<string, unknown>;
    if (typeof raw.id !== "string" || raw.id.trim() === "") {
      throw new Error(`responses[${index}].id must be a non-empty string`);
    }
    const id = raw.id.trim();
    const question = questionById.get(id);
    if (!question) {
      throw new Error(`responses[${index}].id must match a non-info interview question id`);
    }
    if (seenIds.has(id)) {
      throw new Error(`responses[${index}].id is duplicated: ${id}`);
    }
    seenIds.add(id);
    if (!Object.hasOwn(raw, "value")) {
      throw new Error(`responses[${index}].value is required`);
    }

    const value = raw.value;
    if (question.type === "single") {
      if (typeof value !== "string") throw new Error(`responses[${index}].value must be a string for single questions`);
      const optionLabels = new Set(question.options?.map(interviewOptionLabel));
      if (!optionLabels.has(value.trim())) throw new Error(`responses[${index}].value must match one of the question options`);
      responses.push({ id, value: value.trim() });
      continue;
    }

    if (question.type === "multi") {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new Error(`responses[${index}].value must be an array of strings for multi questions`);
      }
      const optionLabels = new Set(question.options?.map(interviewOptionLabel));
      const selected = value.map((item) => item.trim());
      const invalid = selected.find((item) => !optionLabels.has(item));
      if (invalid) throw new Error(`responses[${index}].value contains an option that is not in the question options: ${invalid}`);
      responses.push({ id, value: selected });
      continue;
    }

    if (typeof value !== "string") {
      throw new Error(`responses[${index}].value must be a string for ${question.type} questions`);
    }
    responses.push({ id, value });
  }

  return { responses };
}

function parseStructuredSupervisorReply(text: string, interview: SupervisorInterviewRequest): { value?: SupervisorInterviewReply; error?: string } | undefined {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fencedMatch?.[1] ?? text).trim();
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
    return undefined;
  }
  try {
    return { value: validateSupervisorInterviewReply(JSON.parse(candidate), interview) };
  } catch (error) {
    return { error: getErrorMessage(error) };
  }
}
function duplicateSessionNames(sessions: SessionInfo[]): Set<string> {
  return new Set(
    sessions
      .map(s => s.name?.toLowerCase())
      .filter((name): name is string => Boolean(name))
      .filter((name, index, names) => names.indexOf(name) !== index)
  );
}
function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}
function parseSubagentIntercomPayload(payload: unknown): { to: string; message: string; requestId?: string } | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.to !== "string" || typeof record.message !== "string") {
    return null;
  }
  const requestId = typeof record.requestId === "string" ? record.requestId : undefined;
  return { to: record.to, message: record.message, ...(requestId ? { requestId } : {}) };
}
function resolveIntercomPresenceName(sessionName: string | undefined, sessionId: string): string {
  const trimmedName = sessionName?.trim();
  if (trimmedName) {
    return trimmedName;
  }
  const normalizedSessionId = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
  return `${DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX}-${normalizedSessionId.slice(0, 8)}`;
}
function buildPresenceIdentity(pi: ExtensionAPI, sessionId: string): { name: string } {
  return {
    name: resolveIntercomPresenceName(pi.getSessionName(), sessionId),
  };
}
function formatSessionLabel(session: SessionInfo, duplicates: Set<string>): string {
  if (!session.name) {
    return session.id;
  }
  return duplicates.has(session.name.toLowerCase())
    ? `${session.name} (${shortSessionId(session.id)})`
    : session.name;
}
function formatSessionListRow(session: SessionInfo, currentCwd: string, isSelf: boolean): string {
  const name = session.name || "Unnamed session";
  const tags = [isSelf ? "self" : session.cwd === currentCwd ? "same cwd" : undefined, session.status]
    .filter((tag): tag is string => Boolean(tag));
  const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
  return `• ${name} (${shortSessionId(session.id)}) — ${session.cwd} (${session.model})${suffix}`;
}
function previewText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}
export default function piIntercomExtension(pi: ExtensionAPI) {
  let client: IntercomClient | null = null;
  const config: IntercomConfig = loadConfig();
  let runtimeContext: ExtensionContext | null = null;
  let currentSessionId: string | null = null;
  let currentModel = "unknown";
  let sessionStartedAt: number | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectPromise: Promise<IntercomClient> | null = null;
  let reconnectPromiseGeneration: number | null = null;
  let startupConnectTimer: NodeJS.Timeout | null = null;
  let reconnectAttempt = 0;
  let shuttingDown = false;
  let disposed = true;
  let runtimeStarted = false;
  let runtimeGeneration = 0;
  let agentRunning = false;
  const activeTools = new Map<string, string>();
  const replyTracker = new ReplyTracker();
  const pendingIdleMessages: InboundMessageEntry[] = [];
  let inboundFlushTimer: NodeJS.Timeout | null = null;
  let replyWaiter: {
    from: string;
    replyTo: string;
    resolve: (message: Message) => void;
    reject: (error: Error) => void;
  } | null = null;
  function waitForReply(from: string, replyTo: string, signal?: AbortSignal): Promise<Message> {
    if (replyWaiter) {
      return Promise.reject(new Error("Already waiting for a reply"));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error("Cancelled"));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        rejectReplyWaiter(new Error(`No reply from "${from}" within 10 minutes`));
      }, 10 * 60 * 1000);
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        if (replyWaiter?.replyTo === replyTo) {
          replyWaiter = null;
        }
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("Cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      replyWaiter = {
        from,
        replyTo,
        resolve: (message) => {
          cleanup();
          resolve(message);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
    });
  }
  function rejectReplyWaiter(error: Error): void {
    replyWaiter?.reject(error);
  }
  function clearReconnectTimer(): void {
    if (!reconnectTimer) {
      return;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  function clearStartupConnectTimer(): void {
    if (!startupConnectTimer) {
      return;
    }
    clearTimeout(startupConnectTimer);
    startupConnectTimer = null;
  }
  function clearInboundFlushTimer(): void {
    if (!inboundFlushTimer) {
      return;
    }
    clearTimeout(inboundFlushTimer);
    inboundFlushTimer = null;
  }
  function getLiveContext(ctx: ExtensionContext | null = runtimeContext, generation = runtimeGeneration): ExtensionContext | null {
    if (disposed || shuttingDown || generation !== runtimeGeneration || !ctx) {
      return null;
    }
    try {
      if (currentSessionId && ctx.sessionManager.getSessionId() !== currentSessionId) {
        return null;
      }
      void ctx.hasUI;
      return ctx;
    } catch {
      // A context that throws while reading session/UI state is no longer usable.
      return null;
    }
  }
  function notifyIfLive(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error", generation = runtimeGeneration): void {
    const liveContext = getLiveContext(ctx, generation);
    if (!liveContext?.hasUI) {
      return;
    }
    try {
      liveContext.ui.notify(message, level);
    } catch {
      // The UI can disappear during session shutdown/reload while async overlay work is settling.
    }
  }
  function getReconnectDelayMs(): number {
    const backoffMs = [1000, 2000, 5000, 10000, 30000];
    return backoffMs[Math.min(reconnectAttempt, backoffMs.length - 1)]!;
  }
  function currentStatus(): string {
    const activeToolName = activeTools.values().next().value;
    const lifecycleStatus = activeToolName ? `tool:${activeToolName}` : agentRunning ? "thinking" : "idle";
    return config.status ? `${lifecycleStatus} · ${config.status}` : lifecycleStatus;
  }
  function buildRegistration(): Omit<SessionInfo, "id"> {
    const liveContext = getLiveContext();
    if (!liveContext || !currentSessionId || sessionStartedAt === null) {
      throw new Error("Intercom runtime not initialized");
    }

    const identity = buildPresenceIdentity(pi, currentSessionId);
    return {
      name: identity.name,
      cwd: liveContext.cwd ?? process.cwd(),
      model: currentModel,
      pid: process.pid,
      startedAt: sessionStartedAt,
      lastActivity: Date.now(),
      status: currentStatus(),
    };
  }
  function syncPresenceIdentity(sessionId: string): void {
    if (!client || !getLiveContext()) {
      return;
    }
    client.updatePresence({ ...buildPresenceIdentity(pi, sessionId), status: currentStatus() });
  }
  function syncPresenceStatus(): void {
    if (!client || !currentSessionId || !getLiveContext()) {
      return;
    }
    client.updatePresence({ status: currentStatus() });
  }
  function currentSessionTargetMatches(to: string, resolvedTo?: string | null, activeClient?: IntercomClient): boolean {
    const targets = new Set<string>();
    const addTarget = (target: string | undefined | null) => {
      const trimmed = target?.trim();
      if (trimmed) targets.add(trimmed.toLowerCase());
    };
    addTarget(currentSessionId);
    addTarget(activeClient?.sessionId);
    addTarget(pi.getSessionName());
    if (currentSessionId) addTarget(buildPresenceIdentity(pi, currentSessionId).name);
    return Boolean(resolvedTo && activeClient?.sessionId && resolvedTo === activeClient.sessionId)
      || targets.has(to.trim().toLowerCase());
  }
  function sendIncomingMessage(entry: InboundMessageEntry, delivery: "trigger" | "followUp", generation = runtimeGeneration): void {
    if (runtimeStarted && !getLiveContext(runtimeContext, generation)) {
      return;
    }
    if (delivery !== "followUp") {
      replyTracker.queueTurnContext({ from: entry.from, message: entry.message, receivedAt: Date.now() });
    }
    const senderDisplay = entry.from.name || entry.from.id.slice(0, 8);
    const replyInstruction = entry.replyCommand ? `\n\nTo reply, use the intercom tool: ${entry.replyCommand}` : "";
    pi.sendMessage(
      {
        customType: "intercom_message",
        content: `**📨 From ${senderDisplay}** (${entry.from.cwd})${replyInstruction}\n\n${entry.bodyText}`,
        display: true,
        details: entry,
      },
      delivery === "trigger"
        ? { triggerTurn: true }
        : { deliverAs: "followUp" }
    );
  }
  function scheduleInboundFlush(delayMs = INBOUND_FLUSH_DELAY_MS): void {
    if (!getLiveContext()) {
      return;
    }
    const scheduledGeneration = runtimeGeneration;
    clearInboundFlushTimer();
    inboundFlushTimer = setTimeout(() => {
      inboundFlushTimer = null;
      flushIdleMessages(scheduledGeneration);
    }, delayMs);
  }
  function flushIdleMessages(generation = runtimeGeneration): void {
    if (pendingIdleMessages.length === 0) {
      return;
    }
    const ctx = getLiveContext(runtimeContext, generation);
    if (!ctx) {
      return;
    }

    let isIdle: boolean;
    try {
      isIdle = ctx.isIdle();
    } catch {
      // Stale contexts are cleaned up by shutdown/reload; do not deliver queued messages through them.
      return;
    }
    if (!isIdle) {
      scheduleInboundFlush(INBOUND_IDLE_RETRY_MS);
      return;
    }

    const entries = pendingIdleMessages.splice(0, pendingIdleMessages.length);
    entries.forEach((entry, index) => {
      sendIncomingMessage(entry, index === 0 ? "trigger" : "followUp");
    });
  }
  function queueIdleMessage(entry: InboundMessageEntry): void {
    pendingIdleMessages.push(entry);
    scheduleInboundFlush();
  }
  function handleIncomingMessage(ctx: ExtensionContext, from: SessionInfo, message: Message): void {
    const messageGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, messageGeneration);
    if (!liveContext) {
      return;
    }
    if (replyWaiter) {
      const senderTarget = from.name || from.id;
      const fromMatches = senderTarget.toLowerCase() === replyWaiter.from.toLowerCase()
        || from.id === replyWaiter.from;
      const replyMatches = message.replyTo === replyWaiter.replyTo;
      if (fromMatches && replyMatches) {
        replyWaiter.resolve(message);
        return;
      }
    }
    const attachmentText = message.content.attachments?.length
      ? formatAttachments(message.content.attachments)
      : "";
    const bodyText = `${message.content.text}${attachmentText}`;
    const replyCommand = config.replyHint && message.expectsReply
      ? `intercom({ action: "reply", message: "..." })`
      : undefined;
    replyTracker.recordIncomingMessage(from, message);
    const entry = { from, message, replyCommand, bodyText };
    void (async () => {
      const activeContext = getLiveContext(liveContext, messageGeneration);
      if (!activeContext) {
        return;
      }
      if (!activeContext.isIdle()) {
        if (!activeContext.hasUI) {
          const activeClient = client;
          if (!message.replyTo && activeClient?.isConnected()) {
            try {
              const result = await activeClient.send(from.id, {
                text: "This agent is running in non-interactive mode and cannot respond to intercom messages while it is working. It will continue its current task and exit when done.",
                replyTo: message.id,
              });
              if (result.delivered && getLiveContext(liveContext, messageGeneration)) {
                replyTracker.markReplied(message.id);
              }
            } catch {
              // Best-effort reply; keep the busy non-interactive session running either way.
            }
          }
          return;
        }
        queueIdleMessage(entry);
        return;
      }
      if (getLiveContext(liveContext, messageGeneration)) {
        sendIncomingMessage(entry, "trigger", messageGeneration);
      }
    })();
  }
  function attachClientHandlers(nextClient: IntercomClient): void {
    nextClient.on("message", (from, message) => {
      const liveContext = getLiveContext();
      if (client !== nextClient || !liveContext) {
        return;
      }
      handleIncomingMessage(liveContext, from, message);
    });
    nextClient.on("disconnected", (error: Error) => {
      if (client !== nextClient) {
        return;
      }
      rejectReplyWaiter(new Error(`Disconnected while waiting for reply: ${error.message}`, { cause: error }));
      client = null;
      if (!shuttingDown && !disposed) {
        clearReconnectTimer();
        scheduleReconnect();
      }
    });
    nextClient.on("error", () => {
      // Keep broker/socket noise out of the TUI. Reconnect logic runs from the disconnect path.
    });
  }
  function scheduleReconnect(): void {
    if (disposed || shuttingDown || reconnectTimer || reconnectPromise || !getLiveContext()) {
      return;
    }
    const scheduledGeneration = runtimeGeneration;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (scheduledGeneration !== runtimeGeneration || !getLiveContext()) {
        return;
      }
      reconnectAttempt += 1;
      void ensureConnected("background").catch(() => {
        // ensureConnected("background") already queued the next retry.
      });
    }, getReconnectDelayMs());
  }
  async function ensureConnected(reason: "startup" | "background" | "tool" | "overlay"): Promise<IntercomClient> {
    if (!config.enabled) {
      throw new Error("Intercom disabled");
    }
    if (disposed || shuttingDown) {
      throw new Error("Intercom shutting down");
    }
    if (client && client.isConnected()) {
      return client;
    }
    const contextAtStart = getLiveContext();
    const generationAtStart = runtimeGeneration;
    if (!contextAtStart || !currentSessionId || sessionStartedAt === null) {
      throw new Error("Intercom runtime not initialized");
    }
    clearReconnectTimer();
    if (reconnectPromise && reconnectPromiseGeneration === generationAtStart) {
      return reconnectPromise;
    }
    const nextReconnectPromise = (async () => {
      const nextClient = new IntercomClient();
      client = nextClient;
      attachClientHandlers(nextClient);
      try {
        await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
        await nextClient.connect(buildRegistration());
        if (!getLiveContext(contextAtStart, generationAtStart)) {
          await nextClient.disconnect();
          throw new Error("Intercom runtime no longer active");
        }
        client = nextClient;
        reconnectAttempt = 0;
        return nextClient;
      } catch (error) {
        if (client === nextClient) {
          client = null;
        }
        if (reason === "background" && getLiveContext(contextAtStart, generationAtStart)) {
          scheduleReconnect();
        }
        throw toError(error);
      } finally {
        if (reconnectPromise === nextReconnectPromise) {
          reconnectPromise = null;
          reconnectPromiseGeneration = null;
        }
      }
    })();
    reconnectPromise = nextReconnectPromise;
    reconnectPromiseGeneration = generationAtStart;
    return nextReconnectPromise;
  }
  async function resolveSessionTarget(activeClient: IntercomClient, nameOrId: string): Promise<string | null> {
    const sessions = await activeClient.listSessions();
    const byId = sessions.find(s => s.id === nameOrId);
    if (byId) {
      return byId.id;
    }
    const lowerName = nameOrId.toLowerCase();
    const byName = sessions.filter(s => s.name?.toLowerCase() === lowerName);
    if (byName.length > 1) {
      throw new Error(`Multiple sessions named "${nameOrId}" are connected. Use the session ID instead.`);
    }
    return byName[0]?.id ?? null;
  }
  function deliverLocalSubagentRelayMessage(sender: "subagent-control" | "subagent-result", status: string, messageText: string): void {
    const now = Date.now();
    sendIncomingMessage({
      from: {
        id: sender,
        name: sender,
        cwd: runtimeContext?.cwd ?? process.cwd(),
        model: sender,
        pid: process.pid,
        startedAt: now,
        lastActivity: now,
        status,
      },
      message: {
        id: randomUUID(),
        timestamp: now,
        content: { text: messageText },
      },
      bodyText: messageText,
    }, "trigger");
  }
  function recordSubagentDeliveryError(entryType: string, to: string, message: string, error: unknown): void {
    pi.appendEntry(entryType, {
      to,
      message,
      error: getErrorMessage(error),
      timestamp: Date.now(),
    });
  }
  function emitResultDelivery(requestId: string | undefined, delivered: boolean, error?: unknown): void {
    if (!requestId) return;
    pi.events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, {
      requestId,
      delivered,
      ...(error ? { error: getErrorMessage(error) } : {}),
    });
  }
  function relaySubagentIntercomPayload(payload: unknown, options: {
    sender: "subagent-control" | "subagent-result";
    status: string;
    errorEntryType: string;
    acknowledge?: boolean;
  }): void {
    const parsed = parseSubagentIntercomPayload(payload);
    if (!parsed) return;

    const relayGeneration = runtimeGeneration;
    void (async () => {
      const relayStillLive = () => !runtimeStarted || Boolean(getLiveContext(runtimeContext, relayGeneration));
      if (!relayStillLive()) {
        return;
      }
      if (currentSessionTargetMatches(parsed.to)) {
        deliverLocalSubagentRelayMessage(options.sender, options.status, parsed.message);
        if (options.acknowledge) emitResultDelivery(parsed.requestId, true);
        return;
      }

      let activeClient: IntercomClient;
      let target: string;
      try {
        activeClient = await ensureConnected("background");
        target = await resolveSessionTarget(activeClient, parsed.to) ?? parsed.to;
      } catch (error) {
        if (!relayStillLive()) return;
        recordSubagentDeliveryError(options.errorEntryType, parsed.to, parsed.message, error);
        if (options.acknowledge) emitResultDelivery(parsed.requestId, false, error);
        return;
      }

      if (!relayStillLive()) {
        return;
      }
      if (currentSessionTargetMatches(parsed.to, target, activeClient)) {
        deliverLocalSubagentRelayMessage(options.sender, options.status, parsed.message);
        if (options.acknowledge) emitResultDelivery(parsed.requestId, true);
        return;
      }

      try {
        const result = await activeClient.send(target, { text: parsed.message });
        if (!relayStillLive()) return;
        if (!result.delivered) {
          const error = new Error(result.reason ?? "Session may not exist or has disconnected.");
          recordSubagentDeliveryError(options.errorEntryType, parsed.to, parsed.message, error);
          if (options.acknowledge) emitResultDelivery(parsed.requestId, false, error);
          return;
        }
        if (options.acknowledge) emitResultDelivery(parsed.requestId, true);
      } catch (error) {
        if (!relayStillLive()) return;
        recordSubagentDeliveryError(options.errorEntryType, parsed.to, parsed.message, error);
        if (options.acknowledge) emitResultDelivery(parsed.requestId, false, error);
      }
    })();
  }
  pi.events.on(SUBAGENT_CONTROL_INTERCOM_EVENT, (payload) => {
    relaySubagentIntercomPayload(payload, {
      sender: "subagent-control",
      status: "needs_attention",
      errorEntryType: "intercom_control_error",
    });
  });
  pi.events.on(SUBAGENT_RESULT_INTERCOM_EVENT, (payload) => {
    relaySubagentIntercomPayload(payload, {
      sender: "subagent-result",
      status: "result",
      errorEntryType: "intercom_result_error",
      acknowledge: true,
    });
  });
  pi.on("session_start", (_event, ctx) => {
    if (!config.enabled) {
      return;
    }
    shuttingDown = false;
    disposed = false;
    runtimeStarted = true;
    runtimeGeneration += 1;
    reconnectAttempt = 0;
    clearReconnectTimer();
    clearStartupConnectTimer();
    runtimeContext = ctx;
    currentSessionId = ctx.sessionManager.getSessionId();
    currentModel = ctx.model?.id ?? "unknown";
    sessionStartedAt = Date.now();
    agentRunning = false;
    activeTools.clear();
    const startupGeneration = runtimeGeneration;
    startupConnectTimer = setTimeout(() => {
      startupConnectTimer = null;
      if (!getLiveContext(ctx, startupGeneration)) {
        return;
      }
      void ensureConnected("startup").catch(() => {
        if (!getLiveContext(ctx, startupGeneration)) {
          return;
        }
        client = null;
        scheduleReconnect();
      });
    }, 0);
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    disposed = true;
    runtimeGeneration += 1;
    clearStartupConnectTimer();
    clearReconnectTimer();
    rejectReplyWaiter(new Error("Session shutting down"));
    replyTracker.reset();
    pendingIdleMessages.length = 0;
    clearInboundFlushTimer();
    agentRunning = false;
    activeTools.clear();
    if (client) {
      await client.disconnect();
      client = null;
    }
    runtimeContext = null;
    currentSessionId = null;
    sessionStartedAt = null;
  });
  pi.on("turn_end", () => {
    if (!getLiveContext()) {
      return;
    }
    replyTracker.endTurn();
    scheduleInboundFlush(0);
  });
  pi.on("agent_start", () => {
    if (!getLiveContext()) {
      return;
    }
    agentRunning = true;
    activeTools.clear();
    syncPresenceStatus();
  });
  pi.on("tool_execution_start", (event) => {
    if (!getLiveContext()) {
      return;
    }
    activeTools.set(event.toolCallId, event.toolName);
    syncPresenceStatus();
  });
  pi.on("tool_execution_end", (event) => {
    if (!getLiveContext()) {
      return;
    }
    activeTools.delete(event.toolCallId);
    syncPresenceStatus();
  });
  pi.on("agent_end", () => {
    if (!getLiveContext()) {
      return;
    }
    agentRunning = false;
    activeTools.clear();
    syncPresenceStatus();
    scheduleInboundFlush(0);
  });
  pi.on("turn_start", (_event, ctx) => {
    if (!getLiveContext(ctx)) {
      return;
    }
    currentSessionId = ctx.sessionManager.getSessionId();
    syncPresenceIdentity(ctx.sessionManager.getSessionId());
    replyTracker.beginTurn();
  });
  pi.on("model_select", (event, ctx) => {
    if (!getLiveContext(ctx)) {
      return;
    }
    currentModel = event.model.id;
    if (client) {
      client.updatePresence({
        ...buildPresenceIdentity(pi, ctx.sessionManager.getSessionId()),
        model: event.model.id,
        status: currentStatus(),
      });
    }
  });

  pi.registerMessageRenderer("intercom_message", (message, _options, theme) => {
    const details = message.details as { from: SessionInfo; message: Message; replyCommand?: string; bodyText?: string } | undefined;
    if (!details) return undefined;
    return new InlineMessageComponent(details.from, details.message, theme, details.replyCommand, details.bodyText);
  });

  const childOrchestratorMetadata = readChildOrchestratorMetadata();
  if (childOrchestratorMetadata) {
    pi.registerTool({
      name: "contact_supervisor",
      label: "Contact Supervisor",
      description: "Subagent-only tool for contacting the supervisor agent that delegated this task. Use need_decision when blocked, uncertain, needing approval, or facing a product/API/scope decision before continuing; this waits for the supervisor's reply. Use interview_request when multiple structured questions need supervisor answers; this also waits for a reply. Use progress_update only for meaningful progress or unexpected discoveries that change the plan; this does not wait for a reply. Do not use for routine completion handoffs.",
      promptSnippet: "Subagent-only: contact the supervisor for decisions, structured interviews, or meaningful plan-changing updates. Do not use for routine completion handoffs.",
      promptGuidelines: [
        "Use contact_supervisor with reason='need_decision' when a subagent is blocked, uncertain, needs approval, or faces a product/API/scope decision before continuing.",
        "Use contact_supervisor with reason='interview_request' when the child needs multiple structured answers from the supervisor in one blocking exchange.",
        "Use contact_supervisor with reason='progress_update' only for meaningful progress or unexpected discoveries that change the plan.",
        "Do not use contact_supervisor for routine completion handoffs; return the final subagent result normally.",
      ],
      parameters: Type.Object({
        reason: Type.String({
          enum: ["need_decision", "progress_update", "interview_request"],
          description: "Contact reason: 'need_decision' waits for a reply; 'interview_request' sends structured questions and waits for a reply; 'progress_update' sends a non-blocking update",
        }),
        message: Type.Optional(Type.String({
          description: "Decision request, optional interview note, or meaningful progress update for the supervisor",
        })),
        interview: Type.Optional(Type.Object({
          title: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
          questions: Type.Array(Type.Object({
            id: Type.String(),
            type: Type.String({ description: "Question type: single, multi, text, image, or info" }),
            question: Type.String(),
            options: Type.Optional(Type.Array(Type.Unknown())),
            context: Type.Optional(Type.String()),
          })),
        }, { description: "Structured interview request for reason='interview_request'" })),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const reason = params.reason as ContactSupervisorReason;
        if (reason !== "need_decision" && reason !== "progress_update" && reason !== "interview_request") {
          return {
            content: [{ type: "text", text: "Invalid reason. Use 'need_decision', 'interview_request', or 'progress_update'." }],
            isError: true,
            details: { error: true },
          };
        }
        if ((reason === "need_decision" || reason === "progress_update") && typeof params.message !== "string") {
          return {
            content: [{ type: "text", text: `Missing 'message' parameter for reason '${reason}'.` }],
            isError: true,
            details: { error: true },
          };
        }
        const interviewValidation = reason === "interview_request"
          ? validateSupervisorInterviewRequest(params.interview)
          : undefined;
        if (interviewValidation?.ok === false) {
          return {
            content: [{ type: "text", text: `Invalid interview request: ${interviewValidation.error}` }],
            isError: true,
            details: { error: true },
          };
        }
        const supervisorInterview = interviewValidation?.ok === true ? interviewValidation.interview : undefined;

        let connectedClient: IntercomClient;
        try {
          connectedClient = await ensureConnected("tool");
        } catch (error) {
          return {
            content: [{ type: "text", text: `Intercom not connected: ${getErrorMessage(error)}` }],
            isError: true,
            details: { error: true },
          };
        }

        syncPresenceIdentity(ctx.sessionManager.getSessionId());

        if (signal?.aborted) {
          return {
            content: [{ type: "text", text: "Cancelled" }],
            isError: true,
            details: { error: true },
          };
        }

        const metadata = childOrchestratorMetadata;
        let sendTo: string;
        try {
          sendTo = await resolveSessionTarget(connectedClient, metadata.orchestratorTarget) ?? metadata.orchestratorTarget;
        } catch (error) {
          return {
            content: [{ type: "text", text: `Failed to resolve supervisor target: ${getErrorMessage(error)}` }],
            isError: true,
            details: { error: true },
          };
        }
        if (signal?.aborted) {
          return {
            content: [{ type: "text", text: "Cancelled" }],
            isError: true,
            details: { error: true },
          };
        }
        if (sendTo === connectedClient.sessionId) {
          return {
            content: [{ type: "text", text: "Cannot message the current session" }],
            isError: true,
            details: { error: true },
          };
        }

        if (reason === "progress_update") {
          const message = params.message as string;
          try {
            const result = await connectedClient.send(sendTo, {
              text: formatChildOrchestratorMessage("update", metadata, message),
            });
            if (!result.delivered) {
              const errorText = result.reason ?? "Session may not exist or has disconnected.";
              return {
                content: [{ type: "text", text: `Message to "${metadata.orchestratorTarget}" was not delivered: ${errorText}` }],
                isError: true,
                details: { messageId: result.id, delivered: false, reason: result.reason },
              };
            }
            pi.appendEntry("intercom_sent", {
              to: metadata.orchestratorTarget,
              message: { text: message, reason },
              messageId: result.id,
              timestamp: Date.now(),
              subagent: { runId: metadata.runId, agent: metadata.agent, index: metadata.index },
            });
            return {
              content: [{ type: "text", text: `Progress update sent to supervisor ${metadata.orchestratorTarget}` }],
              isError: false,
              details: { messageId: result.id, delivered: true },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to send progress update: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        if (replyWaiter) {
          return {
            content: [{ type: "text", text: "Already waiting for a reply" }],
            isError: true,
            details: { error: true },
          };
        }

        let replyPromise: Promise<Message> | null = null;
        try {
          const questionId = randomUUID();
          replyPromise = waitForReply(sendTo, questionId, signal);
          replyPromise.catch(() => undefined);
          if (signal?.aborted) {
            rejectReplyWaiter(new Error("Cancelled"));
            try {
              await replyPromise;
            } catch {
              // The waiter was intentionally rejected above; the tool result reports cancellation.
            }
            return {
              content: [{ type: "text", text: "Cancelled" }],
              isError: true,
              details: { error: true },
            };
          }
          const requestText = reason === "interview_request"
            ? formatChildOrchestratorMessage("interview", metadata, formatSupervisorInterviewRequest(supervisorInterview!, typeof params.message === "string" ? params.message : undefined))
            : formatChildOrchestratorMessage("ask", metadata, params.message as string);
          const sendResult = await connectedClient.send(sendTo, {
            messageId: questionId,
            text: requestText,
            expectsReply: true,
          });
          if (!sendResult.delivered) {
            const errorText = sendResult.reason ?? "Session may not exist or has disconnected.";
            rejectReplyWaiter(new Error(`Message to "${metadata.orchestratorTarget}" was not delivered: ${errorText}`));
            if (replyPromise) {
              try {
                await replyPromise;
              } catch {
                // The waiter was already rejected above. Keep the delivery failure as the only error here.
              }
            }
            return {
              content: [{ type: "text", text: `Message to "${metadata.orchestratorTarget}" was not delivered: ${errorText}` }],
              isError: true,
              details: { error: true },
            };
          }
          pi.appendEntry("intercom_sent", {
            to: metadata.orchestratorTarget,
            message: {
              text: reason === "interview_request" ? requestText : params.message,
              reason,
              ...(reason === "interview_request" ? { interview: supervisorInterview } : {}),
            },
            messageId: sendResult.id,
            timestamp: Date.now(),
            subagent: { runId: metadata.runId, agent: metadata.agent, index: metadata.index },
          });
          const replyMessage = await replyPromise;
          const replyText = replyMessage.content.text;
          const replyAttachments = replyMessage.content.attachments?.length
            ? formatAttachments(replyMessage.content.attachments)
            : "";
          const structuredReply = reason === "interview_request" ? parseStructuredSupervisorReply(replyText, supervisorInterview!) : undefined;
          pi.appendEntry("intercom_received", {
            from: metadata.orchestratorTarget,
            message: { text: replyText, attachments: replyMessage.content.attachments },
            messageId: replyMessage.id,
            timestamp: replyMessage.timestamp,
            subagent: { runId: metadata.runId, agent: metadata.agent, index: metadata.index },
          });
          return {
            content: [{ type: "text", text: `**Reply from supervisor:**\n${replyText}${replyAttachments}` }],
            isError: false,
            ...(structuredReply
              ? { details: structuredReply.value !== undefined ? { structuredReply: structuredReply.value } : { structuredReplyParseError: structuredReply.error } }
              : {}),
          };
        } catch (error) {
          rejectReplyWaiter(toError(error));
          if (replyPromise) {
            try {
              await replyPromise;
            } catch {
              // The waiter is cleanup-only on this path. The real failure is the one from the outer catch.
            }
          }
          return {
            content: [{ type: "text", text: `Failed: ${getErrorMessage(error)}` }],
            isError: true,
            details: { error: true },
          };
        }
      },
      renderCall(args, theme) {
        const reason = typeof args.reason === "string" ? args.reason : "contact";
        const messagePreview = previewText(args.message, 96);
        const interview = args.interview && typeof args.interview === "object" ? args.interview as { title?: unknown } : undefined;
        let text = theme.fg("toolTitle", theme.bold("contact_supervisor "));
        text += theme.fg(reason === "need_decision" ? "warning" : reason === "progress_update" ? "muted" : "accent", reason);
        if (typeof interview?.title === "string" && interview.title.trim()) {
          text += " " + theme.fg("accent", interview.title.trim());
        }
        if (messagePreview) {
          text += "\n  " + theme.fg("dim", messagePreview);
        }
        return new Text(text, 0, 0);
      },
      renderResult: renderContactSupervisorResult,
    });
  }

  pi.registerTool({
    name: "intercom",
    label: "Intercom",
    description: `Send a message to another pi session running on this machine.
Use this to communicate findings, request help, or coordinate work with other sessions.

Usage:
  intercom({ action: "list" })                    → List active sessions
  intercom({ action: "send", to: "session-name", message: "..." })  → Send message
  intercom({ action: "ask", to: "session-name", message: "..." })   → Ask and wait for reply
  intercom({ action: "reply", message: "..." })                      → Reply to the active/single pending ask
  intercom({ action: "pending" })                                      → List unresolved inbound asks
  intercom({ action: "status" })                  → Show connection status`,
    promptSnippet:
      "Use to coordinate with other local pi sessions: list peers, send updates, ask for help, or check intercom connectivity.",

    parameters: Type.Object({
      action: Type.String({
        description: "Action: 'list', 'send', 'ask', 'reply', 'pending', or 'status'",
      }),
      to: Type.Optional(Type.String({
        description: "Target session name or ID (for 'send', 'ask', or disambiguating 'reply')",
      })),
      message: Type.Optional(Type.String({
        description: "Message to send (for 'send', 'ask', or 'reply' action)",
      })),
      attachments: Type.Optional(Type.Array(Type.Object({
        type: Type.Union([Type.Literal("file"), Type.Literal("snippet"), Type.Literal("context")]),
        name: Type.String(),
        content: Type.String(),
        language: Type.Optional(Type.String()),
      }))),
      replyTo: Type.Optional(Type.String({
        description: "Message ID to reply to (for threading or responding to an 'ask')",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let connectedClient: IntercomClient;
      try {
        connectedClient = await ensureConnected("tool");
      } catch (error) {
        return {
          content: [{ type: "text", text: `Intercom not connected: ${getErrorMessage(error)}` }],
          isError: true,
          details: { error: true },
        };
      }

      syncPresenceIdentity(ctx.sessionManager.getSessionId());

      const { action, to, message, attachments, replyTo } = params;

      switch (action) {
        case "list": {
          try {
            const mySessionId = connectedClient.sessionId;
            const sessions = await connectedClient.listSessions();
            const currentSession = sessions.find(s => s.id === mySessionId);
            const otherSessions = sessions.filter(s => s.id !== mySessionId);

            if (!currentSession) {
              return {
                content: [{ type: "text", text: "Current session is missing from intercom session list." }],
                isError: true,
                details: { error: true },
              };
            }

            const currentSection = `**Current session:**\n${formatSessionListRow(currentSession, currentSession.cwd, true)}`;
            const otherSection = otherSessions.length === 0
              ? "**Other sessions:**\nNo other sessions connected."
              : `**Other sessions:**\n${otherSessions.map(s => formatSessionListRow(s, currentSession.cwd, false)).join("\n")}`;

            return {
              content: [{ type: "text", text: `${currentSection}\n\n${otherSection}` }],
              isError: false,
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to list sessions: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        case "send": {
          if (!to || !message) {
            return {
              content: [{ type: "text", text: "Missing 'to' or 'message' parameter" }],
              isError: true,
              details: { error: true },
            };
          }
          try {
            const sendTo = await resolveSessionTarget(connectedClient, to) ?? to;
            if (sendTo === connectedClient.sessionId) {
              return {
                content: [{ type: "text", text: "Cannot message the current session" }],
                isError: true,
                details: { error: true },
              };
            }
            if (!replyTo && config.confirmSend && ctx.hasUI) {
              const attachmentText = attachments?.length ? formatAttachments(attachments) : "";
              const confirmed = await ctx.ui.confirm(
                "Send Message",
                `Send to "${to}":\n\n${message}${attachmentText}`,
              );
              if (!confirmed) {
                return {
                  content: [{ type: "text", text: "Message cancelled by user" }],
                  isError: false,
                };
              }
            }
            const result = await connectedClient.send(sendTo, {
              text: message,
              attachments,
              replyTo,
            });
            if (!result.delivered) {
              const errorText = result.reason ?? "Session may not exist or has disconnected.";
              return {
                content: [{ type: "text", text: `Message to "${to}" was not delivered: ${errorText}` }],
                isError: true,
                details: { messageId: result.id, delivered: false, reason: result.reason },
              };
            }
            pi.appendEntry("intercom_sent", {
              to,
              message: { text: message, attachments, replyTo },
              messageId: result.id,
              timestamp: Date.now(),
            });
            if (replyTo) {
              replyTracker.markReplied(replyTo);
            }
            return {
              content: [{ type: "text", text: `Message sent to ${to}` }],
              isError: false,
              details: { messageId: result.id, delivered: true },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to send: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        case "ask": {
          if (!to || !message) {
            return {
              content: [{ type: "text", text: "Missing 'to' or 'message' parameter" }],
              isError: true,
              details: { error: true },
            };
          }

          if (replyWaiter) {
            return {
              content: [{ type: "text", text: "Already waiting for a reply" }],
              isError: true,
              details: { error: true },
            };
          }

          if (_signal?.aborted) {
            return {
              content: [{ type: "text", text: "Cancelled" }],
              isError: true,
              details: { error: true },
            };
          }
          let replyPromise: Promise<Message> | null = null;

          try {
            const sendTo = await resolveSessionTarget(connectedClient, to) ?? to;
            if (_signal?.aborted) {
              return {
                content: [{ type: "text", text: "Cancelled" }],
                isError: true,
                details: { error: true },
              };
            }
            if (sendTo === connectedClient.sessionId) {
              return {
                content: [{ type: "text", text: "Cannot message the current session" }],
                isError: true,
                details: { error: true },
              };
            }
            const questionId = randomUUID();
            replyPromise = waitForReply(sendTo, questionId, _signal);
            const sendResult = await connectedClient.send(sendTo, {
              messageId: questionId,
              text: message,
              attachments,
              replyTo,
              expectsReply: true,
            });

            if (!sendResult.delivered) {
              const errorText = sendResult.reason ?? "Session may not exist or has disconnected.";
              rejectReplyWaiter(new Error(`Message to "${to}" was not delivered: ${errorText}`));
              if (replyPromise) {
                try {
                  await replyPromise;
                } catch {
                  // The waiter was already rejected above. Keep the delivery failure as the only error here.
                }
              }
              return {
                content: [{ type: "text", text: `Message to "${to}" was not delivered: ${errorText}` }],
                isError: true,
                details: { error: true },
              };
            }
            pi.appendEntry("intercom_sent", {
              to,
              message: { text: message, attachments, replyTo },
              messageId: sendResult.id,
              timestamp: Date.now(),
            });
            const replyMessage = await replyPromise;
            const replyText = replyMessage.content.text;
            const replyAttachments = replyMessage.content.attachments?.length
              ? formatAttachments(replyMessage.content.attachments)
              : "";
            pi.appendEntry("intercom_received", {
              from: to,
              message: { text: replyText, attachments: replyMessage.content.attachments },
              messageId: replyMessage.id,
              timestamp: replyMessage.timestamp,
            });
            return {
              content: [{ type: "text", text: `**Reply from ${to}:**\n${replyText}${replyAttachments}` }],
              isError: false,
            };
          } catch (error) {
            rejectReplyWaiter(toError(error));
            if (replyPromise) {
              try {
                await replyPromise;
              } catch {
                // The waiter is cleanup-only on this path. The real failure is the one from the outer catch.
              }
            }
            return {
              content: [{ type: "text", text: `Failed: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        case "reply": {
          if (!message) {
            return {
              content: [{ type: "text", text: "Missing 'message' parameter" }],
              isError: true,
              details: { error: true },
            };
          }

          try {
            const target = replyTracker.resolveReplyTarget({ to });
            if (target.from.id === connectedClient.sessionId) {
              return {
                content: [{ type: "text", text: "Cannot message the current session" }],
                isError: true,
                details: { error: true },
              };
            }
            const result = await connectedClient.send(target.from.id, {
              text: message,
              replyTo: target.message.id,
            });
            if (!result.delivered) {
              const errorText = result.reason ?? "Session may not exist or has disconnected.";
              return {
                content: [{ type: "text", text: `Reply to "${target.from.name || target.from.id}" was not delivered: ${errorText}` }],
                isError: true,
                details: { messageId: result.id, delivered: false, reason: result.reason },
              };
            }
            replyTracker.markReplied(target.message.id);
            pi.appendEntry("intercom_sent", {
              to: target.from.name || target.from.id,
              message: { text: message, replyTo: target.message.id },
              messageId: result.id,
              timestamp: Date.now(),
            });
            return {
              content: [{ type: "text", text: `Reply sent to ${target.from.name || target.from.id}` }],
              isError: false,
              details: { messageId: result.id, delivered: true, replyTo: target.message.id },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to reply: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        case "pending": {
          const pendingAsks = replyTracker.listPending();
          if (pendingAsks.length === 0) {
            return {
              content: [{ type: "text", text: "No unresolved inbound asks." }],
              isError: false,
            };
          }

          const now = Date.now();
          const lines = pendingAsks.map(({ from, message, receivedAt }) => {
            const preview = message.content.text.replace(/\s+/g, " ").slice(0, 80);
            const elapsedSeconds = Math.max(0, Math.floor((now - receivedAt) / 1000));
            return `- ${from.name || from.id} · ${message.id} · ${elapsedSeconds}s ago · ${preview}`;
          });
          return {
            content: [{ type: "text", text: `**Pending asks:**\n${lines.join("\n")}` }],
            isError: false,
          };
        }

        case "status": {
          try {
            const mySessionId = connectedClient.sessionId;
            const sessions = await connectedClient.listSessions();
            return {
              content: [{
                type: "text",
                text: `**Intercom Status:**\nConnected: Yes\nSession ID: ${mySessionId}\nActive sessions: ${sessions.length}`,
              }],
              isError: false,
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to get status: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown action: ${action}` }],
            isError: true,
            details: { error: true },
          };
      }
    },
    renderCall(args, theme) {
      const action = typeof args.action === "string" ? args.action : "intercom";
      const target = typeof args.to === "string" && args.to.trim() ? args.to.trim() : undefined;
      const messagePreview = previewText(args.message, 96);
      const attachmentCount = Array.isArray(args.attachments) ? args.attachments.length : 0;
      let text = theme.fg("toolTitle", theme.bold("intercom "));
      text += theme.fg(action === "ask" ? "warning" : action === "reply" ? "success" : "accent", action);
      if (target) {
        text += " " + theme.fg("muted", "→") + " " + theme.fg("accent", target);
      }
      if (attachmentCount > 0) {
        text += " " + theme.fg("dim", `(${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"})`);
      }
      if (messagePreview) {
        text += "\n  " + theme.fg("dim", messagePreview);
      }
      return new Text(text, 0, 0);
    },
    renderResult: renderIntercomResult,
  });

  async function openIntercomOverlay(ctx: ExtensionContext): Promise<void> {
    const overlayGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, overlayGeneration);
    if (!liveContext?.hasUI) return;

    let overlayClient: IntercomClient;
    try {
      overlayClient = await ensureConnected("overlay");
    } catch (error) {
      notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "error", overlayGeneration);
      return;
    }
    if (!getLiveContext(ctx, overlayGeneration)) return;

    syncPresenceIdentity(ctx.sessionManager.getSessionId());

    let currentSession: SessionInfo;
    let sessions: SessionInfo[];
    let duplicates: Set<string>;
    try {
      const mySessionId = overlayClient.sessionId;
      const allSessions = await overlayClient.listSessions();
      if (!getLiveContext(ctx, overlayGeneration)) return;
      const foundCurrentSession = allSessions.find(s => s.id === mySessionId);
      if (!foundCurrentSession) {
        notifyIfLive(ctx, "Current session is missing from intercom session list", "error", overlayGeneration);
        return;
      }
      currentSession = foundCurrentSession;
      duplicates = duplicateSessionNames(allSessions);
      sessions = allSessions.filter(s => s.id !== mySessionId);
    } catch (error) {
      notifyIfLive(ctx, `Failed to list sessions: ${getErrorMessage(error)}`, "error", overlayGeneration);
      return;
    }

    const selectedSession = await ctx.ui.custom<SessionInfo | undefined>(
      (_tui, theme, keybindings, done) => new SessionListOverlay(theme, keybindings, currentSession, sessions, done),
      { overlay: true }
    ).catch(() => undefined);

    if (!selectedSession || !getLiveContext(ctx, overlayGeneration)) return;

    try {
      overlayClient = await ensureConnected("overlay");
    } catch (error) {
      notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "error", overlayGeneration);
      return;
    }
    if (!getLiveContext(ctx, overlayGeneration)) return;

    const targetLabel = formatSessionLabel(selectedSession, duplicates);

    const result = await ctx.ui.custom<ComposeResult>(
      (tui, theme, keybindings, done) => new ComposeOverlay(tui, theme, keybindings, selectedSession, targetLabel, overlayClient, done),
      { overlay: true }
    ).catch(() => undefined);

    if (result?.sent && result.messageId && result.text && getLiveContext(ctx, overlayGeneration)) {
      pi.appendEntry("intercom_sent", {
        to: selectedSession.name || selectedSession.id,
        message: { text: result.text },
        messageId: result.messageId,
        timestamp: Date.now(),
      });
      notifyIfLive(ctx, `Message sent to ${targetLabel}`, "info", overlayGeneration);
    }
  }

  pi.registerCommand("intercom", {
    description: "Open session intercom overlay",
    handler: async (_args, ctx) => openIntercomOverlay(ctx),
  });

  pi.registerShortcut("alt+m", {
    description: "Open session intercom",
    handler: async (ctx) => openIntercomOverlay(ctx),
  });
}
