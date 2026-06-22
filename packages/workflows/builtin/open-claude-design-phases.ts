import type { WorkflowTaskResult } from "../src/shared/types.js";
import {
  ANTI_SLOP_RULES,
  HTML_PREVIEW_RULES,
  REFERENCE_PRECEDENCE,
  taggedPrompt,
} from "./open-claude-design-utils.js";
import {
  assertUserAnnotationsThreaded,
  hasMeaningfulFeedback,
  persistPreviewFeedback,
  toPreviewFeedback,
  userAnnotationsBlock,
  type PreviewFeedback,
} from "./open-claude-design-feedback.js";
import { buildLivePreviewDisplayPrompt } from "./open-claude-design-setup.js";

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
  readonly designSystem: string;
  readonly generationContext: readonly WorkflowTaskResult[];
  readonly designModelConfig: ModelConfig;
  readonly workflowCwd: string;
  readonly referencesBrief?: string;
  readonly importContext?: string;
};

export async function refineOpenClaudeDesign(options: RefineOptions): Promise<{ readonly latestDesign: string; readonly approvedForExport: boolean; readonly refinementCount: number; }> {
  const { designContext, prompt, outputType, maxRefinements, previewPath, previewFileUrl, artifactDir, browserBootstrapRules, designSystem, designModelConfig, workflowCwd } = options;
  const referencesBrief = options.referencesBrief ?? "";
  const importContext = options.importContext ?? "";
  let latestDesign = "";
  let latestGenerateSessionFile: string | undefined;
  let latestUserFeedbackSessionFile: string | undefined;
  let pendingFeedback: PreviewFeedback | undefined;
  let approvedForExport = false;
  let refinementCount = 0;

  for (let iteration = 1; iteration <= maxRefinements; iteration += 1) {
    const generateStageName = `generate-${iteration}`;
    const generatePrompt = pendingFeedback === undefined
      ? buildInitialGeneratePrompt({
          prompt,
          outputType,
          previewPath,
          designSystem,
          referencesBrief,
          importContext,
        })
      : buildGenerateRevisionPrompt({
          prompt,
          outputType,
          previewPath,
          designSystem,
          latestDesign,
          referencesBrief,
          importContext,
          feedback: pendingFeedback,
        });
    if (pendingFeedback !== undefined) {
      assertUserAnnotationsThreaded(generatePrompt, [pendingFeedback], generateStageName);
    }

    const generated = await designContext.task(generateStageName, {
      prompt: generatePrompt,
      previous: pendingFeedback === undefined
        ? options.generationContext
        : { name: "current-design", text: latestDesign },
      ...designModelConfig,
      ...forkContinuationOptions(latestGenerateSessionFile),
    });
    latestDesign = generated.text;
    latestGenerateSessionFile = generated.sessionFile ?? latestGenerateSessionFile;
    refinementCount = iteration;

    const userFeedbackResult = await designContext
      .task(`user-feedback-${iteration}`, {
        prompt: buildLivePreviewDisplayPrompt({
          previewPath,
          previewFileUrl,
          browserBootstrapRules,
          iteration,
          maxRefinements,
        }),
        ...designModelConfig,
        ...forkContinuationOptions(
          latestUserFeedbackSessionFile ?? latestGenerateSessionFile,
        ),
      })
      .catch(() => undefined);

    latestUserFeedbackSessionFile =
      userFeedbackResult?.sessionFile ?? latestUserFeedbackSessionFile;
    const feedback = toPreviewFeedback({
      iteration,
      stageName: `user-feedback-${iteration}`,
      result: userFeedbackResult,
    });
    persistPreviewFeedback({ artifactDir, workflowCwd, feedback });

    if (!hasMeaningfulFeedback(feedback)) {
      approvedForExport = true;
      break;
    }
    pendingFeedback = feedback;
  }

  return { latestDesign, approvedForExport, refinementCount };
}

