import type { WorkflowParallelOptions, WorkflowTaskOptions, WorkflowTaskResult, WorkflowTaskStep } from "../src/shared/types.js";
import {
  DEFAULT_MAX_REFINEMENTS,
  REFERENCE_PRECEDENCE,
  buildPlaywrightCliBootstrapRules,
  discoveryDecisionSchema,
  ensurePlaywrightCli,
  joinResults,
  positiveInteger,
  prepareArtifactDir,
  shouldEarlyExitForBrowser,
  taggedPrompt,
} from "./open-claude-design-utils.js";
import { exportOpenClaudeDesign, refineOpenClaudeDesign } from "./open-claude-design-phases.js";
import {
  NO_REFERENCES_BRIEF,
  buildReferenceDiscoveryPrompt,
  persistReferencesBrief,
  runDiscoveryAndInit,
} from "./open-claude-design-setup.js";

type OpenClaudeDesignOutputs = {
  readonly output_type?: string; readonly design_system?: string; readonly artifact?: string; readonly handoff?: string;
  readonly approved_for_export?: boolean; readonly refinements_completed?: number; readonly import_context?: string; readonly run_id?: string;
  readonly artifact_dir?: string; readonly preview_path?: string; readonly preview_file_url?: string; readonly spec_path?: string; readonly spec_file_url?: string;
  readonly playwright_cli_status?: string;
};

type OpenClaudeDesignContext = {
  readonly cwd?: string;
  readonly inputs: { readonly prompt: string; readonly discover_references?: boolean; readonly max_refinements?: number };
  exit?(options?: { readonly status?: string; readonly reason?: string; readonly outputs?: Partial<OpenClaudeDesignOutputs> }): never;
  task(name: string, options: WorkflowTaskOptions): Promise<WorkflowTaskResult>;
  parallel(steps: readonly WorkflowTaskStep[], options: WorkflowParallelOptions): Promise<WorkflowTaskResult[]>;
};

