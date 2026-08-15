import type { WorkflowTaskResult } from "../src/shared/types.js";
import {
  ANTI_SLOP_RULES,
  HTML_PREVIEW_RULES,
  REFERENCE_PRECEDENCE,
  taggedPrompt,
} from "./open-claude-design-utils.js";
import {
  feedbackArtifactPath,
  persistPreviewFeedback,
  previewFeedbackSchema,
  toPreviewFeedback,
  userNotesBrief,
  type PreviewFeedback,
} from "./open-claude-design-feedback.js";
import {
  LIVE_REVIEW_GATE_OPTIONS,
  buildLiveReviewGateMessage,
  isUiUnavailableRejection,
  type LiveReviewGateUi,
} from "./open-claude-design-setup.js";

import {
  buildLiveEventPrompt,
  buildLiveSessionStartPrompt,
  buildLiveSessionSummaryPrompt,
  needsModel,
  pollLiveEvent,
  replyLiveEvent,
  replyTokenFor,
} from "./open-claude-design-live-protocol.js";

const GROUNDED_REPORTING =
  "Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.";

type DesignContext = {
  task(name: string, options: object): Promise<WorkflowTaskResult>;
  parallel(steps: readonly object[], options: { readonly task: string }): Promise<WorkflowTaskResult[]>;
  /** Durable tool node; the live review loop is built from these. */
  tool<T>(name: string, args: object, fn: (handle: { readonly signal: AbortSignal }) => Promise<T>): Promise<T>;
};

type ModelConfig = Record<string, object | string | readonly string[]>;

type ForkContinuationOptions = {
  readonly context?: "fork";
  readonly forkFromSessionFile?: string;
};

function forkContinuationOptions(
  sessionFile: string | undefined,
): ForkContinuationOptions {
  return sessionFile === undefined || sessionFile.length === 0
    ? {}
    : { context: "fork", forkFromSessionFile: sessionFile };
}

type RefineOptions = {
  readonly designContext: DesignContext;
  readonly prompt: string;
  readonly outputType: string;
  /** Maximum fresh regenerations after `generate-1` (issue #2411). */
  readonly maxRefinements: number;
  readonly previewPath: string;
  readonly previewFileUrl: string;
  readonly artifactDir: string;
  readonly browserBootstrapRules: string;
  /** Path to the persisted design-context.md artifact (issue #2121). */
  readonly designContextFile: string;
  /** Path to the persisted references.md artifact (issue #2121). */
  readonly referencesFile: string;
  readonly designModelConfig: ModelConfig;
  readonly workflowCwd: string;
  readonly importContext?: string;
  readonly ui: LiveReviewGateUi;
};

/** A fresh pass a live review asked for, with the record it was asked in. */
type PendingRegeneration = {
  readonly feedback: PreviewFeedback;
  readonly artifactFile: string;
};

/**
 * Stated in the returned design summary when a live review asked for a fresh
 * pass the budget could not run. A dropped request is never silent (#2411).
 */
function regenerationBudgetNote(maxRefinements: number): string {
  return `Note: the live review asked for a fresh design pass, but the regeneration budget was already spent (max_refinements: ${maxRefinements}). This preview is exported as it stands; re-run \`/workflow open-claude-design\` to start another pass.`;
}

/**
 * Generate a design, then review it in one live session.
 *
 * The live session is itself unbounded: the user picks elements, accepts
 * on-brand variants written into `preview.html` in place, and steers, until
 * they leave. So the session's own work needs no follow-up generate round.
 * The outer loop survives only for what live cannot do — starting over from
 * the brief, design context, and references when the user rejects the
 * direction rather than the details — and `maxRefinements` bounds exactly
 * those regenerations. cross-ref: issue #2411.
 */
