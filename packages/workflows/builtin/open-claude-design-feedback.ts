/**
 * open-claude-design feedback threading.
 *
 * The `user-feedback-*` stages capture Playwright annotation feedback (user
 * notes + annotated snapshot) from the user. This module is the durable carrier
 * for that feedback: it persists the structured stage result as a workflow
 * artifact and renders the user annotations that the next `generate-*` stage
 * must honor. cross-ref: issue #1464.
 *
 * The stage declares `previewFeedbackSchema` as its structured output, so the
 * feedback round finalizes as a schema-validated value rather than as prose a
 * later resume-continuation turn can replace. Every round is persisted as
 * `<artifactDir>/feedback/iteration-N.json`.
 * cross-ref: issue #2401.
 */

import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Type, type Static } from "typebox";
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

/** The only outcomes a structured feedback round can produce. */
export type PreviewFeedbackDecision = "approve" | "revise";

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
  /** Human-readable structured feedback written beside the durable record. */
  readonly text: string;
  /** Explicit round outcome; drives the refinement loop. */
  readonly decision: PreviewFeedbackDecision;
  /** Captured user annotation notes when the user actually annotated. */
  readonly userNotes?: string;
  /** One entry per note; `userNotes` is these joined. */
  readonly userNoteEntries?: readonly string[];
  /** Captured annotated-snapshot artifact path when one exists. */
  readonly annotatedSnapshot?: string;
  /** Captured summary of the variants/edits accepted during the live review. */
  readonly liveChanges?: string;
  /** One entry per accepted change; `liveChanges` is these joined. */
  readonly liveChangeEntries?: readonly string[];
  /** ISO timestamp when the feedback was captured. */
  readonly capturedAt: string;
};

type PreviewResultLike = {
  readonly structured?: WorkflowSerializableValue;
};

/** Keep the structured entries together for prompt rendering and persistence. */
function captureEntries(entries: readonly string[]): CapturedEntries | undefined {
  return entries.length === 0 ? undefined : { entries: [...entries], joined: entries.join("\n") };
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

/** Render the structured answer as the human-readable per-round transcript copy. */
function structuredFeedbackText(payload: PreviewFeedbackPayload): string {
  const lines = [`decision: ${payload.decision}`, "user_notes:"];
  lines.push(...payload.user_notes.map((note) => `- ${note}`));
  lines.push("live_changes:");
  lines.push(...payload.live_changes.map((change) => `- ${change}`));
  if (payload.annotated_snapshot !== undefined) {
    lines.push(`annotated_snapshot: ${payload.annotated_snapshot}`);
  }
  return lines.join("\n");
}

/**
 * Build a PreviewFeedback record from the schema-backed stage result.
 *
 * The stage runner guarantees that a resolved schema-backed stage has called
 * `structured_output` with a schema-valid value. The structured payload is the
 * sole source for this record; no prose fallback or second validation path is
 * needed. cross-ref: issue #2401.
 */
export function toPreviewFeedback(input: {
  readonly iteration: number;
  readonly stageName: string;
  readonly result: PreviewResultLike;
}): PreviewFeedback {
  const payload = input.result.structured as PreviewFeedbackPayload;
  const notes = captureEntries(payload.user_notes);
  const changes = captureEntries(payload.live_changes);
  const snapshot = payload.annotated_snapshot;
  const capturedWork = payload.user_notes.length > 0 || payload.live_changes.length > 0;

  return {
    iteration: input.iteration,
    stageName: input.stageName,
    text: structuredFeedbackText(payload),
    decision: payload.decision === "approve" && capturedWork ? "revise" : payload.decision,
    capturedAt: new Date().toISOString(),
    ...capturedFields({
      notes,
      changes,
      annotatedSnapshot: snapshot,
    }),
  };
}

export function hasMeaningfulUserNotes(feedback: PreviewFeedback): boolean {
  return typeof feedback.userNotes === "string" && feedback.userNotes.length > 0;
}

export function hasMeaningfulLiveChanges(feedback: PreviewFeedback): boolean {
  return typeof feedback.liveChanges === "string" && feedback.liveChanges.length > 0;
}

function feedbackLabel(feedback: PreviewFeedback): string {
  return feedback.iteration === 0 ? "the initial preview" : "the live design review";
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
      const lines = [`### User annotations from ${feedbackLabel(feedback)}`, ""];
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

/** The durable record written beside the human-readable markdown copy. */
type PreviewFeedbackArtifact = PreviewFeedbackPayload & {
  readonly meta: {
    readonly iteration: number;
    readonly stage_name: string;
    readonly captured_at: string;
  };
};

function toEntries(entries: readonly string[] | undefined, joined: string | undefined): string[] {
  if (entries !== undefined) return [...entries];
  return joined === undefined ? [] : [joined];
}

function toArtifact(feedback: PreviewFeedback): PreviewFeedbackArtifact {
  return {
    decision: feedback.decision,
    user_notes: toEntries(feedback.userNoteEntries, feedback.userNotes),
    live_changes: toEntries(feedback.liveChangeEntries, feedback.liveChanges),
    ...(feedback.annotatedSnapshot !== undefined ? { annotated_snapshot: feedback.annotatedSnapshot } : {}),
    meta: {
      iteration: feedback.iteration,
      stage_name: feedback.stageName,
      captured_at: feedback.capturedAt,
    },
  };
}

/** Drop a file a failed write left behind before reporting the failure. */
function discardStaleFile(path: string): void {
  try {
    if (existsSync(path)) rmSync(path, { force: true });
  } catch {
    /* the caller still reports the failed write */
  }
}

/**
 * Persist the round as durable workflow artifacts under `<artifactDir>/feedback/`.
 * The JSON record is written on every round, including approvals. A failed JSON
 * write clears the path and throws, so an earlier round cannot remain readable
 * as this round's outcome. The markdown transcript and annotated-snapshot
 * copies remain best-effort. cross-ref: issue #1464 fix (5), issue #2401.
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
