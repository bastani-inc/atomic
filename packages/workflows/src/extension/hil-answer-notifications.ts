import type {
  ExtensionAPI,
  PiMessageRenderComponent,
  PiMessageRenderer,
} from "./index.js";
import type { Store } from "../shared/store.js";
import type {
  PendingPrompt,
  PromptKind,
  RunSnapshot,
  StageInputKind,
  StageInputRequest,
  StageSnapshot,
  StoreSnapshot,
} from "../shared/store-types.js";
import type { StageUiBroker } from "../shared/stage-ui-broker.js";
import { deriveGraphThemeFromPiTheme, type GraphTheme } from "../tui/graph-theme.js";
import { renderWorkflowNoticeCard } from "../tui/workflow-notice-card.js";

export const HIL_ANSWER_NOTICE_CUSTOM_TYPE = "workflows:hil-answer-notice";
const HIL_ANSWER_SNIPPET_LIMIT = 1000;

export type WorkflowHilAnswerPromptKind = PromptKind | StageInputKind;

export interface WorkflowHilAnswerNoticeDetails {
  readonly kind: "hil_answered";
  readonly scope: "stage";
  readonly runId: string;
  readonly workflowName: string;
  readonly stageId: string;
  readonly stageName?: string;
  readonly promptId?: string;
  readonly promptKind?: WorkflowHilAnswerPromptKind;
  readonly promptMessage?: string;
  readonly answeredAt: number;
  readonly answerAvailable: true;
  readonly answerIncluded: true;
  readonly answerSummary: string;
}

export interface WorkflowHilAnswerNotificationState {
  readonly deliveredAnswerPrompts: Set<string>;
}

export interface WorkflowHilAnswerNotificationOptions {
  readonly store: Store;
  readonly stageUiBroker?: Pick<StageUiBroker, "onStagePromptResolved">;
  readonly sendMessage?: ExtensionAPI["sendMessage"];
  readonly registerMessageRenderer?: ExtensionAPI["registerMessageRenderer"];
  readonly rendererHost?: object;
  readonly state?: WorkflowHilAnswerNotificationState;
}

type RawRenderer = PiMessageRenderer;

const rendererRegisteredHosts = new WeakSet<object>();

export function createWorkflowHilAnswerNotificationState(): WorkflowHilAnswerNotificationState {
  return {
    deliveredAnswerPrompts: new Set<string>(),
  };
}

export function resetWorkflowHilAnswerNotificationState(
  state: WorkflowHilAnswerNotificationState,
): void {
  state.deliveredAnswerPrompts.clear();
}

export function installWorkflowHilAnswerNotifications(
  options: WorkflowHilAnswerNotificationOptions,
): () => void {
  registerHilAnswerNoticeRenderer(options);

  const send = options.sendMessage;
  if (typeof send !== "function") return () => undefined;

  const state = options.state ?? createWorkflowHilAnswerNotificationState();

  const emitOnce = (details: WorkflowHilAnswerNoticeDetails): void => {
    const key = answerNoticeKey(details.runId, details.stageId, details.promptId, details.promptKind);
    if (state.deliveredAnswerPrompts.has(key)) return;

    state.deliveredAnswerPrompts.add(key);
    sendHilAnswerNotice(send, details);
  };

  const inspectWorkflowPromptAnswers = (snapshot: StoreSnapshot): void => {
    for (const currentRun of snapshot.runs) {
      for (const currentStage of currentRun.stages) {
        const prompt = workflowPromptAnswerCandidate(currentStage);
        if (prompt === undefined) continue;
        const answerRecord = options.store.getStagePromptAnswer(currentRun.id, currentStage.id);
        if (answerRecord === undefined) continue;
        if (answerRecord.promptId !== prompt.id) continue;
        if (answerRecord.answerSource === "workflow_tool") continue;
        emitOnce(makeSimplePromptAnswerNotice(currentRun, currentStage, prompt, answerRecord.value, answerRecord.answeredAt));
      }
    }
  };

  const unsubscribeStore = options.store.subscribe(inspectWorkflowPromptAnswers);
  const unsubscribeBroker = options.stageUiBroker?.onStagePromptResolved((event) => {
    if (event.answerSource === "workflow_tool") return;
    const answeredStage = findStageSnapshot(options.store.snapshot(), event.runId, event.stageId);
    if (answeredStage === undefined) return;

    emitOnce(makeBrokerPromptAnswerNotice(answeredStage.run, answeredStage.stage, event.prompt, event.answer, event.answeredAt));
  });

  return () => {
    unsubscribeStore();
    unsubscribeBroker?.();
  };
}