function buildInitialGeneratePrompt(args: {
  readonly prompt: string;
  readonly outputType: string;
  readonly previewPath: string;
  readonly designSystem: string;
  readonly referencesBrief: string;
  readonly importContext: string;
}): string {
  return taggedPrompt([
    ["role", "You are an opinionated staff design engineer."],
    [
      "objective",
      `Generate the first revision of a production-ready ${args.outputType} for: ${args.prompt}. Write it to disk as an interactive HTML preview the user can open in a browser. Apply the impeccable \`craft\` sub-skill to build the design with deliberate ordering and impeccable attention to detail. Every design decision must trace back to the brief, and every visual trait must be justified by the references, design system, or reference context.`,
    ],
    ["design_brief", args.prompt],
    ["design_system", args.designSystem],
    ["reference_context", args.importContext],
    ["reference_inspiration", args.referencesBrief],
    ["reference_precedence", REFERENCE_PRECEDENCE],
    ["preview_artifact_path", args.previewPath],
    ["html_rules", HTML_PREVIEW_RULES],
    ["anti_design_slop_rules", ANTI_SLOP_RULES],
    [
      "instructions",
      [
        `1. Create the HTML artifact at exactly this path: ${args.previewPath}.`,
        "2. Follow the `<reference_precedence>` rule: user-provided references in `<reference_context>` win over DESIGN.md/PRODUCT.md where they conflict; DESIGN.md fills gaps the references do not cover.",
        "3. Heavily reference the `<reference_inspiration>` block while staying consistent with the imported user references; never copy a reference wholesale or invent traits it does not contain.",
        `4. Build the artifact as the requested output_type (${args.outputType}). For prototypes/pages, render full layouts with realistic content. For components, render the component in 3+ representative contexts.`,
        "5. Include structure, states, accessibility behavior, responsive behavior, and integration notes — but keep them in HTML comments inside the file so the rendered preview stays clean.",
        "6. Do not use generic placeholder language when project conventions are available.",
        "7. After writing the file, return a short markdown summary (NOT the HTML body) describing what you built, decisions made, and assumptions left for the user to confirm.",
      ].join("\n"),
    ],
    [
      "output_format",
      [
        "Return markdown with the headings below. DO NOT paste the HTML; the file at preview_artifact_path is the artifact.",
        "1. Artifact overview",
        "2. Files written (must include the absolute path to preview.html)",
        "3. UI structure and states (referenced by HTML section IDs)",
        "4. Accessibility and responsive behavior",
        "5. Implementation notes",
        "6. Assumptions / open questions",
      ].join("\n"),
    ],
  ]);
}