export async function runOpenClaudeDesignWorkflow(ctx: OpenClaudeDesignContext): Promise<OpenClaudeDesignOutputs> {
  const designContext = ctx;

  // Initial deterministic setup step (no LLM): ensure the playwright-cli skill's
  // `playwright-cli` command is installed before any design stage runs. Best-effort.
  const playwrightCli = ensurePlaywrightCli();
  const browserBootstrapRules = buildPlaywrightCliBootstrapRules(playwrightCli);

  const inputs = designContext.inputs;
  const prompt = inputs.prompt;
  const discoverReferences = inputs.discover_references !== false;
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

  // Browser-centric workflow: the discovery/preview review and the interactive
  // `live` QA loop need the playwright-cli browser. If it is unavailable, exit
  // cleanly up front (surfacing artifact paths) rather than generating a design
  // no one can review. Gated off under NODE_ENV=test / runtimes without ctx.exit.
  if (
    shouldEarlyExitForBrowser(playwrightCli.available, process.env.NODE_ENV) &&
    typeof designContext.exit === "function"
  ) {
    designContext.exit({
      reason: `open-claude-design needs the playwright-cli skill's browser for interactive design review, which is unavailable (${playwrightCli.error ?? playwrightCli.summary}). No design was generated. Install it (\`npm install -g @playwright/cli@latest\` + \`npx playwright install chromium\`) and re-run.`,
      outputs: {
        playwright_cli_status: playwrightCli.summary, run_id: runId, artifact_dir: artifactDir,
        preview_path: previewPath, preview_file_url: previewFileUrl, spec_path: specPath, spec_file_url: specFileUrl,
      },
    });
  }

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
  // Phase 1: combined discovery + init — one stage interviews the user via
  // impeccable `shape`, then immediately runs impeccable `init` so PRODUCT.md /
  // DESIGN.md are detected, created, or reconciled before design research.
  const frontDoor = await runDiscoveryAndInit({
    designContext,
    prompt,
    discoveryConfig: { ...designModelConfig, schema: discoveryDecisionSchema },
  });
  const discovery = frontDoor.discovery;
  const designBrief = discovery.brief;
  const outputType = discovery.output_type;
  const references = discovery.references;
  const projectContext = frontDoor.projectContext;

  const userReferenceContext = references.length > 0
    ? references.map((ref, index) => `${index + 1}. ${ref}`).join("\n")
    : "No user-provided references were collected during discovery.";
  const referenceHandlingRules = references.length > 0
    ? [
        REFERENCE_PRECEDENCE,
        "For URL references, use browser/screenshot tooling when available and cite only observable traits.",
        "For files, screenshots, or design docs, read or parse the source directly and quote concrete evidence.",
        "Include a `Reference requirements` section so the generator receives the imported constraints.",
      ].join("\n")
    : "No user references to import. Focus on project context and curated reference-discovery when present.";

  // Phase 3 (combined): a single fan-out gathers project design-system evidence
  // and references. The ds-* stages now also import user URLs/files directly.
  const dsSteps: WorkflowTaskStep[] = [
    {
      name: "ds-locator",
      task: taggedPrompt([
        ["role", "You are an opinionated staff design engineer."],
        [
          "objective",
          `Find UI/design-system sources for this request: ${designBrief}. Apply the impeccable \`extract\` sub-skill to find design-system evidence already living in this codebase, plus any user-provided reference URLs/files that should steer generation.`,
        ],
        ["user_references", userReferenceContext],
        ["reference_handling", referenceHandlingRules],
        ["browser_use_guidelines", browserBootstrapRules],
        [
          "instructions",
          [
            "1. Locate UI components, stylesheets, tokens, Storybook/examples, screenshots, tests, design docs, and user references.",
            "2. Return concrete file paths, URLs, or artifact paths plus why each source informs design generation.",
            "3. Separate primary sources from supporting examples and from reference-only inspiration.",
            "4. If no explicit design system exists, identify the strongest implicit evidence (most-repeated literals, dominant component patterns).",
          ].join("\n"),
        ],
        [
          "output_format",
          "Markdown sections: Project sources table | User reference sources | Reference requirements | Confidence notes.",
        ],
      ]),
      ...designModelConfig,
    },
    {
      name: "ds-analyzer",
      task: taggedPrompt([
        ["role", "You are an opinionated staff design engineer."],
        [
          "objective",
          `Audit the project UI constraints that must shape: ${designBrief}. Independently scan the repository and evaluate the evidence you find against impeccable's six dimensions of design quality. Also capture/parse any user-provided references in this same pass. This runs in PARALLEL with the locator and pattern passes, so do your own scan rather than relying on their output.`,
        ],
        [
          "impeccable_skill",
          "audit — score 0–4 across Accessibility, Performance, Theming, Responsive, Anti-patterns. Tag every finding P0 (blocks release) → P3 (polish). Document, do not fix.",
        ],
        ["user_references", userReferenceContext],
        ["reference_handling", referenceHandlingRules],
        ["browser_use_guidelines", browserBootstrapRules],
        [
          "instructions",
          [
            "1. Inspect: UI stack, styling approach, token usage, responsive behavior, accessibility conventions, component APIs.",
            "2. Ground every claim in exact paths, symbols, code examples, screenshots, URLs, or quoted reference excerpts.",
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
            "7. Reference requirements",
            "8. Hard constraints for generation",
          ].join("\n"),
        ],
      ]),
      ...designModelConfig,
    },
    {
      name: "ds-patterns",
      task: taggedPrompt([
        ["role", "You are an opinionated staff design engineer."],
        [
          "objective",
          `Extract reusable patterns and anti-patterns for: ${designBrief}. Apply the impeccable \`extract\` sub-skill to find design patterns to reuse and anti-patterns to avoid. Also parse/capture user references inside this same pass, translating them into reusable generation patterns. This runs in PARALLEL with the locator and auditor passes, so scan the codebase yourself rather than depending on their output.`,
        ],
        ["user_references", userReferenceContext],
        ["reference_handling", referenceHandlingRules],
        ["browser_use_guidelines", browserBootstrapRules],
        [
          "instructions",
          [
            "1. Find naming, variant, composition, state, animation, and layout patterns that should be reused.",
            "2. Include examples with concrete paths, component/symbol names, reference URLs, or quoted file/screenshot evidence.",
            "3. Identify anti-patterns the generated design must avoid — cross-reference impeccable's 25 deterministic anti-patterns.",
            "4. Do not generalize beyond the evidence found in the repository or imported references.",
          ].join("\n"),
        ],
        [
          "output_format",
          "Markdown sections: Reusable patterns | Examples | Reference requirements | Anti-patterns | Generation implications.",
        ],
      ]),
      ...designModelConfig,
    },
  ];

  const onboardingAnalysis = await designContext.parallel(dsSteps, {
    task: designBrief,
  });
  const onboardingSummary = joinResults(onboardingAnalysis);

  const referenceResult = discoverReferences
    ? await designContext.task("reference-discovery", {
        prompt: buildReferenceDiscoveryPrompt({
          prompt: designBrief,
          outputType,
          designContextHint: [
            projectContext.summary,
            "Design-system/reference discovery evidence from codebase design discovery stages:",
            onboardingSummary,
          ].join("\n\n"),
          artifactDir,
          browserBootstrapRules,
        }),
        previous: onboardingAnalysis,
        ...designModelConfig,
      })
    : undefined;
  const contextResults = referenceResult === undefined
    ? onboardingAnalysis
    : [...onboardingAnalysis, referenceResult];

  const referencesBriefRaw = (referenceResult?.text ?? "").trim();
  const referencesBrief =
    referencesBriefRaw.length > 0 ? referencesBriefRaw : NO_REFERENCES_BRIEF;
  if (referencesBriefRaw.length > 0) persistReferencesBrief(artifactDir, referencesBrief);

  const importContext = references.length > 0
    ? [
        REFERENCE_PRECEDENCE,
        "Reference sources:",
        userReferenceContext,
        "",
        onboardingSummary,
      ].join("\n")
    : "No user reference was provided; infer the design direction from the brief, project design context, research, and curated reference inspiration.";
  const designSystem = [
    "Project design context from `/skill:impeccable init` and PRODUCT.md/DESIGN.md:",
    projectContext.summary,
    "",
    "Design-system and user-reference evidence:",
    onboardingSummary,
  ].join("\n\n");

  let latestDesign = "";
  let approvedForExport = false;
  let refinementCount = 0;

  const refinement = await refineOpenClaudeDesign({
    designContext,
    prompt: designBrief,
    outputType,
    maxRefinements,
    previewPath,
    previewFileUrl,
    artifactDir,
    browserBootstrapRules,
    designSystem,
    generationContext: contextResults,
    designModelConfig,
    workflowCwd,
    referencesBrief,
    importContext,
  });
  latestDesign = refinement.latestDesign;
  approvedForExport = refinement.approvedForExport;
  refinementCount = refinement.refinementCount;

  const exportResult = await exportOpenClaudeDesign({
    designContext,
    prompt: designBrief,
    outputType,
    previewPath,
    previewFileUrl,
    specPath,
    specFileUrl,
    browserBootstrapRules,
    designSystem,
    latestDesign,
    designModelConfig,
  });
  latestDesign = exportResult.latestDesign;
  const handoff = exportResult.handoff;

  return {
    output_type: outputType,
    design_system: "project-derived design system",
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