export function registerHilAnswerNoticeRenderer(
  options: Pick<WorkflowHilAnswerNotificationOptions, "registerMessageRenderer" | "rendererHost">,
): void {
  const register = options.registerMessageRenderer;
  if (typeof register !== "function") return;

  const host = options.rendererHost ?? register;
  if (rendererRegisteredHosts.has(host)) return;

  const renderer: RawRenderer = (raw, _options, piTheme) => {
    const details = readHilAnswerNoticeDetails(raw);
    if (details === undefined) return undefined;
    return makeNoticeComponent(details, themeFromRenderer(piTheme));
  };

  register(HIL_ANSWER_NOTICE_CUSTOM_TYPE, renderer);
  rendererRegisteredHosts.add(host);
}

export function formatWorkflowHilAnswerNoticeText(details: WorkflowHilAnswerNoticeDetails): string {
  const workflowName = escapeQuotedText(details.workflowName);
  const stage = details.stageName ?? details.stageId;
  const prompt = details.promptId ? `, prompt ${details.promptId}` : "";
  const question = details.promptMessage ? ` Question: ${details.promptMessage}` : "";
  const subject = `Workflow "${workflowName}" received the user's response for its pending human-in-the-loop prompt`;
  const location = `(run ${details.runId}, stage ${stage}${prompt})`;
  const instruction =
    "Do not ask the same question again. No main-chat action is needed; do not answer any other workflow human-in-the-loop prompt unless the user explicitly provides that answer.";
  return `✓ ${subject} ${location}.${question} User responded with: ${details.answerSummary}. ${instruction}`;
}

export function formatWorkflowHilAnswerInterruptAbortText(details: WorkflowHilAnswerNoticeDetails): string {
  const workflowName = escapeQuotedText(details.workflowName);
  const stage = details.stageName ?? details.stageId;
  const prompt = details.promptId ? `, prompt ${details.promptId}` : "";
  return `The main-chat question was dismissed because the user responded in the workflow chat for workflow "${workflowName}" (run ${details.runId}, stage ${stage}${prompt}). User responded with: ${details.answerSummary}. Do not ask the same question again.`;
}

function sendHilAnswerNotice(
  send: NonNullable<ExtensionAPI["sendMessage"]>,
  details: WorkflowHilAnswerNoticeDetails,
): void {
  const content = formatWorkflowHilAnswerNoticeText(details);
  try {
    void Promise.resolve(
      send(
        {
          customType: HIL_ANSWER_NOTICE_CUSTOM_TYPE,
          content,
          display: true,
          details,
        },
        {
          triggerTurn: false,
          excludeFromContext: true,
        },
      ),
    ).catch((error: unknown) => warnHilAnswerSendFailure(error));
  } catch (error) {
    warnHilAnswerSendFailure(error);
  }
}

function workflowPromptAnswerCandidate(stage: StageSnapshot): PendingPrompt | undefined {
  const prompt = stage.promptFootprint;
  if (prompt === undefined) return undefined;
  if (stage.promptAnswerState !== "available") return undefined;
  return prompt;
}

function findStageSnapshot(
  snapshot: StoreSnapshot,
  runId: string,
  stageId: string,
): { run: RunSnapshot; stage: StageSnapshot } | undefined {
  const run = snapshot.runs.find((candidate) => candidate.id === runId);
  const stage = run?.stages.find((candidate) => candidate.id === stageId);
  if (run === undefined || stage === undefined) return undefined;
  return { run, stage };
}

function readHilAnswerNoticeDetails(raw: unknown): WorkflowHilAnswerNoticeDetails | undefined {
  if (typeof raw !== "object" || raw === null || !("details" in raw)) return undefined;
  const message = raw as { details?: WorkflowHilAnswerNoticeDetails };
  return message.details;
}

function makeSimplePromptAnswerNotice(
  run: RunSnapshot,
  stage: StageSnapshot,
  prompt: PendingPrompt,
  answer: unknown,
  answeredAt: number,
): WorkflowHilAnswerNoticeDetails {
  return {
    kind: "hil_answered",
    scope: "stage",
    runId: run.id,
    workflowName: run.name,
    stageId: stage.id,
    stageName: stage.name,
    promptId: prompt.id,
    promptKind: prompt.kind,
    promptMessage: truncateAnswerSnippet(prompt.message),
    answeredAt,
    answerAvailable: true,
    answerIncluded: true,
    answerSummary: formatAnswerSummary(answer),
  };
}

