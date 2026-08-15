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

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** Per-entry captured values plus the joined block consumers read. */
type CapturedEntries = {
  readonly entries: readonly string[];
  readonly joined: string;
};

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
  /**
   * One entry per note, exactly as captured; `userNotes` is these joined. Kept
   * separately so a note that spans several lines survives the artifact
   * round-trip as one entry. cross-ref: issue #2401.
   */
  readonly userNoteEntries?: readonly string[];
  /** Extracted annotated-snapshot artifact path when one was captured. */
  readonly annotatedSnapshot?: string;
  /** Extracted summary of the variants/edits the user accepted in the live QA session. */
  readonly liveChanges?: string;
  /** One entry per accepted change; `liveChanges` is these joined. */
  readonly liveChangeEntries?: readonly string[];
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
 * annotated (`` - **`live_changes` (verbatim)**: ``). Canonicalizing to
 * lowercase alphanumerics handles the decoration. A parenthetical annotates the
 * label rather than naming it, and decoration can trail that parenthetical, so
 * parentheticals are dropped wherever they sit rather than only at the end of
 * the candidate — otherwise `` - **`live_changes` (verbatim)**: `` reads as an
 * unknown label and the preceding field swallows the whole block.
 * cross-ref: issue #2401 item 4.
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
  const withoutAnnotations = canonicalLabel(candidate.replace(/\([^)]*\)/g, " "));
  if (withoutAnnotations.length > 0 && FIELD_LABELS.has(withoutAnnotations)) return withoutAnnotations;
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
 * Every occurrence of a labeled field, in document order, each trimmed to the
 * value that followed its label. Empty and placeholder values are kept here:
 * the caller decides what they mean, and a repeat that changes a field's value
 * is a conflict no parser may resolve by picking one of them.
 *
 * A value runs until the next recognized label or a horizontal rule. ANY
 * recognized label ends it, including a repeat of the target:
 * `user_notes:\nFirst note.\n**user_notes:** Second note.` yields
 * `["First note.", "Second note."]` rather than one value that swallowed the
 * second label line. cross-ref: issue #2401 item 4 and amendment 3.
 */
function fieldOccurrences(text: string, field: string): readonly string[] {
  if (text.trim().length === 0) return [];
  const target = canonicalLabel(field);
  const occurrences: string[] = [];
  let collected: string[] | undefined;
  const flush = (): void => {
    if (collected === undefined) return;
    occurrences.push(collected.join("\n").trim());
    collected = undefined;
  };
  for (const line of text.split(/\r?\n/)) {
    const label = labelOf(line);
    const isLabel = label !== undefined && (FIELD_LABELS.has(label) || label === target);
    if (!isLabel && !isHorizontalRule(line)) {
      collected?.push(line);
      continue;
    }
    flush();
    if (label === target) {
      const inline = inlineValueOf(line);
      collected = inline.length > 0 ? [inline] : [];
    }
  }
  flush();
  return occurrences;
}

/** A captured value, or undefined when it is empty or stands in for "nothing". */
function meaningfulValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || isPlaceholderValue(trimmed)) return undefined;
  return trimmed;
}

/** Whether a field's repeated labels disagree about its value. */
function hasConflictingOccurrences(occurrences: readonly string[]): boolean {
  return occurrences.length > 1 && occurrences.some((value) => value !== occurrences[0]);
}

/**
 * Extract the value of a labeled field (e.g. `user_notes`) from a user-feedback
 * markdown blob, tolerating heading / bullet / bold / backtick label styles and
 * multi-line values that run until the next known field label or a rule.
 *
 * The FIRST occurrence is the field's value; a repeat is a separate occurrence
 * that never merges into it. Whether a repeat makes the whole round unusable is
 * decided in `toPreviewFeedback`, not here. cross-ref: issue #2401 item 4.
 */
