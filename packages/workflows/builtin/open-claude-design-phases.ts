import { join } from "node:path";
import type { WorkflowTaskResult } from "../src/shared/types.js";
import {
  ANTI_SLOP_RULES,
  HTML_PREVIEW_RULES,
  exportGateDecisionFromResult,
  refinementDecisionFromResult,
  taggedPrompt,
} from "./open-claude-design-utils.js";

type DesignContext = {
  task(name: string, options: object): Promise<WorkflowTaskResult>;
  parallel(steps: readonly object[], options: { readonly task: string }): Promise<WorkflowTaskResult[]>;
};

type ModelConfig = Record<string, object | string | readonly string[]>;

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
  readonly latestDesign: string;
  readonly designModelConfig: ModelConfig;
  readonly refinementDecisionConfig: ModelConfig;
};

export async function refineOpenClaudeDesign(options: RefineOptions): Promise<{ readonly latestDesign: string; readonly approvedForExport: boolean; readonly refinementCount: number; }> {
  const { designContext, prompt, outputType, maxRefinements, previewPath, previewFileUrl, artifactDir, browserBootstrapRules, designSystem, designModelConfig, refinementDecisionConfig } = options;
  let latestDesign = options.latestDesign;
  let approvedForExport = false;
  let refinementCount = 0;
  for (let iteration = 1; iteration <= maxRefinements; iteration += 1) {
    refinementCount = iteration;

    const feedback = await designContext.task(`user-feedback-${iteration}`, {
      prompt: taggedPrompt([
        [
        "role",
        "You are a staff product manager with deep design and engineering empathy collecting actionable refinement feedback from the user about the rendered HTML preview. You call out bs because the user is your partner, not your boss; you want to get to a great design together, and that means being honest about what you don't like and what the user won't like. You are user-experience-obsessed.",
        ],
        [
        "objective",
        `Decide whether refinement is needed for iteration ${iteration}/${maxRefinements} of: ${prompt}. Apply the impeccable \`critique\` sub-skill to decide whether the artifact is ready. Score Nielsen's 10 heuristics 0–4, cognitive-load count 0–8, persona-based passes, cross-check the 25 anti-pattern detector. Produce a prioritized list, not free-form prose.`,
        ],
        ["preview_path", previewPath],
        ["preview_file_url", previewFileUrl],
        ["current_design_summary", "{previous}"],
        [
        "instructions",
        [
          "1. If a previous `preview-display-*` step captured annotated user feedback or notes, honor them as the primary signal.",
          "2. Otherwise, you may inspect the HTML file at preview_path directly (read it from disk) and run an impeccable `critique` against it.",
          "3. Decide whether the current design is ready for export.",
          "4. If refinement is still needed, put specific changes in required_changes ordered by user value and implementation risk.",
          "5. Never request changes that contradict DESIGN.md unless you explicitly identify and explain the conflict.",
        ].join("\n"),
        ],
        [
        "output_format",
        [
          "Set ready_for_export=true only when the current preview needs no further refinement before export.",
          "Set ready_for_export=false and populate required_changes when another polish iteration is needed.",
        ].join("\n"),
        ],
      ]),
      previous: { name: "current-design", text: latestDesign },
      ...refinementDecisionConfig,
    });

    const feedbackDecision = refinementDecisionFromResult(feedback);
    if (feedbackDecision.ready_for_export) {
      approvedForExport = true;
      break;
    }

    const validation = await designContext.parallel(
      [
        {
        name: `critique-${iteration}`,
        task: taggedPrompt([
          [
            "role",
            "You are a staff product manager with deep design and engineering empathy collecting actionable refinement feedback from the user about the rendered HTML preview. You call out bs because the user is your partner, not your boss; you want to get to a great design together, and that means being honest about what you don't like and what the user won't like. You are user-experience-obsessed.",
          ],
          [
            "objective",
            `Critique the current ${outputType} for: ${prompt}. Produce the formal impeccable critique report. Apply the impeccable \`critique\` sub-skill to run the formal two-pass review against the live HTML preview.`,
          ],
          ["preview_path", previewPath],
          ["current_design_and_feedback", "{previous}"],
          [
            "instructions",
            [
            "1. Read the HTML at preview_path and ground every finding in concrete element/selector references.",
            "2. Return concrete fixes only; avoid generic praise or non-actionable subjective notes.",
            "3. Call out every DESIGN.md conflict and every missing state explicitly.",
            ].join("\n"),
          ],
          [
            "output_format",
            [
            "Markdown with sections in this order:",
            "1. AI-slop verdict (PASS or FAIL with the specific tells)",
            "2. Heuristic scores (table: heuristic | 0–4)",
            "3. Cognitive load failure count (0–8) with named failures",
            "4. Issues table: Issue | Evidence (selector/line) | Impact | Recommended fix | Severity P0–P3",
            "5. Questions worth answering before shipping",
            ].join("\n"),
          ],
        ]),
        previous: [
          { name: "current-design", text: latestDesign },
          feedback,
        ],
        ...designModelConfig,
        },
        {
        name: `screenshot-${iteration}`,
        task: taggedPrompt([
          [
            "role",
            "You are a staff QA engineer with design expertise.",
          ],
          [
            "objective",
            `Validate visual implementation risks for: ${prompt}. Apply the impeccable \`audit + live\` sub-skills to run a live audit against the rendered HTML preview, validating or invalidating every visual risk with evidence from the actual rendered page in a real browser, not just the source code.`,
          ],
          ["preview_path", previewPath],
          ["preview_file_url", previewFileUrl],
          ["current_design_and_feedback", "{previous}"],
          [
            "browser_use_guidelines",
            browserBootstrapRules,
          ],
          [
            "instructions",
            [
            `1. Attempt rendering verification via the playwright-cli skill: \`playwright-cli open ${previewFileUrl}\`. If that reports a missing browser executable, follow the bootstrap rules and retry once.`,
            `2. Then run \`playwright-cli resize 360 800\`, \`playwright-cli screenshot --filename=${join(artifactDir, `mobile-${iteration}.png`)}\`, \`playwright-cli resize 1440 900\`, \`playwright-cli screenshot --filename=${join(artifactDir, `desktop-${iteration}.png`)}\`.`,
            "3. Check: contrast (WCAG AA), overflow, spacing rhythm, alignment, breakpoint behavior, empty/loading/error states, keyboard/pointer affordances, focus rings, prefers-reduced-motion.",
            "4. If `playwright-cli` is unavailable or browser bootstrap fails, perform a static design review of the HTML source and mark every finding as `needs-rendering-verification`.",
            "5. Distinguish confirmed visual issues from risks that need rendering verification. Never fabricate rendered evidence.",
            ].join("\n"),
          ],
          [
            "output_format",
            "Markdown sections: Tooling used | Confirmed issues (with screenshot refs) | Needs rendering verification | Suggested fixes | Audit scores (0–4 per impeccable audit dimension).",
          ],
        ]),
        previous: [
          { name: "current-design", text: latestDesign },
          feedback,
        ],
        ...designModelConfig,
        },
      ],
      { task: prompt },
    );

    const applied = await designContext.task(`apply-changes-${iteration}`, {
      prompt: taggedPrompt([
        [
        "role",
        "You are an opinionated staff design engineer.",
        ],
        [
        "objective",
        `Produce the next ${outputType} revision for: ${prompt}. Update the HTML file in place; do not branch the artifact. Apply the impeccable \`polish\` sub-skill to methodically apply the required changes, addressing every critique finding and screenshot-validated issue with surgical precision. This is not a redesign; it's a focused polish iteration to get from the current design to an export-ready state in one step.`,
        ],
        ["design_system", designSystem],
        ["preview_artifact_path", previewPath],
        ["revision_context", "{previous}"],
        [
        "instructions",
        [
          "1. Read the current HTML at preview_artifact_path with your file-read tool.",
          `2. Apply user feedback, critique findings, screenshot/visual QA findings, and DESIGN.md constraints together. Overwrite ${previewPath} with the revised HTML (full file rewrite, not patches — the artifact must always be self-contained).`,
          "3. Preserve strong existing design decisions unless a finding requires change.",
          "4. Resolve conflicting feedback explicitly; choose the safest DESIGN.md-aligned option and note the trade-off.",
          "5. Update states, accessibility, responsiveness, and HTML implementation comments when changes affect them.",
          "6. After writing, return a short markdown summary listing the changes, trade-offs, and remaining questions — do NOT paste the HTML body.",
        ].join("\n"),
        ],
        [
        "output_format",
        [
          "Markdown with headings:",
          "1. Revised artifact (path only)",
          "2. Changes applied (bullet list, each tied to a critique or screenshot finding)",
          "3. Trade-offs / conflicts resolved",
          "4. Remaining questions",
        ].join("\n"),
        ],
      ]),
      previous: [
        { name: "current-design", text: latestDesign },
        feedback,
        ...validation,
      ],
      ...designModelConfig,
    });
    latestDesign = applied.text;

    // Re-display the freshly revised preview so the user can keep iterating.
    await designContext
      .task(`preview-display-${iteration}`, {
        prompt: taggedPrompt([
        [
          "role",
          "You are a staff product manager with expertise in design. Re-open the revised HTML preview so the user can review the latest iteration.",
        ],
        [
          "objective",
          `Show the user the revised preview after iteration ${iteration}/${maxRefinements} and capture any new annotated feedback for the next loop.`,
        ],
        ["preview_path", previewPath],
        ["preview_file_url", previewFileUrl],
        [
          "browser_use_bootstrap",
          browserBootstrapRules,
        ],
        [
          "instructions",
          [
            `1. If \`playwright-cli\` is available, run \`playwright-cli open ${previewFileUrl}\`. If that reports a missing browser executable, follow the bootstrap rules and retry once.`,
            "2. Then run `playwright-cli snapshot` and, for interactive review, `playwright-cli show --annotate`; otherwise ask the user to provide feedback inline.",
            `3. If \`playwright-cli\` is unavailable or browser bootstrap fails, surface the path clearly: ${previewPath} (URL: ${previewFileUrl}).`,
            "4. Return any captured annotations as structured notes the next user-feedback step can read.",
            "5. Do not block on unavailable tooling.",
          ].join("\n"),
        ],
        [
          "output_format",
          "Markdown with: `display_method`, `preview_path`, `annotated_snapshot` (if any), `user_notes` (if any), `next_action_hint`.",
        ],
        ]),
        ...designModelConfig,
      })
      .catch(() => undefined);
    }


  return { latestDesign, approvedForExport, refinementCount };
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
  readonly exportGateDecisionConfig: ModelConfig;
};