export async function refineOpenClaudeDesign(options: RefineOptions): Promise<{ readonly latestDesign: string; readonly approvedForExport: boolean; readonly refinementCount: number; }> {
  const { designContext, prompt, outputType, maxRefinements, previewPath, previewFileUrl, artifactDir, browserBootstrapRules, designContextFile, referencesFile, designModelConfig, workflowCwd } = options;
  const importContext = options.importContext ?? "";
  let latestDesign = "";
  let latestGenerateSessionFile: string | undefined;
  let latestReviewSessionFile: string | undefined;
  let approvedForExport = false;
  let generateRounds = 0;
  let regenerations = 0;
  let budgetExhausted = false;

  /** Run `generate-1`, or the fresh pass a review session asked for. */
  const runGenerateRound = async (regeneration?: PendingRegeneration): Promise<void> => {
    const round = generateRounds + 1;
    const generateStageName = `generate-${round}`;

    // Large research context travels by artifact file (`reads` + explicit
    // read instructions in the prompt), not as an inline `previous` payload,
    // so a single oversized research result cannot become a single oversized
    // prompt message (issue #2121). Only the word-capped prior design summary
    // travels inline.
    const generated = await designContext.task(generateStageName, {
      prompt: regeneration === undefined
        ? buildInitialGeneratePrompt({
            prompt,
            outputType,
            previewPath,
            designContextFile,
            referencesFile,
            importContext,
          })
        : buildRegeneratePrompt({
            prompt,
            outputType,
            previewPath,
            designContextFile,
            referencesFile,
            previousDesign: latestDesign,
            importContext,
            feedback: regeneration.feedback,
            feedbackArtifactFile: regeneration.artifactFile,
          }),
      reads:
        regeneration === undefined
          ? [designContextFile, referencesFile]
          : [designContextFile, referencesFile, regeneration.artifactFile],
      ...(regeneration === undefined
        ? {}
        : { previous: { name: "previous-design", text: latestDesign } }),
      ...designModelConfig,
      ...forkContinuationOptions(latestGenerateSessionFile),
    });
    latestDesign = generated.text;
    latestGenerateSessionFile = generated.sessionFile ?? latestGenerateSessionFile;
    generateRounds = round;
  };

  await runGenerateRound();

  for (;;) {
    // Deterministic live-review gate (issue #2060): the user-feedback stage
    // waits on a browser long-poll that never sets `awaiting_input`, so raise
    // a run-level `ctx.ui` prompt first. It fires the needs-attention badge,
    // names the preview URL, and syncs the review to the user's presence.
    // Only the executor's unavailable-UI rejection (headless / no adapter)
    // degrades to running the review; lifecycle failures such as interruption
    // or a failed durable checkpoint must propagate and stop the workflow.
    const gateChoice = await options.ui
      .select(
        buildLiveReviewGateMessage({
          round: generateRounds,
          regenerationsLeft: maxRefinements - regenerations,
          previewPath,
          previewFileUrl,
        }),
        LIVE_REVIEW_GATE_OPTIONS,
      )
      .catch((error: unknown) => {
        if (isUiUnavailableRejection(error)) return LIVE_REVIEW_GATE_OPTIONS[0];
        throw error;
      });
    if (gateChoice === LIVE_REVIEW_GATE_OPTIONS[1]) {
      approvedForExport = true;
      break;
    }

    // A rejected feedback stage propagates and fails the run (issue #2123;
    // the #1499 catch-then-approve path). Browser/tooling trouble never
    // rejects: playwright-cli is auto-installed up front, the runner exits
    // early when the browser is unavailable, and the stage prompt requires a
    // degraded non-empty report instead of failing. What rejects here is
    // model/infra failure — provider errors, fallback exhaustion, broken
    // session forks — and that must never be laundered into an export.
    //
    // The stage declares `previewFeedbackSchema`, so the session finalizes as
    // a schema-validated structured answer that a later resume-continuation
    // turn cannot displace (issue #2401).
    const round = generateRounds;
    const feedbackStageName = `user-feedback-${round}`;
    const userFeedbackResult = await runLiveReviewSession({
      designContext,
      round,
      feedbackStageName,
      previewPath,
      previewFileUrl,
      browserBootstrapRules,
      designModelConfig,
      workflowCwd,
      sessionFile: latestReviewSessionFile,
      onSessionFile: (file) => {
        latestReviewSessionFile = file;
      },
    });
    latestReviewSessionFile = userFeedbackResult.sessionFile ?? latestReviewSessionFile;
    const feedback = toPreviewFeedback({ iteration: round, stageName: feedbackStageName, result: userFeedbackResult });
    persistPreviewFeedback({ artifactDir, workflowCwd, feedback });

    // The structured result drives this loop in memory. The durable artifact
    // remains the authoritative record the next generate stage reads.
    if (feedback.decision === "export") {
      approvedForExport = true;
      break;
    }
    if (regenerations >= maxRefinements) {
      budgetExhausted = true;
      break;
    }
    regenerations += 1;
    await runGenerateRound({
      feedback,
      artifactFile: feedbackArtifactPath(artifactDir, round),
    });
  }

  return {
    latestDesign: budgetExhausted
      ? [latestDesign, regenerationBudgetNote(maxRefinements)].join("\n\n")
      : latestDesign,
    approvedForExport,
    refinementCount: generateRounds,
  };
}

