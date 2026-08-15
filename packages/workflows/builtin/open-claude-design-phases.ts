import type { WorkflowTaskResult } from "../src/shared/types.js";
import {
  ANTI_SLOP_RULES,
  HTML_PREVIEW_RULES,
  REFERENCE_PRECEDENCE,
  taggedPrompt,
} from "./open-claude-design-utils.js";
import {
  assertUserAnnotationsThreaded,
  feedbackArtifactPath,
  hasMeaningfulLiveChanges,
  hasMeaningfulUserNotes,
  loadPreviewFeedback,
  persistPreviewFeedback,
  previewFeedbackSchema,
  toPreviewFeedback,
  userAnnotationsBlock,
  type PreviewFeedback,
} from "./open-claude-design-feedback.js";
import {
  LIVE_REVIEW_GATE_OPTIONS,
  buildLiveReviewGateMessage,
  buildLivePreviewDisplayPrompt,
  isUiUnavailableRejection,
  type LiveReviewGateUi,
} from "./open-claude-design-setup.js";

const GROUNDED_REPORTING =
  "Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.";

type DesignContext = {
  task(name: string, options: object): Promise<WorkflowTaskResult>;
  parallel(steps: readonly object[], options: { readonly task: string }): Promise<WorkflowTaskResult[]>;
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

export async function refineOpenClaudeDesign(options: RefineOptions): Promise<{ readonly latestDesign: string; readonly approvedForExport: boolean; readonly refinementCount: number; }> {
  const { designContext, prompt, outputType, maxRefinements, previewPath, previewFileUrl, artifactDir, browserBootstrapRules, designContextFile, referencesFile, designModelConfig, workflowCwd } = options;
  const importContext = options.importContext ?? "";
  let latestDesign = "";
  let latestGenerateSessionFile: string | undefined;
  let latestUserFeedbackSessionFile: string | undefined;
  /** Captured work waiting for a `generate-*` round to apply it (issue #2401). */
  let pendingFeedback: PreviewFeedback | undefined;
  /** Durable artifact the pending feedback was reloaded from (issue #2401). */
  let pendingFeedbackArtifact: string | undefined;
  let approvedForExport = false;
  let refinementCount = 0;

  /**
   * Run one `generate-*` round, applying whatever revision is pending. The
   * pending revision is cleared once the round that applies it has run, so
   * `pendingFeedback` always names captured work no generate round has seen
   * yet — which is what lets the loop's exit check find a revision the last
   * review round requested. cross-ref: issue #2401.
   */
  const runGenerateRound = async (iteration: number): Promise<void> => {
    const feedback = pendingFeedback;
    const feedbackArtifactFile = pendingFeedbackArtifact;
    const generateStageName = `generate-${iteration}`;
    const generatePrompt = feedback === undefined
      ? buildInitialGeneratePrompt({
          prompt,
          outputType,
          previewPath,
          designContextFile,
          referencesFile,
          importContext,
        })
      : buildGenerateRevisionPrompt({
          prompt,
          outputType,
          previewPath,
          designContextFile,
          referencesFile,
          latestDesign,
          importContext,
          feedback,
          feedbackArtifactFile,
        });
    if (feedback !== undefined) {
      assertUserAnnotationsThreaded(generatePrompt, [feedback], generateStageName);
    }

    // Large research context travels by artifact file (`reads` + explicit
    // read instructions in the prompt), not as an inline `previous` payload,
    // so a single oversized research result cannot become a single oversized
    // prompt message (issue #2121). Only the revision loop threads the small,
    // word-capped prior design summary inline.
    const generated = await designContext.task(generateStageName, {
      prompt: generatePrompt,
      reads:
        feedbackArtifactFile === undefined
          ? [designContextFile, referencesFile]
          : [designContextFile, referencesFile, feedbackArtifactFile],
      ...(feedback === undefined
        ? {}
        : { previous: { name: "current-design", text: latestDesign } }),
      ...designModelConfig,
      ...forkContinuationOptions(latestGenerateSessionFile),
    });
    latestDesign = generated.text;
    latestGenerateSessionFile = generated.sessionFile ?? latestGenerateSessionFile;
    refinementCount = iteration;
    pendingFeedback = undefined;
    pendingFeedbackArtifact = undefined;
  };

  for (let iteration = 1; iteration <= maxRefinements; iteration += 1) {
    await runGenerateRound(iteration);

    // Deterministic live-review gate (issue #2060): the user-feedback stage
    // waits on a browser long-poll that never sets `awaiting_input`, so raise
    // a run-level `ctx.ui` prompt first. It fires the needs-attention badge,
    // names the preview URL, and syncs the review to the user's presence.
    // Only the executor's unavailable-UI rejection (headless / no adapter)
    // degrades to running the review; lifecycle failures such as interruption
    // or a failed durable checkpoint must propagate and stop the workflow.
    const gateChoice = await options.ui
      .select(
        buildLiveReviewGateMessage({ iteration, maxRefinements, previewPath, previewFileUrl }),
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
    // session forks — and that must never be laundered into approval.
    //
    // The stage declares `previewFeedbackSchema`, so the round finalizes as a
    // schema-validated structured answer that a later resume-continuation turn
    // cannot displace (issue #2401).
    const feedbackStageName = `user-feedback-${iteration}`;
    const userFeedbackResult = await designContext.task(feedbackStageName, {
      prompt: buildLivePreviewDisplayPrompt({
        previewPath,
        previewFileUrl,
        browserBootstrapRules,
        iteration,
        maxRefinements,
      }),
      schema: previewFeedbackSchema,
      ...designModelConfig,
      ...forkContinuationOptions(latestUserFeedbackSessionFile),
    });

    latestUserFeedbackSessionFile =
      userFeedbackResult.sessionFile ?? latestUserFeedbackSessionFile;
    persistPreviewFeedback({
      artifactDir,
      workflowCwd,
      feedback: toPreviewFeedback({ iteration, stageName: feedbackStageName, result: userFeedbackResult }),
    });

    // The durable artifact — not the stage's prose — drives the loop, so the
    // round the next generate stage reads is exactly the round on disk.
    const artifactPath = feedbackArtifactPath(artifactDir, iteration);
    const durableFeedback = loadPreviewFeedback({ artifactDir, iteration, stageName: feedbackStageName });

    // Fail closed. An unreadable deliverable and an indeterminate round are
    // both "we do not know what the user asked for", and neither may approve
    // an export that would discard the review (issue #2401).
    if (durableFeedback === undefined || durableFeedback.decision === "indeterminate") {
      const reason = durableFeedback === undefined
        ? "the persisted feedback deliverable could not be read back (missing or malformed)"
        : "the round returned neither a schema-validated structured answer nor parseable feedback labels";
      throw new Error(
        `open-claude-design ${feedbackStageName}: ${reason}. Feedback deliverable: ${artifactPath}. Refusing to approve or export a preview whose review outcome is unknown (see issue #2401).`,
      );
    }
    // Approval may never discard captured work: an artifact that approves
    // while carrying notes or live changes is a contradiction the loader
    // already rejects, so if one ever reaches here it runs another round
    // rather than exporting over the review (issue #2401 items A.3 and B.3).
    const capturedWork = hasMeaningfulUserNotes(durableFeedback) || hasMeaningfulLiveChanges(durableFeedback);
    if (durableFeedback.decision === "approve" && !capturedWork) {
      approvedForExport = true;
      break;
    }
    pendingFeedback = durableFeedback;
    pendingFeedbackArtifact = artifactPath;
  }

  // A revision the final review round asked for still has to be applied. The
  // loop bound caps review rounds, not the work they requested: returning here
  // would export the preview the user just asked to change (issue #2401).
  if (pendingFeedback !== undefined) {
    await runGenerateRound(maxRefinements + 1);
  }

  return { latestDesign, approvedForExport, refinementCount };
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

function buildGenerateRevisionPrompt(args: {
  readonly prompt: string;
  readonly outputType: string;
  readonly previewPath: string;
  readonly designContextFile: string;
  readonly referencesFile: string;
  readonly latestDesign: string;
  readonly importContext: string;
  readonly feedback: PreviewFeedback;
  /** Durable per-round feedback deliverable this brief was rendered from (issue #2401). */
  readonly feedbackArtifactFile?: string;
}): string {
  const annotations = userAnnotationsBlock([args.feedback]);
  return taggedPrompt([
    [
      "design_context_file",
      `Read the file at ${args.designContextFile} for the project design context (PRODUCT.md/DESIGN.md summary) and the ds-* design-system evidence.`,
    ],
    [
      "reference_inspiration_file",
      `Read the file at ${args.referencesFile} for the curated reference inspiration.`,
    ],
    ["reference_context", args.importContext],
    ["reference_precedence", REFERENCE_PRECEDENCE],
    ["preview_artifact_path", args.previewPath],
    ...(args.feedbackArtifactFile === undefined
      ? []
      : ([
          [
            "user_feedback_record",
            `Read the file at ${args.feedbackArtifactFile}. It is the authoritative record of this review round — the durable deliverable the feedback stage returned — and <user_feedback> below is rendered from it. Where the two ever disagree, the file wins.`,
          ],
        ] as const)),
    ["user_feedback", annotations.text],
    ["current_design_summary", args.latestDesign],
    ["html_rules", HTML_PREVIEW_RULES],
    ["anti_design_slop_rules", ANTI_SLOP_RULES],
    ["role", "You are an opinionated staff design engineer."],
    [
      "objective",
      `Revise the ${args.outputType} for: ${args.prompt}. Update the preview in place from only the latest live-review feedback, applying impeccable \`craft\` and \`polish\` with restraint rather than adding an internal critique.`,
    ],
    [
      "instructions",
      [
        "Read the current HTML at preview_artifact_path. Treat <user_feedback> and the user_feedback_record file as the only refinement brief; do not invent critique, screenshot, audit, or gate findings.",
        "Address every user note and accepted live change visibly, or identify its DESIGN.md/reference-precedence conflict in the summary.",
        `Overwrite ${args.previewPath} with one revised self-contained HTML file; do not branch or create extra previews.`,
        "Preserve strong decisions unless feedback requires change; add no unrelated features or abstractions.",
      ].join("\n"),
    ],
    [
      "output_format",
      [
        "In at most 400 words, return Markdown, not the HTML body:",
        "1. Revised artifact (path only)",
        "2. User feedback addressed (each note/live change and its application or conflict)",
        "3. Changes applied",
        "4. Trade-offs / unresolved user feedback",
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
