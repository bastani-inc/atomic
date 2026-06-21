import type { WorkflowParallelOptions, WorkflowTaskOptions, WorkflowTaskResult, WorkflowTaskStep } from "../src/shared/types.js";
import {
  ANTI_SLOP_RULES,
  DEFAULT_MAX_REFINEMENTS,
  HTML_PREVIEW_RULES,
  READ_ONLY_TOOLS,
  buildPlaywrightCliBootstrapRules,
  exportGateDecisionSchema,
  isFileLike,
  isUrl,
  joinResults,
  normalizeOutputType,
  positiveInteger,
  prepareArtifactDir,
  refinementDecisionSchema,
  taggedPrompt,
  ensurePlaywrightCli,
} from "./open-claude-design-utils.js";
import { exportOpenClaudeDesign, refineOpenClaudeDesign } from "./open-claude-design-phases.js";

type OpenClaudeDesignOutputs = {
  readonly output_type?: string; readonly design_system?: string; readonly artifact?: string; readonly handoff?: string;
  readonly approved_for_export?: boolean; readonly refinements_completed?: number; readonly import_context?: string; readonly run_id?: string;
  readonly artifact_dir?: string; readonly preview_path?: string; readonly preview_file_url?: string; readonly spec_path?: string; readonly spec_file_url?: string;
  readonly playwright_cli_status?: string;
};

type OpenClaudeDesignContext = {
  readonly cwd?: string;
  readonly inputs: { readonly prompt: string; readonly reference?: string; readonly output_type?: string; readonly design_system?: string; readonly max_refinements?: number };
  task(name: string, options: WorkflowTaskOptions): Promise<WorkflowTaskResult>;
  parallel(steps: readonly WorkflowTaskStep[], options: WorkflowParallelOptions): Promise<WorkflowTaskResult[]>;
};