export function extractField(text: string, field: string): string | undefined {
  return meaningfulValue(fieldOccurrences(text, field)[0]);
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

/**
 * Keep every non-empty entry of a captured field, one entry per note.
 *
 * Structured entries are NOT placeholder-filtered: the stage declared the
 * schema, so a non-empty entry it returned is captured work, and dropping it
 * here would let `{ decision: "approve", user_notes: ["pending"] }` slip past
 * the approval-contradiction rule. cross-ref: issue #2401 item A.3.
 */
function captureEntries(entries: readonly string[]): CapturedEntries | undefined {
  const kept = entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (kept.length === 0) return undefined;
  return { entries: kept, joined: kept.join("\n") };
}

/** A parsed prose block is one entry: prose gives no reliable per-note split. */
function captureBlock(value: string | undefined): CapturedEntries | undefined {
  return value === undefined ? undefined : captureEntries([value]);
}

type CapturedFields = Pick<
  PreviewFeedback,
  "userNotes" | "userNoteEntries" | "annotatedSnapshot" | "liveChanges" | "liveChangeEntries"
>;

function capturedFields(args: {
  readonly notes: CapturedEntries | undefined;
  readonly changes: CapturedEntries | undefined;
  readonly annotatedSnapshot: string | undefined;
}): CapturedFields {
  return {
    ...(args.notes !== undefined ? { userNotes: args.notes.joined, userNoteEntries: args.notes.entries } : {}),
    ...(args.annotatedSnapshot !== undefined ? { annotatedSnapshot: args.annotatedSnapshot } : {}),
    ...(args.changes !== undefined ? { liveChanges: args.changes.joined, liveChangeEntries: args.changes.entries } : {}),
  };
}

/** The structured stage payload when it validates against the declared schema. */
function readStructuredPayload(value: WorkflowSerializableValue | undefined): PreviewFeedbackPayload | undefined {
  if (value === undefined || value === null) return undefined;
  return Value.Check(previewFeedbackSchema, value) ? value : undefined;
}

/**
 * Whether the prose report contradicts itself: more than one
 * `decision`/`review_decision` label, or a field label repeated with a
 * different value. Neither is resolvable — taking the first value is exactly
 * how a placeholder `user_notes: none` came to outrank a real note filed under
 * a repeat of the same label — so the round is left unknown.
 * cross-ref: issue #2401 amendment 3.
 */
function textIsConflicted(text: string): boolean {
  const decisionLabels = fieldOccurrences(text, "decision").length + fieldOccurrences(text, "review_decision").length;
  if (decisionLabels > 1) return true;
  return (
    hasConflictingOccurrences(fieldOccurrences(text, "user_notes")) ||
    hasConflictingOccurrences(fieldOccurrences(text, "live_changes")) ||
    hasConflictingOccurrences(fieldOccurrences(text, "annotated_snapshot"))
  );
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
    const notes = captureEntries(payload.user_notes);
    const changes = captureEntries(payload.live_changes);
    const snapshot = payload.annotated_snapshot?.trim();
    // `approve` alongside captured work is a contradiction: the user asked for
    // something, so exporting now would discard it. Revise instead.
    const captured = notes !== undefined || changes !== undefined;
    return {
      ...base,
      decision: payload.decision === "approve" && captured ? "revise" : payload.decision,
      source: "structured",
      ...capturedFields({
        notes,
        changes,
        annotatedSnapshot: snapshot !== undefined && snapshot.length > 0 ? snapshot : undefined,
      }),
    };
  }

  // Prose can never approve (issue #2401 amendment 1). A stage that returned no
  // schema-valid structured answer either captured work the next round must
  // apply — `revise` — or left this round unknown. A labeled `decision:
  // approve` in prose is NOT approval: only the structured payload, or the
  // run-level skip choice, can end the review, so a report the parser cannot
  // trust stops the run instead of exporting over the review.
  const notes = captureBlock(extractUserNotes(text));
  const changes = captureBlock(extractLiveChanges(text));
  const captured = notes !== undefined || changes !== undefined;
  const decision: PreviewFeedbackDecision = captured && !textIsConflicted(text) ? "revise" : "indeterminate";
  return {
    ...base,
    decision,
    source: "text",
    ...capturedFields({ notes, changes, annotatedSnapshot: extractAnnotatedSnapshot(text) }),
  };
}

export function hasMeaningfulUserNotes(feedback: PreviewFeedback): boolean {
  return typeof feedback.userNotes === "string" && feedback.userNotes.length > 0;
}