function buildGenerateRevisionPrompt(args: {
  readonly prompt: string;
  readonly outputType: string;
  readonly previewPath: string;
  readonly designSystem: string;
  readonly latestDesign: string;
  readonly referencesBrief: string;
  readonly importContext: string;
  readonly feedback: PreviewFeedback;
}): string {
  const annotations = userAnnotationsBlock([args.feedback]);
  return taggedPrompt([
    ["role", "You are an opinionated staff design engineer."],
    [
      "objective",
      `Generate the next ${args.outputType} revision for: ${args.prompt}. Update the HTML preview in place using only the user's captured feedback from the latest live review. Apply the impeccable \`craft\` and \`polish\` sub-skills with deliberate restraint: this is a focused revision, not an internal critique pass.`,
    ],
    ["design_system", args.designSystem],
    ["reference_inspiration", args.referencesBrief],
    ["reference_context", args.importContext],
    ["reference_precedence", REFERENCE_PRECEDENCE],
    ["preview_artifact_path", args.previewPath],
    ["user_feedback", annotations.text],
    ["current_design_summary", args.latestDesign],
    ["html_rules", HTML_PREVIEW_RULES],
    ["anti_design_slop_rules", ANTI_SLOP_RULES],
    [
      "instructions",
      [
        "1. Read the current HTML at preview_artifact_path with your file-read tool.",
        "2. Treat `<user_feedback>` as the only refinement brief. Do not invent separate critique, screenshot, audit, or gate findings.",
        "3. Every user note or accepted live change MUST be visibly addressed in the revised preview, or explicitly explained as a conflict with DESIGN.md/reference precedence in your summary.",
        `4. Overwrite ${args.previewPath} with the revised self-contained HTML file. Do not branch the artifact and do not create extra preview files.`,
        "5. Preserve strong existing design decisions unless the user feedback requires a change.",
        "6. After writing, return a concise markdown summary of what changed and any user feedback you could not apply. Do NOT paste the HTML body.",
      ].join("\n"),
    ],
    [
      "output_format",
      [
        "Markdown with headings:",
        "1. Revised artifact (path only)",
        "2. User feedback addressed (each note/live change → how it was applied, or why it was deferred/conflicts)",
        "3. Changes applied",
        "4. Trade-offs / unresolved user feedback",
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
  readonly designSystem: string;
  readonly latestDesign: string;
  readonly designModelConfig: ModelConfig;
};

export async function exportOpenClaudeDesign(options: ExportOptions): Promise<{ readonly latestDesign: string; readonly handoff: WorkflowTaskResult; }> {
  const { designContext, prompt, outputType, previewPath, previewFileUrl, specPath, specFileUrl, browserBootstrapRules, designSystem, designModelConfig } = options;
  const latestDesign = options.latestDesign;

  const handoff = await designContext.task("exporter", {
    prompt: taggedPrompt([
      ["role", "You are an opinionated staff design engineer."],
      [
        "objective",
        `Export the final ${outputType} for "${prompt}" as a rich HTML spec the engineering team can read directly in a browser. The spec must embed or link the approved preview so reviewers see exactly what is being implemented. Apply the impeccable \`document\` sub-skill to produce a rich HTML spec that bundles the approved preview together with implementation guidance for another design/frontend engineer to implement.`,
      ],
      ["design_system", designSystem],
      ["preview_artifact_path", previewPath],
      ["spec_artifact_path", specPath],
      ["final_design_summary", "{previous}"],
      [
        "instructions",
        [
          `1. Read the approved HTML at preview_artifact_path. Use it as the canonical source of truth for the agreed design.`,
          `2. Use the Write tool to create a rich HTML document at exactly: ${specPath}. The spec must be a single self-contained HTML5 file.`,
          "3. The spec MUST contain, in order: (a) a sticky header with the design title + status + run id, (b) an Executive Summary section, (c) a 'Live Preview' section that EMBEDS the approved design via either an `<iframe srcdoc=\"...\">` containing the full preview HTML or a side-by-side rendered copy of the preview inside an `<article class=\"preview-frame\">` container, (d) the six DESIGN.md sections (Overview, Colors, Typography, Elevation, Components, Do's and Don'ts) rendered with swatches/tables/code blocks, (e) Implementation handoff (Recommended files + components | Implementation steps | Usage example | Accessibility & responsive checklist | Validation commands | Known limitations), (f) Appendix linking to the raw preview file path.",
          "4. Style the spec itself with care: high-density legible typography, generous whitespace, code blocks with monospaced font, swatches that render with the actual hex/oklch values, copy-to-clipboard hints in HTML comments.",
          `5. Embed the absolute preview path (${previewPath}) and file URL (${previewFileUrl}) prominently so the user can open the live preview separately.`,
          "6. Preserve assumptions and known limitations so implementers do not treat uncertain items as facts.",
          "7. Do not introduce design requirements that were absent from the final design or DESIGN.md.",
          "8. After writing, return a concise markdown summary of what is in the spec (NOT the HTML).",
        ].join("\n"),
      ],
      ["html_rules", HTML_PREVIEW_RULES],
      ["anti_design_slop_rules", ANTI_SLOP_RULES],
      [
        "output_format",
        [
          "Return markdown with headings (NOT the HTML):",
          "1. Spec written to (absolute path)",
          "2. Sections included",
          "3. How to open the spec (playwright-cli command + manual fallback path)",
          "4. Recommended files and components",
          "5. Implementation steps",
          "6. Usage example",
          "7. Accessibility / responsive checklist",
          "8. Validation commands",
          "9. Known limitations",
        ].join("\n"),
      ],
    ]),
    previous: { name: "final-design", text: latestDesign },
    ...designModelConfig,
  });

  await designContext
    .task("final-display", {
      prompt: taggedPrompt([
        ["role", "You are an opinionated staff design engineer."],
        [
          "objective",
          "Make the rich HTML spec visible to the user. Open the final spec.html with the playwright-cli skill's `playwright-cli` command so the user can review the agreed design and implementation handoff. This is post-export — do NOT solicit change requests; if the user wants more changes, tell them to re-run the workflow. Degrade gracefully if browser automation is unavailable.",
        ],
        ["spec_path", specPath],
        ["spec_file_url", specFileUrl],
        ["preview_path", previewPath],
        ["preview_file_url", previewFileUrl],
        ["browser_use_guidelines", browserBootstrapRules],
        [
          "instructions",
          [
            "1. Probe for `playwright-cli` availability using the bootstrap rules above.",
            `2. If available, run \`playwright-cli open ${specFileUrl}\`. If that reports a missing browser executable, follow the bootstrap rules and retry once, then \`playwright-cli snapshot\`.`,
            "3. Do NOT run `show --annotate` or otherwise invite change requests: export is done and there is no further refinement pass. If the user wants changes, tell them to re-run `/workflow open-claude-design`.",
            `4. Always print, prominently, the absolute paths so the user can open them manually:\n   - Final spec: ${specPath}\n   - Approved preview: ${previewPath}`,
            "5. Do not block the workflow; return a structured summary even if no tooling worked.",
          ].join("\n"),
        ],
        [
          "output_format",
          "Markdown with: `display_method` | `spec_path` | `preview_path` | `manual_open_instructions` | `next_action_hint` (how to re-run the workflow for further changes).",
        ],
      ]),
      ...designModelConfig,
    })
    .catch(() => undefined);

  return { latestDesign, handoff };
}