type LiveReviewSessionOptions = {
  readonly designContext: DesignContext;
  readonly round: number;
  readonly feedbackStageName: string;
  readonly previewPath: string;
  readonly previewFileUrl: string;
  readonly browserBootstrapRules: string;
  readonly designModelConfig: ModelConfig;
  readonly workflowCwd: string;
  readonly sessionFile: string | undefined;
  readonly onSessionFile: (sessionFile: string) => void;
};

/**
 * Run one live review session and return its structured deliverable.
 *
 * The workflow owns the poll loop: `ctx.tool` polls and replies, and the model
 * is called back only for the events that need it. Termination is the helper's
 * `exit` event rather than a model's judgment that a review looked finished,
 * which is what let a poll timeout end a review the user was still in.
 *
 * When the impeccable live scripts are not installed for this project, or the
 * host predates `ctx.tool`, fall back to the model-driven single stage.
 */
async function runLiveReviewSession(options: LiveReviewSessionOptions): Promise<WorkflowTaskResult> {
  const { designContext, round, feedbackStageName, previewPath, previewFileUrl, browserBootstrapRules, designModelConfig, workflowCwd } = options;
  let sessionFile = options.sessionFile;
  const remember = (result: WorkflowTaskResult): WorkflowTaskResult => {
    if (result.sessionFile !== undefined) {
      sessionFile = result.sessionFile;
      options.onSessionFile(result.sessionFile);
    }
    return result;
  };

  const tool = designContext.tool;

  remember(
    await designContext.task(`${feedbackStageName}-start`, {
      prompt: buildLiveSessionStartPrompt({ previewPath, previewFileUrl, browserBootstrapRules, round }),
      ...designModelConfig,
      ...forkContinuationOptions(sessionFile),
    }),
  );

  for (let index = 1; ; index += 1) {
    // `timeout` is absorbed inside the poll, so an idle hour costs no nodes and
    // never looks like an ending.
    const event = await tool(`live-poll-${round}-${index}`, { round, index }, async ({ signal }) =>
      pollLiveEvent({ workflowCwd, signal }),
    );
    if (event.type === "exit") break;
    // accept / discard / prefetch are acknowledged by the poll script itself.
    if (!needsModel(event)) continue;
    remember(
      await designContext.task(`live-${event.type}-${round}-${index}`, {
        prompt: buildLiveEventPrompt({ event, previewPath }),
        ...designModelConfig,
        ...forkContinuationOptions(sessionFile),
      }),
    );
    const token = replyTokenFor(event);
    await tool(`live-reply-${round}-${index}`, { round, index, token }, async ({ signal }) =>
      replyLiveEvent({ workflowCwd, token, signal }),
    );
  }

  return remember(
    await designContext.task(feedbackStageName, {
      prompt: buildLiveSessionSummaryPrompt({ previewPath }),
      schema: previewFeedbackSchema,
      ...designModelConfig,
      ...forkContinuationOptions(sessionFile),
    }),
  );
}

function buildInitialGeneratePrompt(args: {
  readonly prompt: string;
  readonly outputType: string;
  readonly previewPath: string;
  readonly designContextFile: string;
  readonly referencesFile: string;
  readonly importContext: string;
}): string {
  return taggedPrompt([
    ["design_brief", args.prompt],
    [
      "design_context_file",
      `Read the file at ${args.designContextFile} for the project design context (PRODUCT.md/DESIGN.md summary) and the ds-* design-system evidence before designing.`,
    ],
    ["reference_context", args.importContext],
    [
      "reference_inspiration_file",
      `Read the file at ${args.referencesFile} for the curated reference inspiration to heavily emulate.`,
    ],
    ["reference_precedence", REFERENCE_PRECEDENCE],
    ["preview_artifact_path", args.previewPath],
    ["html_rules", HTML_PREVIEW_RULES],
    ["anti_design_slop_rules", ANTI_SLOP_RULES],
    ["role", "You are an opinionated staff design engineer."],
    [
      "objective",
      `Create the first production-ready ${args.outputType} for: ${args.prompt}. Write an interactive browser preview and apply impeccable \`craft\`; each decision must trace to the brief, references, design system, or reference context.`,
    ],
    [
      "instructions",
      [
        `First read the design-context and reference-inspiration files named above; they are the design system and reference authority for every decision. If a file is missing, say so and proceed from the brief.`,
        `Create the HTML artifact exactly at ${args.previewPath}.`,
        "Follow <reference_precedence>; heavily reference the reference-inspiration file without copying wholesale or inventing traits.",
        `Build the requested output_type (${args.outputType}): render full realistic layouts for prototypes/pages, or the component in at least three representative contexts.`,
        "Include structure, states, accessibility, responsive behavior, and integration notes as HTML comments so the preview stays clean.",
        "Use project language rather than generic placeholders when conventions exist. Add no features or abstractions beyond this design brief.",
      ].join("\n"),
    ],
    [
      "output_format",
      [
        "In at most 500 words, return Markdown, not the HTML body:",
        "1. Artifact overview",
        "2. Files written (including the absolute preview.html path)",
        "3. UI structure and states (by HTML section ID)",
        "4. Accessibility and responsive behavior",
        "5. Implementation notes",
        "6. Assumptions / open questions",
        GROUNDED_REPORTING,
      ].join("\n"),
    ],
  ]);
}

