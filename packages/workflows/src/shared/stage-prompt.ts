/**
 * stage-prompt — headless answering for brokered in-stage prompts.
 *
 * A workflow stage's agent can call the `ask_user_question` tool, and the
 * executor raises a deterministic readiness gate after such a turn. Both
 * render their UI through {@link StageUiBroker.requestCustomUi} and resolve the
 * tool's `ctx.ui.custom<QuestionnaireResult>()` promise with a
 * `QuestionnaireResult`-shaped value. That value is normally produced by the
 * interactive TUI component.
 *
 * For programmatic / non-interactive control (e.g. an orchestrating agent
 * answering via `workflow send`), we need to synthesize the same value WITHOUT
 * the TUI. This module:
 *   1. Parses the `ask_user_question` tool args into a serializable
 *      {@link StageInputRequest} descriptor (surfaced on the stage snapshot so
 *      `workflow send` / status can show the questions + options).
 *   2. Produces a {@link StagePromptAdapter} whose `buildResult` maps a simple
 *      answer (free text, an option label, an option index, or a pre-built raw
 *      result) into the `QuestionnaireResult` the tool expects.
 *
 * cross-ref:
 *   - packages/coding-agent/src/core/tools/ask-user-question/tool/types.ts
 *       QuestionnaireResult / QuestionAnswer (the result shape mirrored here)
 *   - src/shared/stage-ui-broker.ts  provideStagePrompt / answerStagePrompt
 *   - src/runs/foreground/executor.ts  ask_user_question watcher + readiness gate
 */

import type {
  StageInputKind,
  StageInputQuestion,
  StageInputRequest,
} from "./store-types.js";

/**
 * A simple, transport-friendly answer to a brokered stage prompt. Exactly one
 * of the fields is typically populated:
 *   - `raw`: a pre-built `QuestionnaireResult`-shaped value, forwarded verbatim.
 *   - `optionLabels`: explicit option label(s) (one for single-select, many for
 *     multi-select).
 *   - `text`: free text — matched against option labels / 1-based indices, and
 *     otherwise treated as a typed ("custom") answer.
 */
export interface StageInputAnswer {
  readonly text?: string;
  readonly optionLabels?: readonly string[];
  readonly raw?: unknown;
}

/** Result shape mirrored from the coding-agent ask_user_question tool. */
interface BuiltAnswer {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "chat" | "multi";
  answer: string | null;
  selected?: string[];
}
interface BuiltResult {
  answers: BuiltAnswer[];
  cancelled: boolean;
}

/**
 * Couples the serializable {@link StageInputRequest} descriptor with a
 * `buildResult` that turns a {@link StageInputAnswer} into the value used to
 * resolve the brokered `ctx.ui.custom` promise.
 */
export interface StagePromptAdapter {
  readonly prompt: StageInputRequest;
  buildResult(answer: StageInputAnswer): unknown;
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  return out.length > 0 ? out : undefined;
}

function readFirstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** True when the answer carries a value the adapter can resolve. */
export function hasStageInputAnswerContent(answer: StageInputAnswer): boolean {
  return (
    answer.text !== undefined || answer.optionLabels !== undefined || answer.raw !== undefined
  );
}

/**
 * Coerce a loosely-typed answer payload — as delivered by `workflow send`
 * (`text` / `response` / `message`) — into a normalized {@link StageInputAnswer}
 * the {@link StagePromptAdapter} can resolve against a question's options.
 *
 * Recognized inputs:
 *   - a plain string (option label, 1-based index, or free text);
 *   - a JSON-encoded string of any structured shape below;
 *   - a fully-formed `QuestionnaireResult` (every answer carries a numeric
 *     `questionIndex`), forwarded raw;
 *   - the orchestrator-friendly `{ answers: [{ answer | label | selected }] }`
 *     or `{ questions: [{ answer | label | selected }] }`;
 *   - a flat `{ answer | response | label | selected | optionLabels }`;
 *   - a string array (multi-select labels).
 *
 * Without this, a structured `response` was forwarded verbatim as the brokered
 * result, violating the `QuestionnaireResult` contract and leaving the readiness
 * gate (and any brokered prompt) unable to resolve to a matching option.
 */