export async function exportOpenClaudeDesign(options: ExportOptions): Promise<{ readonly latestDesign: string; readonly handoff: WorkflowTaskResult; }> {
  const { designContext, prompt, outputType, previewPath, previewFileUrl, specPath, specFileUrl, browserBootstrapRules, designSystem, designModelConfig, exportGateDecisionConfig } = options;
  let latestDesign = options.latestDesign;
  const preExport = await designContext.task("pre-export-scan", {
      prompt: taggedPrompt([
        [
          "role",
          "You are a staff product manager with deep design and engineering empathy collecting actionable refinement feedback from the user about the rendered HTML preview. You call out bs because the user is your partner, not your boss; you want to get to a great design together, and that means being honest about what you don't like and what the user won't like. You are user-experience-obsessed.",
        ],
        [
          "objective",
          `Final quality gate for this ${outputType}: ${prompt}. Decide whether the HTML preview at preview_path is safe to export. Apply the impeccable \`audit\` sub-skill one final time to block export only for concrete, evidence-backed issues.`,
        ],
        ["preview_path", previewPath],
        ["final_design_summary", "{previous}"],
        [
          "instructions",
          [
            "1. Read the HTML at preview_path and score it across all five audit dimensions.",
            "2. Scan for banned anti-patterns, accessibility blockers, severe visual regressions, missing critical states, and handoff gaps.",
            "3. Only mark findings as blocking when they would materially harm implementation or user experience (impeccable P0 severity).",
            "4. Decide whether export is blocked.",
            "5. Every blocking finding must include selector-level evidence and a must-fix action.",
          ].join("\n"),
        ],
        [
          "decision_rules",
          [
            "Set has_blocking_findings=true only when one or more P0 findings block export.",
            "Populate blocking_findings with every blocking P0 issue; leave it empty when export is safe.",
          ].join("\n"),
        ],
      ]),
      previous: { name: "final-design", text: latestDesign },
      ...exportGateDecisionConfig,
    });

    const exportGateDecision = exportGateDecisionFromResult(preExport);
  if (exportGateDecision.has_blocking_findings) {
      const forcedFix = await designContext.task("forced-fix", {
        prompt: taggedPrompt([
          [
            "role",
            "You are an opinionated staff design engineer. Apply the impeccable `harden` sub-skill to remove blocking findings without redesigning.",
          ],
          [
            "objective",
            `Remove the blocking findings from the HTML preview without broad redesign. Output: ${prompt}.`,
          ],
          [
            "impeccable_skill",
            "harden — make the artifact production-ready against real-world data extremes, error scenarios, internationalization, and device/context variability. Fix only what is broken; do not redesign.",
          ],
          ["blocking_findings", preExport.text],
          ["design_system", designSystem],
          ["preview_artifact_path", previewPath],
          ["current_final_design_summary", "{previous}"],
          [
            "instructions",
            [
              "1. Read the HTML at preview_artifact_path and apply only the fixes needed to clear the blocking findings.",
              `2. Overwrite ${previewPath} with the corrected HTML (full file rewrite, still self-contained).`,
              "3. Preserve DESIGN.md alignment and previously approved decisions.",
              "4. Explain each forced change and how it resolves a specific blocking finding.",
              "5. If a blocker cannot be resolved with available context, state the remaining risk plainly and propose a follow-up.",
            ].join("\n"),
          ],
          [
            "output_format",
            "Markdown with sections: Corrected final design (path) | Forced fixes applied (table: finding → fix) | Remaining risk.",
          ],
        ]),
        previous: { name: "final-design", text: latestDesign },
        ...designModelConfig,
      });
      latestDesign = forcedFix.text;
    }

  const handoff = await designContext.task("exporter", {
      prompt: taggedPrompt([
        [
          "role",
          "You are an opinionated staff design engineer.",
        ],
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

    // Final display attempt: open the spec.html for the user (or surface its path).
    await designContext
      .task("final-display", {
        prompt: taggedPrompt([
          [
            "role",
            "You are an opinionated staff design engineer.",
          ],
          [
            "objective",
            "Make the rich HTML spec visible to the user. Open the final spec.html with the playwright-cli skill's `playwright-cli` command so the user can review the agreed design and implementation handoff. Degrade gracefully if browser automation is unavailable.",
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
              `2. If available, run \`playwright-cli open ${specFileUrl}\`. If that reports a missing browser executable, follow the bootstrap rules and retry once.`,
              "3. Then run `playwright-cli snapshot` and, for interactive review, `playwright-cli show --annotate` so the user can capture any final notes.",
              `4. Always print, prominently, the absolute paths so the user can open them manually:\n   - Final spec: ${specPath}\n   - Approved preview: ${previewPath}`,
              "5. Do not block the workflow; return a structured summary even if no tooling worked.",
            ].join("\n"),
          ],
          [
            "output_format",
            "Markdown with: `display_method` | `spec_path` | `preview_path` | `annotated_snapshot` (if any) | `user_notes` (if any) | `manual_open_instructions`.",
          ],
        ]),
        ...designModelConfig,
      })
      .catch(() => undefined);


  return { latestDesign, handoff };
}