function buildRegeneratePrompt(args: {
  readonly prompt: string;
  readonly outputType: string;
  readonly previewPath: string;
  readonly designContextFile: string;
  readonly referencesFile: string;
  readonly previousDesign: string;
  readonly importContext: string;
  readonly feedback: PreviewFeedback;
  /** Durable record of the review session that asked for this pass (#2401). */
  readonly feedbackArtifactFile: string;
}): string {
  return taggedPrompt([
    ["design_brief", args.prompt],
    [
      "design_context_file",
      `Read the file at ${args.designContextFile} for the project design context (PRODUCT.md/DESIGN.md summary) and the ds-* design-system evidence before designing.`,
    ],
    ["reference_context", args.importContext],
    [
      "reference_inspiration_file",
      `Read the file at ${args.referencesFile} for the curated reference inspiration to heavily emulate.`,
    ],
    ["reference_precedence", REFERENCE_PRECEDENCE],
    ["preview_artifact_path", args.previewPath],
    [
      "user_feedback_record",
      `Read the file at ${args.feedbackArtifactFile}. It is the authoritative record of the live review session that asked for this fresh pass — the durable deliverable the feedback stage returned — and <user_notes> below is rendered from it. Where the two ever disagree, the file wins.`,
    ],
    ["user_notes", userNotesBrief(args.feedback)],
    ["previous_attempt_summary", args.previousDesign],
    ["html_rules", HTML_PREVIEW_RULES],
    ["anti_design_slop_rules", ANTI_SLOP_RULES],
    ["role", "You are an opinionated staff design engineer."],
    [
      "objective",
      `Design a fresh ${args.outputType} for: ${args.prompt}. The user reviewed the previous one live and rejected its direction, so design this one again from the brief, design context, references, and <user_notes>, applying impeccable \`craft\`.`,
    ],
    [
      "instructions",
      [
        "First read the design-context, reference-inspiration, and user_feedback_record files named above. <user_notes> is the brief for this pass; the brief, design context, and references are the rest of it.",
        "This is a new pass, not an edit pass. You may read the current HTML at preview_artifact_path for continuity, but do not treat it as the thing to revise, and do not carry the rejected direction forward.",
        `Write this pass to ${args.previewPath} as one self-contained HTML file; do not branch or create extra previews.`,
        "Address every user note visibly, or identify its DESIGN.md/reference-precedence conflict in the summary. Add no features or abstractions beyond the brief and those notes.",
      ].join("\n"),
    ],
    [
      "output_format",
      [
        "In at most 400 words, return Markdown, not the HTML body:",
        "1. Artifact written (path only)",
        "2. User notes addressed (each note and its application or conflict)",
        "3. How this pass differs from the rejected one",
        "4. Trade-offs / unresolved user notes",
        GROUNDED_REPORTING,
      ].join("\n"),
    ],
  ]);
}

type ExportOptions = {
  readonly designContext: DesignContext;
  readonly prompt: string;
  readonly outputType: string;
  readonly previewPath: string;
  readonly previewFileUrl: string;
  readonly specPath: string;
  readonly specFileUrl: string;
  readonly browserBootstrapRules: string;
  /** Path to the persisted design-context.md artifact (issue #2121). */
  readonly designContextFile: string;
  /** Path to the persisted references.md artifact (issue #2121). */
  readonly referencesFile: string;
  readonly latestDesign: string;
  readonly designModelConfig: ModelConfig;
};