export function coerceStageInputAnswer(value: unknown): StageInputAnswer {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed !== null && typeof parsed === "object") {
          const coerced = coerceStageInputAnswer(parsed);
          if (hasStageInputAnswerContent(coerced)) return coerced;
        }
      } catch {
        // Not JSON — fall through and treat the string as a literal answer.
      }
    }
    return { text: value };
  }
  if (Array.isArray(value)) {
    const labels = readStringArray(value);
    return labels !== undefined ? { optionLabels: labels } : {};
  }
  if (value === null || typeof value !== "object") return {};

  const record = value as Record<string, unknown>;

  // Forward verbatim ONLY a fully-formed QuestionnaireResult — every answer
  // entry must carry a numeric `questionIndex`. A loosely-shaped `answers[]`
  // (e.g. `{ answers: [{ question, answer }] }`) is NOT genuine: forwarding it
  // raw makes the tool envelope match no question index and reply
  // "User declined to answer questions", stranding the prompt.
  const answersArray = Array.isArray(record["answers"])
    ? (record["answers"] as readonly unknown[])
    : undefined;
  if (
    answersArray !== undefined &&
    answersArray.length > 0 &&
    answersArray.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as Record<string, unknown>)["questionIndex"] === "number",
    )
  ) {
    return { raw: value };
  }

  // Otherwise locate the answer-bearing record — the first `answers[]` or
  // `questions[]` entry when present, else the object itself — and extract a
  // value the adapter can resolve against the question's options (so it assigns
  // the correct questionIndex), rather than forwarding an unusable result.
  const source = answerBearingRecord(record);
  const labels = readStringArray(source["optionLabels"]) ?? readStringArray(source["selected"]);
  if (labels !== undefined) return { optionLabels: labels };

  const text = readFirstString(
    source["answer"],
    source["response"],
    source["label"],
    source["text"],
  );
  if (text !== undefined) return { text };

  // Nothing resolvable — decline rather than forward an unusable result.
  return {};
}

function firstObjectOf(value: unknown): Record<string, unknown> | undefined {
  const first = Array.isArray(value) ? value[0] : undefined;
  return first !== null && typeof first === "object"
    ? (first as Record<string, unknown>)
    : undefined;
}

function answerBearingRecord(record: Record<string, unknown>): Record<string, unknown> {
  return firstObjectOf(record["answers"]) ?? firstObjectOf(record["questions"]) ?? record;
}

function parseOption(value: unknown): StageInputQuestion["options"][number] | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const label = asString(record["label"]);
  if (label === undefined) return undefined;
  const description = asString(record["description"]);
  return description !== undefined ? { label, description } : { label };
}

function parseQuestion(value: unknown): StageInputQuestion | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const question = asString(record["question"]);
  if (question === undefined) return undefined;
  const rawOptions = Array.isArray(record["options"]) ? record["options"] : [];
  const options = rawOptions
    .map(parseOption)
    .filter((option): option is StageInputQuestion["options"][number] => option !== undefined);
  const header = asString(record["header"]);
  const multiSelect = record["multiSelect"] === true;
  return {
    question,
    ...(header !== undefined ? { header } : {}),
    ...(multiSelect ? { multiSelect: true } : {}),
    options,
  };
}

/**
 * Parse `ask_user_question` tool args (`{ questions: [...] }`) into the
 * serializable question descriptors. Returns `undefined` when no well-formed
 * question is present.
 */
export function parseAskUserQuestionArgs(
  args: unknown,
): readonly StageInputQuestion[] | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const rawQuestions = (args as Record<string, unknown>)["questions"];
  if (!Array.isArray(rawQuestions)) return undefined;
  const questions = rawQuestions
    .map(parseQuestion)
    .filter((question): question is StageInputQuestion => question !== undefined);
  return questions.length > 0 ? questions : undefined;
}

/**
 * Sentinel label for the chat escape hatch. Matches the `ROW_INTENT_META.chat.label`
 * in the coding-agent package. Duplicated here as a literal to avoid a cross-package
 * import; the reserved-label guard in validate-questionnaire already prevents an
 * authored option from using this label.
 */
