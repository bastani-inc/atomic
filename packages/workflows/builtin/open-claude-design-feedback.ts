/**
 * open-claude-design feedback threading.
 *
 * The `user-feedback-*` stages capture Playwright annotation feedback (user
 * notes + annotated snapshot) from the user. This module is the durable carrier
 * for that feedback: it parses the feedback-stage output, persists it as a
 * workflow artifact, and renders the user annotations that the next `generate-*`
 * stage must honor. cross-ref: issue #1464.
 *
 * The stage declares `previewFeedbackSchema` as its structured output, so the
 * feedback round finalizes as a schema-validated value rather than as prose a
 * later resume-continuation turn can replace. Every round is persisted as
 * `<artifactDir>/feedback/iteration-N.json`, and that artifact — not the
 * stage's final message — is the source of truth for the refinement loop.
 * cross-ref: issue #2401.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, dirname, join, resolve, sep } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { WorkflowSerializableValue } from "../src/shared/types.js";

/**
 * The structured final answer the `user-feedback-*` stages must return. Used as
 * the stage `schema`, which both finalizes the stage result and shapes the
 * durable per-round artifact.
 */
export const previewFeedbackSchema = Type.Object(
  {
    decision: Type.Union([Type.Literal("approve"), Type.Literal("revise")], {
      description:
        "`revise` whenever the user asked for anything at all; `approve` only when the user wants the preview exported unchanged.",
    }),
    user_notes: Type.Array(Type.String(), {
      description: "Every note the user typed or dictated, verbatim, one entry per note. Empty when the user typed nothing.",
    }),
    live_changes: Type.Array(Type.String(), {
      description: "Every variant or edit the user accepted during the live review, one entry per accepted change.",
    }),
    annotated_snapshot: Type.Optional(
      Type.String({ description: "Path to the annotated screenshot captured during the review, when one exists." }),
    ),
  },
  { additionalProperties: false },
);

/** The validated structured payload a `user-feedback-*` stage returns. */
export type PreviewFeedbackPayload = Static<typeof previewFeedbackSchema>;

/**
 * Round outcome. `indeterminate` means the round produced neither a usable
 * structured payload nor parseable feedback: it is never approval.
 */
export type PreviewFeedbackDecision = "approve" | "revise" | "indeterminate";

/** Whether the round was read from the structured payload or parsed from prose. */
export type PreviewFeedbackSource = "structured" | "text";

/** A single captured user-feedback round. */
export type PreviewFeedback = {
  /** 1..N for generate/user-feedback loop iterations. */
  readonly iteration: number;
  /** Originating stage name, e.g. `user-feedback-1`. */
  readonly stageName: string;
  /** Full markdown result text emitted by the user-feedback stage. */
  readonly text: string;
  /** Explicit round outcome; drives the refinement loop. */
  readonly decision: PreviewFeedbackDecision;
  /** Where the fields below came from. */
  readonly source: PreviewFeedbackSource;
  /** Extracted user annotation notes when the user actually annotated. */
  readonly userNotes?: string;
  /** Extracted annotated-snapshot artifact path when one was captured. */
  readonly annotatedSnapshot?: string;
  /** Extracted summary of the variants/edits the user accepted in the live QA session. */
  readonly liveChanges?: string;
  /** ISO timestamp when the feedback was captured. */
  readonly capturedAt: string;
};

type PreviewResultLike = {
  readonly text?: string;
  readonly structured?: WorkflowSerializableValue;
};

/**
 * Field labels the user-feedback stages are instructed to emit, stored in
 * canonical (alphanumeric-only, lowercase) form. Used to bound multi-line value
 * extraction (a value ends when the next known field starts).
 */
const FIELD_LABELS = new Set<string>([
  "displaymethod",
  "previewpath",
  "previewfileurl",
  "annotatedsnapshot",
  "usernotes",
  "livechanges",
  "nextactionhint",
  "manualopeninstructions",
  "specpath",
  "decision",
  "reviewdecision",
]);

const PLACEHOLDER_TOKENS = new Set<string>([
  "none",
  "na",
  "null",
  "undefined",
  "notavailable",
  "unavailable",
  "notcaptured",
  "nonotes",
  "nousernotes",
  "nofeedback",
  "noannotations",
  "nonecaptured",
  "tbd",
  "pending",
]);

