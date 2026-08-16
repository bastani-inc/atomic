import type { WorkflowTaskResult } from "../src/shared/types.js";
import {
  ANTI_SLOP_RULES,
  HTML_PREVIEW_RULES,
  REFERENCE_PRECEDENCE,
  taggedPrompt,
} from "./open-claude-design-utils.js";
import {
  buildLiveEventPrompt,
  buildLiveSessionStartPrompt,
  needsModel,
  pollLiveEvent,
  replyLiveEvent,
  replyTokenFor,
} from "./open-claude-design-live-protocol.js";
import {
  LIVE_REVIEW_GATE_OPTIONS,
  buildLiveReviewGateMessage,
  isUiUnavailableRejection,
  type LiveReviewGateUi,
} from "./open-claude-design-setup.js";

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
  readonly previewPath: string;
  readonly previewFileUrl: string;
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

/**
 * Generate a design, then review it in one live session.
 *
 * The live session is itself unbounded: the user picks elements, accepts
 * on-brand variants written into `preview.html` in place, and steers, until
 * they leave. The preview is exported as it stands when the session ends.
 */
export async function refineOpenClaudeDesign(options: RefineOptions): Promise<{ readonly latestDesign: string }> {
  const { designContext, prompt, outputType, previewPath, previewFileUrl, browserBootstrapRules, designContextFile, referencesFile, designModelConfig, workflowCwd } = options;
  const importContext = options.importContext ?? "";

  // Large research context travels by artifact file (`reads` + explicit read
  // instructions in the prompt), not as an inline payload (issue #2121).
  const generated = await designContext.task("generate-1", {
    prompt: buildInitialGeneratePrompt({
      prompt,
      outputType,
      previewPath,
      designContextFile,
      referencesFile,
      importContext,
    }),
    reads: [designContextFile, referencesFile],
    ...designModelConfig,
  });

  // The browser review waits on a long-poll rather than an awaiting-input
  // stage, so raise the run-level prompt before opening the session. Only the
  // executor's unavailable-UI rejection degrades to running the review;
  // lifecycle failures must propagate and stop the workflow.
  const gateChoice = await options.ui
    .select(
      buildLiveReviewGateMessage({ round: 1, previewPath, previewFileUrl }),
      LIVE_REVIEW_GATE_OPTIONS,
    )
    .catch((error: unknown) => {
      if (isUiUnavailableRejection(error)) return LIVE_REVIEW_GATE_OPTIONS[0];
      throw error;
    });
  if (gateChoice === LIVE_REVIEW_GATE_OPTIONS[0]) {
    await runLiveReviewSession({
      designContext,
      round: 1,
      reviewStageName: "user-feedback-1",
      previewPath,
      previewFileUrl,
      browserBootstrapRules,
      designModelConfig,
      workflowCwd,
    });
  }

  return { latestDesign: generated.text };
}

type LiveReviewSessionOptions = {
  readonly designContext: DesignContext;
  readonly round: number;
  readonly reviewStageName: string;
  readonly previewPath: string;
  readonly previewFileUrl: string;
  readonly browserBootstrapRules: string;
  readonly designModelConfig: ModelConfig;
  readonly workflowCwd: string;
};

/**
 * Run one live review session until the helper emits its terminal `exit` event.
 *
 * The workflow owns the poll loop: `ctx.tool` polls and replies, and the model
 * is called back only for the events that need it. Termination is the helper's
 * `exit` event rather than a model's judgment that a review looked finished,
 * which is what prevents a poll timeout from ending an active review.
 */
async function runLiveReviewSession(options: LiveReviewSessionOptions): Promise<void> {
  const { designContext, round, reviewStageName, previewPath, previewFileUrl, browserBootstrapRules, designModelConfig, workflowCwd } = options;
  let sessionFile: string | undefined;

  const start = await designContext.task(`${reviewStageName}-start`, {
    prompt: buildLiveSessionStartPrompt({ previewPath, previewFileUrl, browserBootstrapRules, round }),
    ...designModelConfig,
  });
  sessionFile = start.sessionFile;

  for (let index = 1; ; index += 1) {
		// `timeout` is absorbed inside the poll, so an idle hour costs no nodes and
		// never looks like an ending.
		const event = await designContext.tool(`live-poll-${round}-${index}`, { round, index }, async ({ signal }) =>
			pollLiveEvent({ workflowCwd, signal }),
		);
		if (event.type === "exit") break;
		// `variant_mounted` is journal-only. All other non-model events are
		// acknowledged by the helper itself and do not mint a model stage.
		if (!needsModel(event)) continue;
		if (event.id === undefined || event.id.length === 0) {
			throw new Error(`Live ${event.type} event is missing its id`);
		}
		const response = await designContext.task(`live-${event.type}-${round}-${index}`, {
			prompt: buildLiveEventPrompt({ event, previewPath }),
			...designModelConfig,
			...forkContinuationOptions(sessionFile),
		});
		sessionFile = response.sessionFile ?? sessionFile;
		const status = replyTokenFor(event);
		await designContext.tool(
			`live-reply-${round}-${index}`,
			{ round, index, eventId: event.id, status },
			async ({ signal }) => replyLiveEvent({ workflowCwd, event, status, signal }),
		);
  }
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
        `Read the file at ${referencesFile} for the curated reference research that informed the final design; use it wherever the spec cites visual direction or reference provenance.`,
      ],
      ["preview_artifact_path", previewPath],
      ["spec_artifact_path", specPath],
      ["final_design_summary", "{previous}"],
      ["html_rules", HTML_PREVIEW_RULES],
      ["anti_design_slop_rules", ANTI_SLOP_RULES],
      ["role", "You are an opinionated staff design engineer."],
      [
        "objective",
        `Export the final ${outputType} for "${prompt}" as a rich browser-readable HTML spec. Apply impeccable \`document\` and embed or link the final preview so implementation reviewers see the design as exported.`,
      ],
      [
        "instructions",
        [
          "First read the design-context file named above, then read preview_artifact_path as the canonical final design, and use the Write tool to create one self-contained HTML5 file at spec_artifact_path.",
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
            "Do not run `show --annotate` or invite changes because the review session has ended.",
            `Prominently print the manual paths:\n- Final spec: ${specPath}\n- Preview: ${previewPath}`,
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