export async function exportOpenClaudeDesign(options: ExportOptions): Promise<{ readonly latestDesign: string; readonly handoff: WorkflowTaskResult; }> {
  const { designContext, prompt, outputType, previewPath, previewFileUrl, specPath, specFileUrl, browserBootstrapRules, designContextFile, referencesFile, designModelConfig } = options;
  const latestDesign = options.latestDesign;

  const handoff = await designContext.task("exporter", {
    reads: [designContextFile, referencesFile],
    prompt: taggedPrompt([
      [
        "design_context_file",
        `Read the file at ${designContextFile} for the project design context (PRODUCT.md/DESIGN.md summary) and the ds-* design-system evidence to document.`,
      ],
      [
        "reference_inspiration_file",
        `Read the file at ${referencesFile} for the curated reference research that informed the approved design; use it wherever the spec cites visual direction or reference provenance.`,
      ],
      ["preview_artifact_path", previewPath],
      ["spec_artifact_path", specPath],
      ["final_design_summary", "{previous}"],
      ["html_rules", HTML_PREVIEW_RULES],
      ["anti_design_slop_rules", ANTI_SLOP_RULES],
      ["role", "You are an opinionated staff design engineer."],
      [
        "objective",
        `Export the final ${outputType} for "${prompt}" as a rich browser-readable HTML spec. Apply impeccable \`document\` and embed or link the approved preview so implementation reviewers see the agreed design.`,
      ],
      [
        "instructions",
        [
          "First read the design-context file named above, then read preview_artifact_path as the canonical approved design, and use the Write tool to create one self-contained HTML5 file at spec_artifact_path.",
          "In order, include: sticky header with title/status/run id; Executive Summary; Live Preview embedding the full preview via `<iframe srcdoc=\"...\">` or a side-by-side rendered copy in `<article class=\"preview-frame\">`; the six DESIGN.md sections (Overview, Colors, Typography, Elevation, Components, Do's and Don'ts) rendered with swatches, tables, and code blocks; Implementation handoff (Recommended files + components, Implementation steps, Usage example, Accessibility & responsive checklist, Validation commands, Known limitations); and an appendix linking the raw preview path.",
          "Use dense legible typography, generous whitespace, monospaced code, rendered hex/oklch swatches, and copy-to-clipboard hints in HTML comments.",
          `Show the absolute preview path (${previewPath}) and file URL (${previewFileUrl}) prominently. Preserve assumptions and limitations; introduce no requirement absent from the final design or DESIGN.md.`,
        ].join("\n"),
      ],
      [
        "output_format",
        [
          "In at most 600 words, return Markdown, not the HTML:",
          "1. Spec written to (absolute path)",
          "2. Sections included",
          "3. How to open the spec (playwright-cli command + manual fallback path)",
          "4. Recommended files and components",
          "5. Implementation steps",
          "6. Usage example",
          "7. Accessibility / responsive checklist",
          "8. Validation commands",
          "9. Known limitations",
          GROUNDED_REPORTING,
        ].join("\n"),
      ],
    ]),
    previous: { name: "final-design", text: latestDesign },
    ...designModelConfig,
  });

  await designContext
    .task("final-display", {
      prompt: taggedPrompt([
        ["spec_path", specPath],
        ["spec_file_url", specFileUrl],
        ["preview_path", previewPath],
        ["preview_file_url", previewFileUrl],
        ["browser_use_guidelines", browserBootstrapRules],
        ["role", "You are an opinionated staff design engineer."],
        [
          "objective",
          "Show the exported spec with the playwright-cli skill's `playwright-cli` command. Export is complete, so do not solicit changes; direct further changes to a new `/workflow open-claude-design` run and degrade gracefully when browser automation is unavailable.",
        ],
        [
          "instructions",
          [
            `Use the bootstrap rules, run \`playwright-cli open ${specFileUrl}\`, and if a browser executable is missing follow those rules and retry once before \`playwright-cli snapshot\`.`,
            "Do not run `show --annotate` or invite changes because no refinement pass remains.",
            `Prominently print the manual paths:\n- Final spec: ${specPath}\n- Approved preview: ${previewPath}`,
            "Unavailable tooling must not block the workflow; return the structured summary.",
          ].join("\n"),
        ],
        [
          "output_format",
          `Under 250 words, return Markdown with: \`display_method\` | \`spec_path\` | \`preview_path\` | \`manual_open_instructions\` | \`next_action_hint\` (how to re-run the workflow). ${GROUNDED_REPORTING}`,
        ],
      ]),
      ...designModelConfig,
    })
    .catch(() => undefined);

  return { latestDesign, handoff };
}