function isPlaceholderValue(value: string): boolean {
  const compact = value
    .replace(/\//g, "")
    .replace(/[\s().,*_`~–—\-:]/g, "")
    .toLowerCase();
  if (compact.length === 0) return true;
  return PLACEHOLDER_TOKENS.has(compact);
}

/** Canonicalize a label to lowercase alphanumerics so `user_notes`, `User Notes`,
 * and `**user_notes**` all compare equal. */
function canonicalLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Normalize a candidate label line into a canonical key (or undefined).
 *
 * Labels arrive decorated: fenced (```` ```user_notes``` ````), bolded
 * (`**live_changes:**`), bulleted and backticked (`` - `user_notes`: ``), and
 * annotated (`` - `user_notes` (verbatim): ``). Canonicalizing to lowercase
 * alphanumerics handles the decoration; a trailing parenthetical is an
 * annotation on the label rather than part of it, so it is dropped when the
 * remainder is a label we know. cross-ref: issue #2401 item 4.
 */
function labelOf(line: string): string | undefined {
  const stripped = line
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+\.\s+/, "");
  const colonIdx = stripped.indexOf(":");
  const candidate = colonIdx >= 0 ? stripped.slice(0, colonIdx) : stripped;
  const key = canonicalLabel(candidate);
  if (key.length === 0) return undefined;
  if (FIELD_LABELS.has(key)) return key;
  const withoutAnnotation = canonicalLabel(candidate.replace(/\s*\([^)]*\)\s*$/, ""));
  if (withoutAnnotation.length > 0 && FIELD_LABELS.has(withoutAnnotation)) return withoutAnnotation;
  return key;
}

/** Inline value following a `label:` on the same line. */
function inlineValueOf(line: string): string {
  const stripped = line
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+\.\s+/, "");
  const colonIdx = stripped.indexOf(":");
  if (colonIdx < 0) return "";
  return stripped.slice(colonIdx + 1).replace(/[`*]/g, "").trim();
}

function isHorizontalRule(line: string): boolean {
  return /^\s*([-*_])(\s*\1){2,}\s*$/.test(line);
}

/**
 * Extract the value of a labeled field (e.g. `user_notes`) from a user-feedback
 * markdown blob, tolerating heading / bullet / bold / backtick label styles and
 * multi-line values that run until the next known field label or a rule.
 */
export function extractField(text: string, field: string): string | undefined {
  if (text.trim().length === 0) return undefined;
  const target = canonicalLabel(field);
  const lines = text.split(/\r?\n/);
  let collecting = false;
  const collected: string[] = [];
  for (const line of lines) {
    if (collecting) {
      const label = labelOf(line);
      if (label !== undefined && label !== target && FIELD_LABELS.has(label)) break;
      if (isHorizontalRule(line)) break;
      collected.push(line);
      continue;
    }
    if (labelOf(line) === target) {
      const inline = inlineValueOf(line);
      if (inline.length > 0) collected.push(inline);
      collecting = true;
    }
  }
  const value = collected.join("\n").trim();
  if (value.length === 0 || isPlaceholderValue(value)) return undefined;
  return value;
}

export function extractUserNotes(text: string): string | undefined {
  return extractField(text, "user_notes");
}

export function extractAnnotatedSnapshot(text: string): string | undefined {
  return extractField(text, "annotated_snapshot");
}

export function extractLiveChanges(text: string): string | undefined {
  return extractField(text, "live_changes");
}

/** Non-empty, non-placeholder entries of a structured string array, joined into one block. */
function joinPayloadEntries(entries: readonly string[]): string | undefined {
  const kept = entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0 && !isPlaceholderValue(entry));
  if (kept.length === 0) return undefined;
  return kept.join("\n");
}

/** The structured stage payload when it validates against the declared schema. */
function readStructuredPayload(value: WorkflowSerializableValue | undefined): PreviewFeedbackPayload | undefined {
  if (value === undefined || value === null) return undefined;
  return Value.Check(previewFeedbackSchema, value) ? value : undefined;
}

/** Whether a labeled `decision` / `review_decision` value states approval. */
function textDecisionApproves(text: string): boolean {
  const raw = extractField(text, "decision") ?? extractField(text, "review_decision");
  if (raw === undefined) return false;
  const canonical = canonicalLabel(raw);
  return canonical === "approve" || canonical === "approved";
}