const CHAT_ABOUT_THIS_LABEL = "Chat about this";
const CHAT_ABOUT_THIS_NORMALIZED = normalizeLabel(CHAT_ABOUT_THIS_LABEL);

function isChatSentinel(value: string): boolean {
  return normalizeLabel(value) === CHAT_ABOUT_THIS_NORMALIZED;
}

function answerChat(question: StageInputQuestion): BuiltAnswer {
  return {
    questionIndex: 0,
    question: question.question,
    kind: "chat",
    answer: CHAT_ABOUT_THIS_LABEL,
  };
}

/**
 * Resolve a desired answer string against a single-select question's options.
 * Checks the chat sentinel first (case/whitespace insensitive), then matches a
 * case-insensitive option label, then a 1-based option index, then falls back to
 * a typed ("custom") answer.
 */
function answerSingle(question: StageInputQuestion, desired: string): BuiltAnswer {
  const normalized = normalizeLabel(desired);
  // Chat sentinel takes priority over authored options — the label is reserved so
  // no option can legitimately match it.
  if (isChatSentinel(desired)) {
    return answerChat(question);
  }
  const byLabel = question.options.find((option) => normalizeLabel(option.label) === normalized);
  if (byLabel) {
    return { questionIndex: 0, question: question.question, kind: "option", answer: byLabel.label };
  }
  const asIndex = Number.parseInt(desired.trim(), 10);
  if (
    Number.isInteger(asIndex) &&
    asIndex >= 1 &&
    asIndex <= question.options.length &&
    String(asIndex) === desired.trim()
  ) {
    const option = question.options[asIndex - 1]!;
    return { questionIndex: 0, question: question.question, kind: "option", answer: option.label };
  }
  return { questionIndex: 0, question: question.question, kind: "custom", answer: desired };
}

function answerMulti(question: StageInputQuestion, candidates: readonly string[]): BuiltAnswer {
  const selected: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeLabel(candidate);
    const byLabel = question.options.find((option) => normalizeLabel(option.label) === normalized);
    if (byLabel) {
      if (!selected.includes(byLabel.label)) selected.push(byLabel.label);
      continue;
    }
    const asIndex = Number.parseInt(candidate.trim(), 10);
    if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= question.options.length) {
      const option = question.options[asIndex - 1]!;
      if (!selected.includes(option.label)) selected.push(option.label);
    }
  }
  return { questionIndex: 0, question: question.question, kind: "multi", answer: null, selected };
}

function buildResult(
  questions: readonly StageInputQuestion[],
  answer: StageInputAnswer,
): unknown {
  if (answer.raw !== undefined) return answer.raw;
  const question = questions[0];
  if (question === undefined) return { answers: [], cancelled: true } satisfies BuiltResult;

  const multi = question.multiSelect === true;
  if (multi) {
    const candidates =
      answer.optionLabels !== undefined
        ? answer.optionLabels
        : (answer.text ?? "").split(",").map((part) => part.trim()).filter((part) => part.length > 0);
    if (candidates.some(isChatSentinel)) {
      return { answers: [answerChat(question)], cancelled: false } satisfies BuiltResult;
    }
    return { answers: [answerMulti(question, candidates)], cancelled: false } satisfies BuiltResult;
  }

  const desired = answer.optionLabels?.[0] ?? answer.text;
  if (desired === undefined || desired.length === 0) {
    return { answers: [], cancelled: true } satisfies BuiltResult;
  }
  return { answers: [answerSingle(question, desired)], cancelled: false } satisfies BuiltResult;
}

/**
 * Build a {@link StagePromptAdapter} from `ask_user_question` tool args. Returns
 * `undefined` when the args contain no parseable question (the prompt then
 * stays TUI-only).
 */
export function buildStagePromptAdapter(
  id: string,
  kind: StageInputKind,
  args: unknown,
  createdAt: number,
): StagePromptAdapter | undefined {
  const questions = parseAskUserQuestionArgs(args);
  if (questions === undefined) return undefined;
  const prompt: StageInputRequest = { id, kind, questions, createdAt };
  return {
    prompt,
    buildResult: (answer) => buildResult(questions, answer),
  };
}
