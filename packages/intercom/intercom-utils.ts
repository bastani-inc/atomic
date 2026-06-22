import type { ExtensionAPI } from "@bastani/atomic";
import { APP_NAME, getEnvValue } from "@bastani/atomic";
import type { Attachment, Message, SessionInfo } from "./types.ts";


export const SUBAGENT_CONTROL_INTERCOM_EVENT = "subagent:control-intercom";
export const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
export const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT = "subagent:result-intercom-delivery";
export const INBOUND_FLUSH_DELAY_MS = 200;
export const INBOUND_IDLE_RETRY_MS = 500;
export const DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX = "subagent-chat";
const ENV_PREFIX = APP_NAME.toUpperCase();
const SUBAGENT_ORCHESTRATOR_TARGET_ENV = `${ENV_PREFIX}_SUBAGENT_ORCHESTRATOR_TARGET`;
const SUBAGENT_RUN_ID_ENV = `${ENV_PREFIX}_SUBAGENT_RUN_ID`;
const SUBAGENT_CHILD_AGENT_ENV = `${ENV_PREFIX}_SUBAGENT_CHILD_AGENT`;
const SUBAGENT_CHILD_INDEX_ENV = `${ENV_PREFIX}_SUBAGENT_CHILD_INDEX`;
const SUBAGENT_INTERCOM_SESSION_NAME_ENV = `${ENV_PREFIX}_SUBAGENT_INTERCOM_SESSION_NAME`;

export interface ChildOrchestratorMetadata {
  orchestratorTarget: string;
  runId: string;
  agent: string;
  index: string;
  sessionName?: string;
}

export interface InboundMessageEntry {
  from: SessionInfo;
  message: Message;
  replyCommand?: string;
  bodyText: string;
}

export type ContactSupervisorReason = "need_decision" | "progress_update" | "interview_request";

export interface SupervisorInterviewQuestion extends Record<string, unknown> {
  id: string;
  type: "single" | "multi" | "text" | "image" | "info";
  question: string;
  options?: unknown[];
}

export interface SupervisorInterviewRequest extends Record<string, unknown> {
  title?: string;
  description?: string;
  questions: SupervisorInterviewQuestion[];
}

export interface SupervisorInterviewReply {
  responses: Array<{ id: string; value: unknown }>;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function formatAttachments(attachments: Attachment[]): string {
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
export function readChildOrchestratorMetadata(): ChildOrchestratorMetadata | null {
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
export function formatChildOrchestratorMessage(kind: "ask" | "update" | "interview", metadata: ChildOrchestratorMetadata, message: string): string {
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

export function validateSupervisorInterviewRequest(input: unknown): { ok: true; interview: SupervisorInterviewRequest } | { ok: false; error: string } {
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

export function formatSupervisorInterviewRequest(interview: SupervisorInterviewRequest, message?: string): string {
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

export function validateSupervisorInterviewReply(value: unknown, interview: SupervisorInterviewRequest): SupervisorInterviewReply {
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

export function parseStructuredSupervisorReply(text: string, interview: SupervisorInterviewRequest): { value?: SupervisorInterviewReply; error?: string } | undefined {
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
export function duplicateSessionNames(sessions: SessionInfo[]): Set<string> {
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
export function parseSubagentIntercomPayload(payload: unknown): { to: string; message: string; requestId?: string } | null {
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
export function resolveIntercomPresenceName(sessionName: string | undefined, sessionId: string): string {
  const trimmedName = sessionName?.trim();
  if (trimmedName) {
    return trimmedName;
  }
  const normalizedSessionId = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
  return `${DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX}-${normalizedSessionId.slice(0, 8)}`;
}
export function buildPresenceIdentity(pi: ExtensionAPI, sessionId: string): { name: string } {
  return {
    name: resolveIntercomPresenceName(pi.getSessionName(), sessionId),
  };
}
export function formatSessionLabel(session: SessionInfo, duplicates: Set<string>): string {
  if (!session.name) {
    return session.id;
  }
  return duplicates.has(session.name.toLowerCase())
    ? `${session.name} (${shortSessionId(session.id)})`
    : session.name;
}
export function formatSessionListRow(session: SessionInfo, currentCwd: string, isSelf: boolean): string {
  const name = session.name || "Unnamed session";
  const tags = [isSelf ? "self" : session.cwd === currentCwd ? "same cwd" : undefined, session.status]
    .filter((tag): tag is string => Boolean(tag));
  const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
  return `• ${name} (${shortSessionId(session.id)}) — ${session.cwd} (${session.model})${suffix}`;
}
export function previewText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}