export async function runOpenClaudeDesignWorkflow(ctx: OpenClaudeDesignContext): Promise<OpenClaudeDesignOutputs> {
  const designContext = ctx;

    // Initial deterministic setup step (no LLM): ensure the playwright-cli skill's
    // `playwright-cli` command is installed before any design stage runs. Best-effort —
    // a failed install never blocks the workflow; downstream stages keep their
    // graceful-degradation fallback (surface the manual preview path / URL).
    const playwrightCli = ensurePlaywrightCli();
    const browserBootstrapRules = buildPlaywrightCliBootstrapRules(playwrightCli);

    const inputs = designContext.inputs;

    const prompt = inputs.prompt;
    const reference = inputs.reference?.trim() ?? "";
    const outputType = normalizeOutputType(inputs.output_type);
    const designSystemInput = (inputs.design_system ?? "").trim();
    const maxRefinements = positiveInteger(
      inputs.max_refinements,
      DEFAULT_MAX_REFINEMENTS,
    );

    const workflowCwd = designContext.cwd ?? process.cwd();
    const { runId, artifactDir, previewPath, specPath } = prepareArtifactDir(
      workflowCwd,
    );
    const previewFileUrl = `file://${previewPath}`;
    const specFileUrl = `file://${specPath}`;

    const designModelConfig = {
      model: "anthropic/claude-fable-5:xhigh",
      fallbackModels: [
          "github-copilot/claude-opus-4.8 (1m):xhigh",
          "anthropic/claude-opus-4-8:xhigh",
          "zai/glm-5.2:xhigh",
          "zai-coding-cn/glm-5.2:xhigh",
          "github-copilot/claude-sonnet-4.6 (1m):high",
          "anthropic/claude-sonnet-4-6:high",
      ],
    };
    const refinementDecisionConfig = {
      ...designModelConfig,
      tools: [...READ_ONLY_TOOLS],
      schema: refinementDecisionSchema,
    };
    const exportGateDecisionConfig = {
      ...designModelConfig,
      tools: [...READ_ONLY_TOOLS],
      schema: exportGateDecisionSchema,
    };

    let designSystem: string;
    let onboarding: readonly WorkflowTaskResult[] = [];

    if (designSystemInput.length > 0) {
      const loaded = await designContext.task("load-design-system", {
        prompt: taggedPrompt([
          [
            "role",
            "You are an opinionated staff design engineer.",
          ],
          [
            "objective",
            `Prepare a six-section DESIGN.md-shaped brief that will steer generation of: ${prompt}. Apply the impeccable \`document\` sub-skill to read an existing DESIGN.md / PRODUCT.md (or equivalent).`,
          ],
          ["design_system_reference", designSystemInput],
          [
            "instructions",
            [
              "1. Read every reference path/URL supplied.",
              "2. Extract: register (brand vs product), Creative North Star, color tokens with descriptive names, type stack, elevation philosophy, components/variants, accessibility constraints, and the named DO/DON'T rules.",
              "3. Distinguish explicit rules in the source from inferred conventions; never invent rules.",
              "4. State what could not be verified instead of guessing.",
            ].join("\n"),
          ],
          [
            "output_format",
            [
              "Markdown with the six required headings, in this exact order and case:",
              "## Overview",
              "## Colors",
              "## Typography",
              "## Elevation",
              "## Components",
              "## Do's and Don'ts",
              "Then a final `## Gaps / Assumptions` section listing anything unverified.",
            ].join("\n"),
          ],
        ]),
        ...designModelConfig,
      });
      designSystem = loaded.text;
      onboarding = [loaded];
    } else {
      onboarding = await designContext.parallel(
        [
          {
            name: "ds-locator",
            task: taggedPrompt([
              [
                "role",
                "You are an opinionated staff design engineer.",
              ],
              [
                "objective",
                `Find UI/design-system sources for this request: ${prompt}. Apply the impeccable \`extract\` sub-skill to find design-system evidence already living in this codebase.`,
              ],
              [
                "instructions",
                [
                  "1. Locate UI components, stylesheets, tokens (CSS custom properties, Tailwind config, CSS-in-JS themes, design-token files), Storybook/examples, screenshots, tests, and design docs.",
                  "2. Return concrete file paths plus why each path informs design generation.",
                  "3. Separate primary sources from supporting examples.",
                  "4. If no explicit design system exists, identify the strongest implicit evidence (most-repeated literals, dominant component patterns).",
                ].join("\n"),
              ],
              [
                "output_format",
                "Markdown table: Path | Evidence type | What it reveals | Repetitions seen | Confidence (low/med/high).",
              ],
            ]),
            ...designModelConfig,
          },
          {
            name: "ds-analyzer",
            task: taggedPrompt([
              [
                "role",
                "You are an opinionated staff design engineer.",
              ],
              [
                "objective",
                `Audit the project UI constraints that must shape: ${prompt}. Apply the impeccable \`audit\` sub-skill to evaluate the located design-system evidence against impeccable's six dimensions of design quality and produce a detailed report with actionable insights for generation.`,
              ],
              [
                "impeccable_skill",
                "audit — score 0–4 across Accessibility, Performance, Theming, Responsive, Anti-patterns. Tag every finding P0 (blocks release) → P3 (polish). Document, do not fix.",
              ],
              [
                "instructions",
                [
                  "1. Inspect: UI stack, styling approach, token usage, responsive behavior, accessibility conventions, component APIs.",
                  "2. Ground every claim in exact paths, symbols, or code examples.",
                  "3. Call out constraints that generated designs MUST follow to integrate cleanly.",
                  "4. State uncertainty rather than guessing when evidence is incomplete.",
                ].join("\n"),
              ],
              [
                "output_format",
                [
                  "Markdown sections in this order:",
                  "1. Stack",
                  "2. Tokens",
                  "3. Components",
                  "4. Layout / responsiveness",
                  "5. Accessibility",
                  "6. Audit scores (per dimension, 0–4)",
                  "7. Hard constraints for generation",
                ].join("\n"),
              ],
            ]),
            ...designModelConfig,
          },
          {
            name: "ds-patterns",
            task: taggedPrompt([
              [
                "role",
                "You are an opinionated staff design engineer.",
              ],
              [
                "objective",
                `Extract reusable patterns and anti-patterns for: ${prompt}. Apply the impeccable \`extract\` sub-skill to find design patterns that should be reused and anti-patterns that must be avoided in generation.`,
              ],
              [
                "instructions",
                [
                  "1. Find naming, variant, composition, state, animation, and layout patterns that should be reused.",
                  "2. Include examples with concrete paths and component/symbol names.",
                  "3. Identify anti-patterns the generated design must avoid — cross-reference impeccable's 25 deterministic anti-patterns (gradient text, AI palettes, nested cards, side-tab borders, line-length problems, etc.).",
                  "4. Do not generalize beyond the evidence found in the repository.",
                ].join("\n"),
              ],
              [
                "output_format",
                "Markdown with sections: Reusable patterns | Examples | Anti-patterns | Generation implications.",
              ],
            ]),
            ...designModelConfig,
          },
        ],
        { task: prompt },
      );

      const builder = await designContext.task("design-system-builder", {
        prompt: taggedPrompt([
          [
            "role",
            "You are a staff design enginer.",
          ],
          [
            "objective",
            `Build the project DESIGN.md that will steer generation for: ${prompt}. Apply the impeccable \`document\` sub-skill to synthesize a coherent design system spec from the located evidence, audit findings, and pattern analysis. This is the most critical step for generation quality; use impeccable's design knowledge to make smart calls when evidence conflicts or is incomplete.`,
          ],
          ["onboarding_analysis", "{previous}"],
          [
            "instructions",
            [
              "1. Synthesize locator + auditor + pattern-miner evidence into one coherent source of truth.",
              "2. Keep every claim traceable to a path or symbol from the analysis.",
              "3. Prefer concrete tokens, component conventions, and accessibility rules over vague style adjectives.",
              "4. List assumptions in a separate trailing section; never mix them with verified rules.",
            ].join("\n"),
          ],
          [
            "output_format",
            [
              "Markdown with exactly these headings, in this order:",
              "## Overview (include the Creative North Star)",
              "## Colors",
              "## Typography",
              "## Elevation",
              "## Components",
              "## Do's and Don'ts (use the impeccable named-rule style)",
              "## Verified vs Assumed",
            ].join("\n"),
          ],
        ]),
        previous: onboarding,
        ...designModelConfig,
      });
      designSystem = builder.text;
      onboarding = [...onboarding, builder];
    }

    const importSteps: WorkflowTaskStep[] = [];
    if (isUrl(reference)) {
      importSteps.push({
        name: "web-capture",
        task: taggedPrompt([
          [
            "role",
            "You are a staff QA engineer with design expertise.",
          ],
          [
            "objective",
            `Capture transferable design intent from this reference for: ${prompt}. Apply the impeccable \`extract\` sub-skill to lift concrete, citable design traits from the reference URL. Use browser/screenshot tooling if available; never guess about visual traits without observable evidence.`,
          ],
          ["reference_url", reference],
          ["browser_use_guidelines", browserBootstrapRules],
          [
            "instructions",
            [
              "1. Use browser/screenshot tooling (for example the playwright-cli skill's `playwright-cli` command) if available; cite observable evidence rather than guessing.",
              "2. If `playwright-cli` is available but opening the reference URL reports a missing browser executable, follow the bootstrap rules and retry once.",
              "3. Analyze: layout, visual hierarchy, navigation, color, typography, spacing, states, interactions, responsive behavior.",
              "4. Separate reference-specific styling from requirements that should transfer to this project's design system.",
              "5. If the URL is inaccessible or browser bootstrap fails, state that and provide a best-effort fallback based only on available information — never fabricate observations.",
            ].join("\n"),
          ],
          [
            "output_format",
            "Markdown sections: Observable design traits | Transferable requirements | Assets/content | Uncertainty.",
          ],
        ]),
        ...designModelConfig,
      });
    }
    if (isFileLike(reference)) {
      importSteps.push({
        name: "file-parser",
        task: taggedPrompt([
          [
            "role",
            "You are an opinionated staff design engineer.",
          ],
          [
            "objective",
            `Extract actionable design requirements for: ${prompt}. Apply the impeccable \`extract\` sub-skill to pull out concrete, citable design requirements from this reference file or doc. The reference might be a design file, a screenshot, a code file, or a design doc; adapt your extraction approach accordingly but never guess about traits that are not explicitly observable in the source.`,
          ],
          ["reference", reference],
          [
            "instructions",
            [
              "1. Extract: requirements, tokens, layout details, interaction notes, assets, copy, constraints, acceptance criteria.",
              "2. Quote or cite concrete sections/paths wherever possible.",
              "3. Separate explicit requirements from inferred design direction.",
              "4. If the reference cannot be read, say exactly what failed and what remains unknown.",
            ].join("\n"),
          ],
          [
            "output_format",
            "Markdown sections: Explicit requirements | Inferred direction | Assets/copy | Constraints | Unknowns.",
          ],
        ]),
        ...designModelConfig,
      });
    }

    const imports =
      importSteps.length > 0
        ? await designContext.parallel(importSteps, { task: prompt })
        : [];
    const importContext =
      imports.length > 0
        ? joinResults(imports)
        : "No external reference was provided; infer the design direction from the prompt and project design system.";

    const generated = await designContext.task("generator", {
      prompt: taggedPrompt([
        [
          "role",
          "You are an opinionated staff design engineer.",
        ],
        [
          "objective",
          `Generate the first revision of a production-ready ${outputType} for: ${prompt}. Write it to disk as an interactive HTML preview the user can open in a browser. Apply the impeccable \`craft\` sub-skill to build the design with deliberate ordering and impeccable attention to detail. Every design decision must trace back to the brief, and every visual trait must be justified by the design system or reference context.`,
        ],
        ["design_system", designSystem],
        ["reference_context", importContext],
        ["preview_artifact_path", previewPath],
        ["html_rules", HTML_PREVIEW_RULES],
        ["anti_design_slop_rules", ANTI_SLOP_RULES],
        [
          "instructions",
          [
            `1. Use the Write tool to create the HTML artifact at exactly this path: ${previewPath}.`,
            "2. Treat the verified DESIGN.md rules as hard constraints unless a conflict is explicitly flagged.",
            `3. Build the artifact as the requested output_type (${outputType}). For prototypes/pages, render full layouts with realistic content. For components, render the component in 3+ representative contexts (default, with content variations, with state variations).`,
            "4. Include structure, states, accessibility behavior, responsive behavior, and integration notes — but keep them in HTML comments inside the file so the rendered preview stays clean.",
            "5. Do not use generic placeholder language when project conventions are available.",
            "6. After writing the file, return a short markdown summary (NOT the HTML body) describing what you built, the decisions you made, and assumptions you are leaving for the user to confirm.",
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
      ]),
      previous: [...onboarding, ...imports],
      ...designModelConfig,
    });

    let latestDesign = generated.text;
    let approvedForExport = false;
    let refinementCount = 0;

    // Try to display the freshly generated preview to the user via browser.
    await designContext
      .task("preview-display-initial", {
        prompt: taggedPrompt([
          [
            "role",
            "You are an opinionated staff design engineer.",
          ],
          [
            "objective",
            "Your job is to make the just-generated HTML artifact visible to the user so they can give feedback. Open the HTML preview file using the playwright-cli skill's `playwright-cli` command when available, then prompt the user for feedback. Gracefully degrade if browser automation is unavailable.",
          ],
          ["preview_path", previewPath],
          ["preview_file_url", previewFileUrl],
          ["browser_use_guidelines", browserBootstrapRules],
          [
            "instructions",
            [
              "1. Probe for `playwright-cli` availability using the bootstrap rules above.",
              `2. If available, run: \`playwright-cli open ${previewFileUrl}\`. If that reports a missing browser executable, follow the bootstrap rules and retry once.`,
              "3. Then run `playwright-cli snapshot` and, for interactive review, `playwright-cli show --annotate` so the user can draw on the page and add notes; if interactive review is unavailable, ask the user to review the visible page or manual file path and provide notes inline.",
              "4. Capture any annotation artifact path, screenshot path, or user notes and surface them in your output.",
              `5. If \`playwright-cli\` is NOT available or browser bootstrap fails, print a clear instruction block telling the user to open the file manually at: ${previewPath} (or via the URL ${previewFileUrl}).`,
              "6. Never block the workflow on unavailable tooling; always exit with a non-empty status string.",
            ].join("\n"),
          ],
          [
            "output_format",
            "Markdown with: `display_method`, `preview_path`, `annotated_snapshot` (if available), `user_notes` (if available), `next_action_hint`.",
          ],
        ]),
        ...designModelConfig,
      })
      .catch(() => undefined);

    const refinement = await refineOpenClaudeDesign({
      designContext,
      prompt,
      outputType,
      maxRefinements,
      previewPath,
      previewFileUrl,
      artifactDir,
      browserBootstrapRules,
      designSystem,
      latestDesign,
      designModelConfig,
      refinementDecisionConfig,
    });
    latestDesign = refinement.latestDesign;
    approvedForExport = refinement.approvedForExport;
    refinementCount = refinement.refinementCount;

    const exportResult = await exportOpenClaudeDesign({
      designContext,
      prompt,
      outputType,
      previewPath,
      previewFileUrl,
      specPath,
      specFileUrl,
      browserBootstrapRules,
      designSystem,
      latestDesign,
      designModelConfig,
      exportGateDecisionConfig,
    });
    latestDesign = exportResult.latestDesign;
    const handoff = exportResult.handoff;

    return {
      output_type: outputType,
      design_system: designSystemInput || "project-derived design system",
      artifact: latestDesign,
      handoff: handoff.text,
      approved_for_export: approvedForExport,
      refinements_completed: refinementCount,
      import_context: importContext,
      run_id: runId,
      artifact_dir: artifactDir,
      preview_path: previewPath,
      preview_file_url: previewFileUrl,
      spec_path: specPath,
      spec_file_url: specFileUrl,
      playwright_cli_status: playwrightCli.summary,
    };

}