export function hasMeaningfulLiveChanges(feedback: PreviewFeedback): boolean {
  return typeof feedback.liveChanges === "string" && feedback.liveChanges.length > 0;
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
 * The persisted artifact shape: exactly the declared schema at the top level,
 * plus one nested `meta` block. Stripping `meta` leaves a value that validates
 * against `previewFeedbackSchema`, which is what makes the deliverable the
 * schema's own shape rather than a look-alike.
 *
 * The schema admits only `approve` and `revise`, so `indeterminate` cannot sit
 * at the top level. An unrecoverable round persists the fail-closed `revise`
 * there and records its real outcome in `meta.decision`, which is what
 * `loadPreviewFeedback` restores. cross-ref: issue #2401 items A.5 and A.6.
 */
type PreviewFeedbackArtifact = PreviewFeedbackPayload & {
  readonly meta: {
    readonly iteration: number;
    readonly stage_name: string;
    readonly captured_at: string;
    readonly source: PreviewFeedbackSource;
    readonly decision: PreviewFeedbackDecision;
    readonly text: string;
  };
};

/**
 * The schema's per-entry array for a captured field. The per-entry values are
 * authoritative when present, so a note spanning several lines stays one entry;
 * a record carrying only the joined block persists as that single entry rather
 * than being split on newlines. cross-ref: issue #2401.
 */
function toEntries(entries: readonly string[] | undefined, joined: string | undefined): string[] {
  if (entries !== undefined) return [...entries];
  const value = joined?.trim() ?? "";
  return value.length > 0 ? [value] : [];
}

function toArtifact(feedback: PreviewFeedback): PreviewFeedbackArtifact {
  return {
    decision: feedback.decision === "approve" ? "approve" : "revise",
    user_notes: toEntries(feedback.userNoteEntries, feedback.userNotes),
    live_changes: toEntries(feedback.liveChangeEntries, feedback.liveChanges),
    ...(feedback.annotatedSnapshot !== undefined ? { annotated_snapshot: feedback.annotatedSnapshot } : {}),
    meta: {
      iteration: feedback.iteration,
      stage_name: feedback.stageName,
      captured_at: feedback.capturedAt,
      source: feedback.source,
      decision: feedback.decision,
      text: feedback.text,
    },
  };
}

/**
 * Drop a file a failed write left behind, so a stale round can never be read
 * back as this round's outcome. cross-ref: issue #2401 item A.5.
 */
function discardStaleFile(path: string): void {
  try {
    if (existsSync(path)) rmSync(path, { force: true });
  } catch {
    /* the caller still reports the failed write */
  }
}

/**
 * Persist the round as durable workflow artifacts under `<artifactDir>/feedback/`.
 * Written on every round — approvals and indeterminate rounds included — because
 * the artifact, not the stage's prose, is what the refinement loop reads back.
 *
 * The JSON deliverable is required, so a failed write throws after discarding
 * whatever sits at the path. Swallowing the failure would leave an earlier
 * round's record — an approval, say — for the next durable read to restore as
 * this round's outcome. The markdown transcript copy and the annotated-snapshot
 * copies stay best-effort, and a stale markdown copy is discarded the same way.
 * cross-ref: issue #1464 fix (5), issue #2401 item A.5.
 */
export function persistPreviewFeedback(input: {
  readonly artifactDir: string;
  readonly workflowCwd: string;
  readonly feedback: PreviewFeedback;
}): void {
  const { feedback } = input;
  const feedbackDir = join(input.artifactDir, "feedback");
  const slug = `iteration-${feedback.iteration}`;
  const artifactPath = feedbackArtifactPath(input.artifactDir, feedback.iteration);
  try {
    mkdirSync(feedbackDir, { recursive: true });
    writeFileSync(artifactPath, `${JSON.stringify(toArtifact(feedback), null, 2)}\n`);
  } catch (error) {
    discardStaleFile(artifactPath);
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `open-claude-design ${feedback.stageName}: failed to write the feedback deliverable at ${artifactPath}: ${reason}`,
    );
  }
  const markdownPath = join(feedbackDir, `${slug}.md`);
  try {
    writeFileSync(markdownPath, `${feedback.text}\n`);
  } catch {
    discardStaleFile(markdownPath);
  }
  copyAnnotationArtifacts(feedbackDir, slug, feedback, input.workflowCwd);
}

