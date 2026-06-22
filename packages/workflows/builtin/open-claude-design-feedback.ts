/**
 * open-claude-design feedback threading.
 *
 * The interactive `preview-display-*` stages capture Playwright annotation
 * feedback (user notes + annotated snapshot) from the user. Historically that
 * feedback was awaited-and-discarded, so the downstream `user-feedback-*` and
 * `apply-changes-*` stages never saw it and refined from internal critique
 * alone. This module is the durable carrier for that feedback: it parses the
 * preview-display stage output, persists it as a workflow artifact, and builds
 * the ordered refinement brief (user annotations FIRST, then internal critique)
 * that the refinement stages consume. cross-ref: issue #1464.
 */

import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, dirname, join, resolve, sep } from "node:path";

/** A single captured preview-display feedback round. */
export type PreviewFeedback = {
  /** 0 for the initial preview, 1..N for post-refinement previews. */
  readonly iteration: number;
  /** Originating stage name, e.g. `preview-display-initial`. */
  readonly stageName: string;
  /** Full markdown result text emitted by the preview-display stage. */
  readonly text: string;
  /** Extracted user annotation notes when the user actually annotated. */
  readonly userNotes?: string;
  /** Extracted annotated-snapshot artifact path when one was captured. */
  readonly annotatedSnapshot?: string;
  /** Extracted summary of the variants/edits the user accepted in the live QA session. */
  readonly liveChanges?: string;
  /** ISO timestamp when the feedback was captured. */
  readonly capturedAt: string;
};

type PreviewResultLike = { readonly text?: string };

/**
 * Field labels the preview-display stages are instructed to emit, stored in
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

/** Normalize a candidate label line into a canonical key (or undefined). */
function labelOf(line: string): string | undefined {
  const stripped = line
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+\.\s+/, "");
  const colonIdx = stripped.indexOf(":");
  const candidate = colonIdx >= 0 ? stripped.slice(0, colonIdx) : stripped;
  const key = canonicalLabel(candidate);
  return key.length > 0 ? key : undefined;
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
 * Extract the value of a labeled field (e.g. `user_notes`) from a preview-display
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

/** Build a PreviewFeedback record from a (possibly missing) stage result. */
export function toPreviewFeedback(input: {
  readonly iteration: number;
  readonly stageName: string;
  readonly result: PreviewResultLike | undefined;
}): PreviewFeedback {
  const text = (input.result?.text ?? "").trim();
  const userNotes = extractUserNotes(text);
  const annotatedSnapshot = extractAnnotatedSnapshot(text);
  const liveChanges = extractLiveChanges(text);
  return {
    iteration: input.iteration,
    stageName: input.stageName,
    text,
    capturedAt: new Date().toISOString(),
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
    : `refinement iteration ${feedback.iteration}`;
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
        `### User annotations from ${feedbackLabel(feedback)} (${feedback.stageName})`,
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
      text: "No interactive user annotations were captured in the preview-display stage(s). There is no user feedback to honor for this iteration; fall back to an impeccable critique of the live preview.",
    };
  }
  return { hasNotes: true, text: section };
}

/**
 * Build the merged refinement brief consumed by `apply-changes-*`. User
 * annotations are ordered ABOVE internal critique/QA so the apply stage honors
 * the user's direction first. cross-ref: issue #1464 expected behavior (3).
 */
export function buildRefinementBrief(input: {
  readonly userAnnotations: string;
  readonly reviewerDecision: string;
  readonly critique: string;
  readonly screenshot: string;
  readonly currentDesign: string;
}): string {
  return [
    "## User annotations (highest priority — address these before any internal critique)",
    "",
    input.userAnnotations.trim(),
    "",
    "## Reviewer refinement decision",
    "",
    input.reviewerDecision.trim(),
    "",
    "## Impeccable critique findings",
    "",
    input.critique.trim(),
    "",
    "## Screenshot / visual QA findings",
    "",
    input.screenshot.trim(),
    "",
    "## Current design summary",
    "",
    input.currentDesign.trim(),
  ].join("\n");
}

/**
 * Guardrail: every captured user annotation must be present verbatim in the
 * refinement prompt before the apply stage runs. If a `preview-display-*` stage
 * captured `user_notes` but they did not thread through, fail loudly instead of
 * silently refining without user feedback. cross-ref: issue #1464 fix (6).
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
          `open-claude-design ${stageName}: accepted live variants captured in ${feedback.stageName} were not threaded into the refinement context. Refusing to refine without user feedback (see issue #1464).`,
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

/**
 * Persist captured annotations as durable workflow artifacts under
 * `<artifactDir>/feedback/`. Only writes when the user actually provided
 * annotations (notes or an annotated snapshot). Best-effort: never throws.
 * cross-ref: issue #1464 fix (5).
 */
export function persistPreviewFeedback(input: {
  readonly artifactDir: string;
  readonly workflowCwd: string;
  readonly feedback: PreviewFeedback;
}): void {
  const { feedback } = input;
  if (
    !hasMeaningfulUserNotes(feedback) &&
    !hasMeaningfulLiveChanges(feedback) &&
    feedback.annotatedSnapshot === undefined
  ) {
    return;
  }
  try {
    const feedbackDir = join(input.artifactDir, "feedback");
    mkdirSync(feedbackDir, { recursive: true });
    const slug = `iteration-${feedback.iteration}`;
    writeFileSync(join(feedbackDir, `${slug}.md`), `${feedback.text}\n`);
    writeFileSync(
      join(feedbackDir, `${slug}.json`),
      `${JSON.stringify(
        {
          ...feedback,
          hasUserNotes: hasMeaningfulUserNotes(feedback),
          hasLiveChanges: hasMeaningfulLiveChanges(feedback),
        },
        null,
        2,
      )}\n`,
    );
    copyAnnotationArtifacts(feedbackDir, slug, feedback, input.workflowCwd);
  } catch {
    /* best-effort durability; never block the workflow */
  }
}
