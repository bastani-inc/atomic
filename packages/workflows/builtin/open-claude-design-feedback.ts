/**
 * open-claude-design live-review feedback.
 *
 * One `user-feedback-*` stage runs the whole live review session: the user
 * picks elements, accepts on-brand variants that are written into
 * `preview.html` in place, steers the page, and leaves when done. This module
 * is the durable carrier for what that session decided: it persists the
 * structured stage result as a workflow artifact and renders the user's notes
 * as the brief for a regeneration. cross-ref: issues #1464, #2411.
 *
 * The stage declares `previewFeedbackSchema` as its structured output, so the
 * session finalizes as a schema-validated value rather than as prose a later
 * resume-continuation turn can replace. Every session is persisted as
 * `<artifactDir>/feedback/iteration-N.json`.
 * cross-ref: issue #2401.
 */

import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Type, type Static } from "typebox";
import type { WorkflowSerializableValue } from "../src/shared/types.js";

/**
 * The structured final answer the `user-feedback-*` stage must return. Used as
 * the stage `schema`, which both finalizes the stage result and shapes the
 * durable per-session artifact.
 */
export const previewFeedbackSchema = Type.Object(
  {
    decision: Type.Union([Type.Literal("export"), Type.Literal("regenerate")], {
      description:
        "`export` when the user wants this preview exported as it now stands; `regenerate` only when they want a fresh pass designed from the brief.",
    }),
    user_notes: Type.Array(Type.String(), {
      description:
        "Every note the user typed or dictated, verbatim, one entry per note. Empty when the user typed nothing. On `regenerate` these notes are the brief for the fresh pass.",
    }),
    live_changes: Type.Array(Type.String(), {
      description:
        "Every variant or edit the user accepted during the live review, one entry per accepted change. These are already applied to the preview in place.",
    }),
    annotated_snapshot: Type.Optional(
      Type.String({ description: "Path to the annotated screenshot captured during the review, when one exists." }),
    ),
  },
  { additionalProperties: false },
);

/** The validated structured payload the `user-feedback-*` stage returns. */
export type PreviewFeedbackPayload = Static<typeof previewFeedbackSchema>;

/** The only outcomes a live review session can produce. */
export type PreviewFeedbackDecision = "export" | "regenerate";

/** Per-entry captured values plus the joined block consumers read. */
type CapturedEntries = {
  readonly entries: readonly string[];
  readonly joined: string;
};

/** A single captured live review session. */
export type PreviewFeedback = {
  /** 1..N for live review sessions. */
  readonly iteration: number;
  /** Originating stage name, e.g. `user-feedback-1`. */
  readonly stageName: string;
  /** Human-readable structured feedback written beside the durable record. */
  readonly text: string;
  /** Explicit session outcome; only `regenerate` runs another generate round. */
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

/** Render the structured answer as the human-readable per-session transcript copy. */
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
 * sole source for this record; no prose fallback, no second validation path,
 * and no second-guessing of the decision the user just made about an artifact
 * they were editing. cross-ref: issues #2401, #2411.
 */
export function toPreviewFeedback(input: {
  readonly iteration: number;
  readonly stageName: string;
  readonly result: PreviewResultLike;
}): PreviewFeedback {
  const payload = input.result.structured as PreviewFeedbackPayload;

  return {
    iteration: input.iteration,
    stageName: input.stageName,
    text: structuredFeedbackText(payload),
    decision: payload.decision,
    capturedAt: new Date().toISOString(),
    ...capturedFields({
      notes: captureEntries(payload.user_notes),
      changes: captureEntries(payload.live_changes),
      annotatedSnapshot: payload.annotated_snapshot,
    }),
  };
}

/**
 * The user's notes rendered as the brief for a regeneration pass. Accepted
 * live variants are deliberately absent: they are already in the preview, and
 * a regeneration is a fresh take rather than a rewrite that has to preserve
 * them. The durable record named in the same prompt still carries them
 * (issue #2411).
 */
export function userNotesBrief(feedback: PreviewFeedback): string {
  const notes = (feedback.userNotes ?? "").trim();
  const lines =
    notes.length > 0
      ? [notes]
      : [
          "The user asked for a fresh pass without writing notes. They rejected the direction, not a detail: take a materially different one from the brief, design context, and references.",
        ];
  if (feedback.annotatedSnapshot !== undefined) {
    lines.push("", `Annotated snapshot: ${feedback.annotatedSnapshot}`);
  }
  return lines.join("\n");
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

/** Path of the durable per-session feedback artifact. */
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
 * Persist the session as durable workflow artifacts under `<artifactDir>/feedback/`.
 * The JSON record is written for every session, exports included. A failed JSON
 * write clears the path and throws, so an earlier session cannot remain
 * readable as this session's outcome. The markdown transcript and
 * annotated-snapshot copies remain best-effort.
 * cross-ref: issue #1464 fix (5), issue #2401.
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