function makeBrokerPromptAnswerNotice(
  run: RunSnapshot,
  stage: StageSnapshot,
  prompt: StageInputRequest,
  answer: unknown,
  answeredAt: number,
): WorkflowHilAnswerNoticeDetails {
  return {
    kind: "hil_answered",
    scope: "stage",
    runId: run.id,
    workflowName: run.name,
    stageId: stage.id,
    stageName: stage.name,
    promptId: prompt.id,
    promptKind: prompt.kind,
    promptMessage: truncateAnswerSnippet(prompt.questions.map((question) => question.question).join(" | ")),
    answeredAt,
    answerAvailable: true,
    answerIncluded: true,
    answerSummary: formatAnswerSummary(answer),
  };
}

function formatAnswerSummary(answer: unknown): string {
  const questionnaire = formatQuestionnaireAnswer(answer);
  if (questionnaire !== undefined) return questionnaire;
  if (typeof answer === "string") return truncateAnswerSnippet(answer);
  if (typeof answer === "number" || typeof answer === "boolean" || typeof answer === "bigint") {
    return String(answer);
  }
  if (answer === null) return "null";
  if (answer === undefined) return "(answer unavailable)";
  try {
    return truncateAnswerSnippet(JSON.stringify(answer));
  } catch {
    return truncateAnswerSnippet(String(answer));
  }
}

function formatQuestionnaireAnswer(answer: unknown): string | undefined {
  if (typeof answer !== "object" || answer === null || !("answers" in answer)) return undefined;
  const answers = (answer as { answers?: unknown }).answers;
  if (!Array.isArray(answers)) return undefined;
  const parts = answers.map(formatQuestionnaireAnswerPart).filter((part) => part.length > 0);
  if (parts.length > 0) return truncateAnswerSnippet(parts.join("; "));
  const cancelled = (answer as { cancelled?: unknown }).cancelled === true;
  return cancelled ? "(cancelled)" : "(no answer)";
}

function formatQuestionnaireAnswerPart(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const record = value as { question?: unknown; answer?: unknown; selected?: unknown; kind?: unknown };
  const question = typeof record.question === "string" && record.question.trim().length > 0
    ? record.question.trim()
    : "Question";
  const selected = Array.isArray(record.selected)
    ? record.selected.filter((item): item is string => typeof item === "string" && item.length > 0).join(", ")
    : "";
  const answer = typeof record.answer === "string" && record.answer.length > 0
    ? record.answer
    : selected.length > 0
      ? selected
      : typeof record.kind === "string"
        ? `(${record.kind})`
        : "(no answer)";
  return `${question} → ${answer}`;
}

function truncateAnswerSnippet(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= HIL_ANSWER_SNIPPET_LIMIT) return normalized;
  return `${normalized.slice(0, HIL_ANSWER_SNIPPET_LIMIT - 1)}…`;
}

function answerNoticeKey(
  runId: string,
  stageId: string,
  promptId: string | undefined,
  promptKind: WorkflowHilAnswerPromptKind | undefined,
): string {
  return `hil_answered:${runId}:stage:${stageId}:${promptKind ?? "unknown"}:${promptId ?? "unknown"}`;
}

function warnHilAnswerSendFailure(error: unknown): void {
  if (process.env.ATOMIC_WORKFLOW_DEBUG !== "1") return;
  const message = error instanceof Error ? error.message : String(error);
  console.warn("[workflows] workflow HiL answer notice send failed", message);
}

function escapeQuotedText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function makeNoticeComponent(
  details: WorkflowHilAnswerNoticeDetails,
  theme: GraphTheme | undefined,
): PiMessageRenderComponent {
  const text = formatWorkflowHilAnswerNoticeText(details);
  return {
    render(width: number): string[] {
      return renderWorkflowNoticeCard({
        title: "HIL ANSWERED",
        glyph: "✓",
        headline: `Workflow "${details.workflowName}" received the user's response`,
        tone: "success",
        fields: [
          { label: "workflow", value: details.workflowName },
          { label: "run", value: details.runId },
          { label: "stage", value: details.stageName ?? details.stageId },
          { label: "prompt", value: details.promptMessage, tone: "muted" },
          { label: "answer", value: details.answerSummary },
        ],
        footer: "No main-chat action is needed; do not answer other workflow prompts unless the user explicitly provides that answer.",
        fallbackText: text,
        width,
        ...(theme ? { theme } : {}),
      });
    },
    invalidate() {
      /* stored HiL-answer notices are immutable */
    },
  };
}

function themeFromRenderer(piTheme: unknown): GraphTheme | undefined {
  return piTheme === undefined ? undefined : deriveGraphThemeFromPiTheme(piTheme);
}