/**
 * Build a PreviewFeedback record from a (possibly missing) stage result.
 *
 * The structured payload wins: it is the schema-validated value the stage
 * finalized, so a later resume-continuation turn cannot replace it. Prose
 * parsing remains as the fallback for a stage that produced no structured
 * value, and that fallback never invents approval. cross-ref: issue #2401.
 */
export function toPreviewFeedback(input: {
  readonly iteration: number;
  readonly stageName: string;
  readonly result: PreviewResultLike | undefined;
}): PreviewFeedback {
  const text = (input.result?.text ?? "").trim();
  const base = {
    iteration: input.iteration,
    stageName: input.stageName,
    text,
    capturedAt: new Date().toISOString(),
  };

  const payload = readStructuredPayload(input.result?.structured);
  if (payload !== undefined) {
    const userNotes = joinPayloadEntries(payload.user_notes);
    const liveChanges = joinPayloadEntries(payload.live_changes);
    const snapshot = payload.annotated_snapshot?.trim();
    const annotatedSnapshot = snapshot !== undefined && snapshot.length > 0 ? snapshot : undefined;
    // `approve` alongside captured work is a contradiction: the user asked for
    // something, so exporting now would discard it. Revise instead.
    const captured = userNotes !== undefined || liveChanges !== undefined;
    return {
      ...base,
      decision: payload.decision === "approve" && captured ? "revise" : payload.decision,
      source: "structured",
      ...(userNotes !== undefined ? { userNotes } : {}),
      ...(annotatedSnapshot !== undefined ? { annotatedSnapshot } : {}),
      ...(liveChanges !== undefined ? { liveChanges } : {}),
    };
  }

  const userNotes = extractUserNotes(text);
  const annotatedSnapshot = extractAnnotatedSnapshot(text);
  const liveChanges = extractLiveChanges(text);
  const captured = userNotes !== undefined || liveChanges !== undefined;
  const decision: PreviewFeedbackDecision = captured
    ? "revise"
    : textDecisionApproves(text)
      ? "approve"
      : "indeterminate";
  return {
    ...base,
    decision,
    source: "text",
    ...(userNotes !== undefined ? { userNotes } : {}),
    ...(annotatedSnapshot !== undefined ? { annotatedSnapshot } : {}),
    ...(liveChanges !== undefined ? { liveChanges } : {}),
  };
}

export function hasMeaningfulUserNotes(feedback: PreviewFeedback): boolean {
  return typeof feedback.userNotes === "string" && feedback.userNotes.length > 0;
}

export function hasMeaningfulLiveChanges(feedback: PreviewFeedback): boolean {
  return typeof feedback.liveChanges === "string" && feedback.liveChanges.length > 0;
}

/** Whether a feedback round carries any meaningful user signal: typed notes or accepted live variants. */
export function hasMeaningfulFeedback(feedback: PreviewFeedback): boolean {
  return hasMeaningfulUserNotes(feedback) || hasMeaningfulLiveChanges(feedback);
}

function feedbackLabel(feedback: PreviewFeedback): string {
  return feedback.iteration === 0
    ? "the initial preview"
    : "the live design review";
}

/**
 * Render the captured user annotations (latest first) as a markdown section.
 * Returns "" when no iteration captured meaningful user notes.
 */