function isRecord(value: WorkflowSerializableValue): value is { readonly [key: string]: WorkflowSerializableValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDecision(value: WorkflowSerializableValue | undefined): value is PreviewFeedbackDecision {
  return value === "approve" || value === "revise" || value === "indeterminate";
}

function readString(value: WorkflowSerializableValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

type PreviewFeedbackMeta = {
  readonly iteration: number;
  readonly stageName: string;
  readonly capturedAt: string;
  readonly source: PreviewFeedbackSource;
  /** The round's real outcome — the value the loop acts on. */
  readonly decision: PreviewFeedbackDecision;
  readonly text: string;
};

/**
 * The artifact's `meta` block, or undefined when any field is absent or the
 * wrong type. Metadata is required, `decision` included: a file without it did
 * not come from `persistPreviewFeedback` and must not be read as a round's
 * outcome. There is no fall back to the top-level decision — the top level
 * carries the fail-closed `revise` an indeterminate round was forced to write,
 * so reading it as the round's outcome would restore a decision the stage never
 * reached. cross-ref: issue #2401 amendment 2.
 */
function readMeta(value: WorkflowSerializableValue | undefined): PreviewFeedbackMeta | undefined {
  if (value === undefined || !isRecord(value)) return undefined;
  const iteration = value.iteration;
  const stageName = readString(value.stage_name);
  const capturedAt = readString(value.captured_at);
  const source = value.source;
  const decision = value.decision;
  const text = value.text;
  if (typeof iteration !== "number" || !Number.isFinite(iteration)) return undefined;
  if (stageName === undefined || capturedAt === undefined) return undefined;
  if (source !== "structured" && source !== "text") return undefined;
  if (!isDecision(decision)) return undefined;
  if (typeof text !== "string") return undefined;
  return { iteration, stageName, capturedAt, source, decision, text };
}

/**
 * Read the durable per-round artifact back into a `PreviewFeedback`. Returns
 * undefined when the file is missing or malformed; never throws, so the caller
 * decides what an unreadable deliverable means. cross-ref: issue #2401.
 *
 * Fail-closed on the whole record, not on the fields it happens to read: the
 * top level minus `meta` must itself validate against `previewFeedbackSchema`,
 * every metadata field must be present and well-typed, and the artifact must
 * name the round the caller asked for. Because the schema declares
 * `additionalProperties: false`, an unknown top-level key, a missing declared
 * field, and a decision outside the union are each rejected by that one check:
 * a partial file — `{"decision":"approve"}`, say — is malformed, not an
 * approval, and so is a record that smuggles an extra top-level field.
 *
 * The restored decision is `meta.decision`, which is required, so a round that
 * was indeterminate reloads as `indeterminate` rather than as the fail-closed
 * `revise` the schema forced onto the top level.
 *
 * The two decisions must also pair the way `toArtifact` writes them: `approve`
 * at the top level for an approving round, `revise` for every other. A record
 * pairing them any other way — top-level `revise` under `meta.decision:
 * "approve"`, say — is one this module could not have written, so it is
 * malformed rather than an approval.
 *
 * An `approve` record carrying notes or live changes is malformed too:
 * `toPreviewFeedback` coerces that contradiction to `revise` before it is ever
 * written, so on disk it means the record was rewritten. Approval never
 * restores over captured work. cross-ref: issue #2401 items A.3 and A.6.
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
    if (!isRecord(parsed)) return undefined;
    const { meta: rawMeta, ...declared } = parsed;
    if (!Value.Check(previewFeedbackSchema, declared)) return undefined;
    const notes = captureEntries(declared.user_notes);
    const changes = captureEntries(declared.live_changes);
    const captured = notes !== undefined || changes !== undefined;
    const meta = readMeta(rawMeta);
    if (meta === undefined) return undefined;
    if (meta.iteration !== input.iteration) return undefined;
    if (meta.stageName.trim() !== input.stageName.trim()) return undefined;
    const decision = meta.decision;
    if (declared.decision !== (decision === "approve" ? "approve" : "revise")) return undefined;
    if (decision === "approve" && captured) return undefined;
    const snapshot = declared.annotated_snapshot?.trim();
    return {
      iteration: meta.iteration,
      stageName: meta.stageName,
      text: meta.text,
      decision,
      source: meta.source,
      capturedAt: meta.capturedAt,
      ...capturedFields({
        notes,
        changes,
        annotatedSnapshot: snapshot !== undefined && snapshot.length > 0 ? snapshot : undefined,
      }),
    };
  } catch {
    return undefined;
  }
}