export function buildUserAnnotationsSection(history: readonly PreviewFeedback[]): string {
  const withFeedback = history.filter(
    (feedback) => hasMeaningfulUserNotes(feedback) || hasMeaningfulLiveChanges(feedback),
  );
  if (withFeedback.length === 0) return "";
  return [...withFeedback]
    .reverse()
    .map((feedback) => {
      const lines = [
        `### User annotations from ${feedbackLabel(feedback)}`,
        "",
      ];
      if (hasMeaningfulUserNotes(feedback)) {
        lines.push(feedback.userNotes ?? "");
      }
      if (hasMeaningfulLiveChanges(feedback)) {
        lines.push("", "Accepted live variants/edits:", feedback.liveChanges ?? "");
      }
      if (feedback.annotatedSnapshot !== undefined) {
        lines.push("", `Annotated snapshot: ${feedback.annotatedSnapshot}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * The user-annotations block injected into refinement prompts, plus whether any
 * real annotations exist. When none exist, downstream stages are told to fall
 * back to an impeccable critique rather than fabricating user feedback.
 */
export function userAnnotationsBlock(history: readonly PreviewFeedback[]): {
  readonly hasNotes: boolean;
  readonly text: string;
} {
  const section = buildUserAnnotationsSection(history);
  if (section.length === 0) {
    return {
      hasNotes: false,
      text: "No interactive user annotations were captured in the user-feedback stage. There is no user feedback to honor for this refinement.",
    };
  }
  return { hasNotes: true, text: section };
}

/**
 * Guardrail: every captured user annotation must be present verbatim in the
 * next generate prompt. If a `user-feedback-*` stage captured `user_notes` but
 * they did not thread through, fail loudly instead of silently generating
 * without user feedback. cross-ref: issue #1464 fix (6).
 */
export function assertUserAnnotationsThreaded(
  prompt: string,
  history: readonly PreviewFeedback[],
  stageName: string,
): void {
  for (const feedback of history) {
    if (hasMeaningfulUserNotes(feedback)) {
      const notes = (feedback.userNotes ?? "").trim();
      if (notes.length > 0 && !prompt.includes(notes)) {
        throw new Error(
          `open-claude-design ${stageName}: user annotations captured in ${feedback.stageName} were not threaded into the refinement context. Refusing to refine without user feedback (see issue #1464).`,
        );
      }
    }
    if (hasMeaningfulLiveChanges(feedback)) {
      const changes = (feedback.liveChanges ?? "").trim();
      if (changes.length > 0 && !prompt.includes(changes)) {
        throw new Error(
          `open-claude-design ${stageName}: accepted live variants captured in ${feedback.stageName} were not threaded into the refinement context. Refusing to refine without user feedback.`,
        );
      }
    }
  }
}

/** Whether `childPath` resolves to `parentDir` itself or somewhere beneath it. */
function isWithin(childPath: string, parentDir: string): boolean {
  const child = resolve(childPath);
  const parent = resolve(parentDir);
  return child === parent || child.startsWith(parent + sep);
}

function copyAnnotationArtifacts(
  feedbackDir: string,
  slug: string,
  feedback: PreviewFeedback,
  workflowCwd: string,
): void {
  if (feedback.annotatedSnapshot === undefined) return;
  const raw = feedback.annotatedSnapshot.trim();
  if (raw.length === 0) return;
  const source = isAbsolute(raw) ? raw : resolve(workflowCwd, raw);
  // Constrain the model-supplied path to within the project or the run's
  // artifact dir before copying, so an absolute path outside the project (e.g.
  // an arbitrary file the model emitted) is never copied in.
  const artifactDir = dirname(feedbackDir);
  if (!isWithin(source, workflowCwd) && !isWithin(source, artifactDir)) return;
  try {
    if (!existsSync(source) || !statSync(source).isFile()) return;
  } catch {
    return;
  }
  const extMatch = source.match(/\.[A-Za-z0-9]+$/);
  const ext = extMatch ? extMatch[0] : ".png";
  try {
    copyFileSync(source, join(feedbackDir, `${slug}-annotations${ext}`));
  } catch {
    /* best-effort */
  }
  for (const yamlExt of [".yaml", ".yml"]) {
    const sibling = source.replace(/\.[A-Za-z0-9]+$/, yamlExt);
    try {
      if (existsSync(sibling) && statSync(sibling).isFile()) {
        copyFileSync(sibling, join(feedbackDir, `${slug}-annotations${yamlExt}`));
        break;
      }
    } catch {
      /* best-effort */
    }
  }
}

/** Path of the durable per-round feedback artifact. */
export function feedbackArtifactPath(artifactDir: string, iteration: number): string {
  return join(artifactDir, "feedback", `iteration-${iteration}.json`);
}

/**
 * The persisted artifact shape: the declared schema at the top level (with
 * `decision` widened to carry `indeterminate`, which the schema's union cannot
 * express but an unrecoverable round must record) plus run metadata.
 */
type PreviewFeedbackArtifact = {
  readonly decision: PreviewFeedbackDecision;
  readonly user_notes: readonly string[];
  readonly live_changes: readonly string[];
  readonly annotated_snapshot?: string;
  readonly meta: {
    readonly iteration: number;
    readonly stage_name: string;
    readonly captured_at: string;
    readonly source: PreviewFeedbackSource;
    readonly text: string;
  };
};

/** Split a joined feedback block back into the schema's per-entry array. */
function toEntries(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function toArtifact(feedback: PreviewFeedback): PreviewFeedbackArtifact {
  return {
    decision: feedback.decision,
    user_notes: toEntries(feedback.userNotes),
    live_changes: toEntries(feedback.liveChanges),
    ...(feedback.annotatedSnapshot !== undefined ? { annotated_snapshot: feedback.annotatedSnapshot } : {}),
    meta: {
      iteration: feedback.iteration,
      stage_name: feedback.stageName,
      captured_at: feedback.capturedAt,
      source: feedback.source,
      text: feedback.text,
    },
  };
}

/**
 * Persist the round as durable workflow artifacts under `<artifactDir>/feedback/`.
 * Written on every round — approvals and indeterminate rounds included — because
 * the artifact, not the stage's prose, is what the refinement loop reads back.
 * Best-effort: never throws. cross-ref: issue #1464 fix (5), issue #2401.
 */
export function persistPreviewFeedback(input: {
  readonly artifactDir: string;
  readonly workflowCwd: string;
  readonly feedback: PreviewFeedback;
}): void {
  const { feedback } = input;
  try {
    const feedbackDir = join(input.artifactDir, "feedback");
    mkdirSync(feedbackDir, { recursive: true });
    const slug = `iteration-${feedback.iteration}`;
    writeFileSync(join(feedbackDir, `${slug}.md`), `${feedback.text}\n`);
    writeFileSync(
      feedbackArtifactPath(input.artifactDir, feedback.iteration),
      `${JSON.stringify(toArtifact(feedback), null, 2)}\n`,
    );
    copyAnnotationArtifacts(feedbackDir, slug, feedback, input.workflowCwd);
  } catch {
    /* best-effort durability; never block the workflow */
  }
}

function isRecord(value: WorkflowSerializableValue): value is { readonly [key: string]: WorkflowSerializableValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDecision(value: WorkflowSerializableValue | undefined): value is PreviewFeedbackDecision {
  return value === "approve" || value === "revise" || value === "indeterminate";
}

function readEntries(value: WorkflowSerializableValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const entries: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return undefined;
    if (entry.trim().length > 0) entries.push(entry);
  }
  return entries.length > 0 ? entries.join("\n") : undefined;
}

function readString(value: WorkflowSerializableValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Read the durable per-round artifact back into a `PreviewFeedback`. Returns
 * undefined when the file is missing or malformed; never throws, so the caller
 * decides what an unreadable deliverable means. cross-ref: issue #2401.
 */
export function loadPreviewFeedback(input: {
  readonly artifactDir: string;
  readonly iteration: number;
  readonly stageName: string;
}): PreviewFeedback | undefined {
  try {
    const path = feedbackArtifactPath(input.artifactDir, input.iteration);
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as WorkflowSerializableValue;
    if (!isRecord(parsed) || !isDecision(parsed.decision)) return undefined;
    if (parsed.user_notes !== undefined && !Array.isArray(parsed.user_notes)) return undefined;
    if (parsed.live_changes !== undefined && !Array.isArray(parsed.live_changes)) return undefined;
    const meta: { readonly [key: string]: WorkflowSerializableValue } = isRecord(parsed.meta) ? parsed.meta : {};
    const userNotes = readEntries(parsed.user_notes);
    const liveChanges = readEntries(parsed.live_changes);
    const annotatedSnapshot = readString(parsed.annotated_snapshot);
    const source = meta.source === "structured" ? "structured" : "text";
    return {
      iteration: typeof meta.iteration === "number" ? meta.iteration : input.iteration,
      stageName: readString(meta.stage_name) ?? input.stageName,
      text: typeof meta.text === "string" ? meta.text : "",
      decision: parsed.decision,
      source,
      capturedAt: readString(meta.captured_at) ?? "",
      ...(userNotes !== undefined ? { userNotes } : {}),
      ...(annotatedSnapshot !== undefined ? { annotatedSnapshot } : {}),
      ...(liveChanges !== undefined ? { liveChanges } : {}),
    };
  } catch {
    return undefined;
  }
}
