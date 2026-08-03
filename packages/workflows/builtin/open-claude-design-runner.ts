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
  designContextPath,
  persistDesignContext,
  persistReferencesBrief,
  referencesBriefPath,
  runDiscoveryAndInit,
  type LiveReviewGateUi,
} from "./open-claude-design-setup.js";

const GROUNDED_REPORTING =
  "Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.";
const DELEGATION_RULE =
  "Delegate further only work genuinely independent and too large for a handful of tool calls; do not delegate self-verification, and prefer one subagent over several.";

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
  readonly ui: LiveReviewGateUi;
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
  const partialArtifactOutputs = {
    playwright_cli_status: playwrightCli.summary, run_id: runId, artifact_dir: artifactDir,
    preview_path: previewPath, preview_file_url: previewFileUrl, spec_path: specPath, spec_file_url: specFileUrl,
  };

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
      outputs: partialArtifactOutputs,
    });
  }

  // design-context.md / references.md are required `reads` inputs for the
  // reference-discovery, generate, and exporter stages. A failed write must
  // not let those stages dispatch against nonexistent context: exit the run
  // as `blocked` through ctx.exit (mirroring the browser early-exit) with the
  // artifact paths surfaced, or propagate the error when ctx.exit is absent.
  const persistRequiredContextOrExit = (persist: () => void): void => {
    try {
      persist();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (typeof designContext.exit === "function") {
        designContext.exit({
          status: "blocked",
          reason: `${detail} No design was generated.`,
          outputs: partialArtifactOutputs,
        });
      }
      throw error;
    }
  };

  // Anthropic-heavy chain for design taste. Opus stays at :xhigh here because
  // visual quality, rather than cost per task, is the primary objective.
  const designModelConfig = {
    model: "anthropic/claude-opus-5:high",
    fallbackModels: [
      "github-copilot/claude-opus-5:high",
      "anthropic/claude-fable-5:high",
      "github-copilot/claude-fable-5:high",
      "kimi-coding/k3:max",
      "moonshotai/kimi-k3:max",
      "moonshotai-cn/kimi-k3:max",
      "anthropic/claude-opus-4-8:high",
      "github-copilot/claude-opus-4.8:high",
      "openai-codex/gpt-5.6-sol:xhigh",
      "github-copilot/gpt-5.6-sol:xhigh",
      "openai/gpt-5.6-sol:xhigh",
      "xai/grok-4.5:high",
      "zai/glm-5.2:xhigh",
      "zai-coding-cn/glm-5.2:xhigh",
      "openrouter/anthropic/claude-opus-5:high",
      "openrouter/anthropic/claude-fable-5:high",
      "openrouter/anthropic/claude-opus-4-8:high",
      "openrouter/moonshotai/kimi-k3:max",
      "openrouter/openai/gpt-5.6-sol:xhigh",
      "openrouter/sakana/fugu-ultra:high",
      "openrouter/x-ai/grok-4.5",
      "openrouter/z-ai/glm-5.2:xhigh"
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
        ["user_references", userReferenceContext],
        ["reference_handling", referenceHandlingRules],
        ["browser_use_guidelines", browserBootstrapRules],
        ["role", "You are an opinionated staff design engineer."],
        [
          "objective",
          `Find UI/design-system sources for: ${designBrief}. Apply impeccable \`extract\` to codebase evidence and user reference URLs/files that should steer generation.`,
        ],
        ["delegation_rule", DELEGATION_RULE],
        [
          "instructions",
          [
            "Locate UI components, stylesheets, tokens, Storybook/examples, screenshots, tests, design docs, and user references.",
            "Report concrete file, URL, or artifact paths and why each informs generation; separate primary sources, supporting examples, and reference-only inspiration.",
            "If no explicit system exists, report the strongest implicit evidence such as repeated literals and dominant component patterns.",
          ].join("\n"),
        ],
        [
          "output_format",
          `In at most 500 words, return Markdown sections: Project sources table | User reference sources | Reference requirements | Confidence notes. ${GROUNDED_REPORTING}`,
        ],
      ]),
      ...designModelConfig,
    },
    {
      name: "ds-analyzer",
      task: taggedPrompt([
        ["user_references", userReferenceContext],
        ["reference_handling", referenceHandlingRules],
        ["browser_use_guidelines", browserBootstrapRules],
        [
          "impeccable_skill",
          "audit — score 0–4 across Accessibility, Performance, Theming, Responsive, Anti-patterns. Tag every finding P0 (blocks release) → P3 (polish). Document, do not fix.",
        ],
        ["role", "You are an opinionated staff design engineer."],
        [
          "objective",
          `Independently audit UI constraints for: ${designBrief}. Scan the repository, assess evidence across impeccable's six quality dimensions, and capture or parse user references without relying on another stage's output.`,
        ],
        ["delegation_rule", DELEGATION_RULE],
        [
          "instructions",
          [
            "Inspect the UI stack, styling, tokens, responsive behavior, accessibility conventions, and component APIs.",
            "Ground each claim in exact paths, symbols, code examples, screenshots, URLs, or quoted reference excerpts.",
            "Identify integration constraints the generated design must follow, and state uncertainty when evidence is incomplete.",
          ].join("\n"),
        ],
        [
          "output_format",
          `In at most 700 words, return Markdown sections in this order: Stack | Tokens | Components | Layout / responsiveness | Accessibility | Audit scores (per dimension, 0–4) | Reference requirements | Hard constraints for generation. ${GROUNDED_REPORTING}`,
        ],
      ]),
      ...designModelConfig,
    },
    {
      name: "ds-patterns",
      task: taggedPrompt([
        ["user_references", userReferenceContext],
        ["reference_handling", referenceHandlingRules],
        ["browser_use_guidelines", browserBootstrapRules],
        ["role", "You are an opinionated staff design engineer."],
        [
          "objective",
          `Extract reusable patterns and anti-patterns for: ${designBrief}. Apply impeccable \`extract\` to repository evidence and user references, translating them into generation guidance without relying on another stage's output.`,
        ],
        ["delegation_rule", DELEGATION_RULE],
        [
          "instructions",
          [
            "Find reusable naming, variant, composition, state, animation, and layout patterns.",
            "Cite concrete paths, component/symbol names, reference URLs, or quoted file/screenshot evidence.",
            "Identify generated-design anti-patterns using impeccable's 25 deterministic anti-patterns; do not generalize beyond repository or reference evidence.",
          ].join("\n"),
        ],
        [
          "output_format",
          `In at most 600 words, return Markdown sections: Reusable patterns | Examples | Reference requirements | Anti-patterns | Generation implications. ${GROUNDED_REPORTING}`,
        ],
      ]),
      ...designModelConfig,
    },
  ];

  const onboardingAnalysis = await designContext.parallel(dsSteps, {
    task: designBrief,
  });
  const onboardingSummary = joinResults(onboardingAnalysis);

  // Large research context is handed to later stages as an artifact file plus
  // `reads`, never as an inline prompt embed or `previous` payload, so one
  // oversized research result cannot become one oversized prompt message
  // (issue #2121; same failure class as the #1499 413).
  const designSystem = [
    "Project design context from `/skill:impeccable init` and PRODUCT.md/DESIGN.md:",
    projectContext.summary,
    "",
    "Design-system and user-reference evidence:",
    onboardingSummary,
  ].join("\n\n");
  persistRequiredContextOrExit(() => persistDesignContext(artifactDir, designSystem));
  const designContextFile = designContextPath(artifactDir);

  const referenceResult = discoverReferences
    ? await designContext.task("reference-discovery", {
        prompt: buildReferenceDiscoveryPrompt({
          prompt: designBrief,
          outputType,
          designContextFile,
          artifactDir,
          browserBootstrapRules,
        }),
        reads: [designContextFile],
        ...designModelConfig,
      })
    : undefined;

  const referencesBriefRaw = (referenceResult?.text ?? "").trim();
  const referencesBrief =
    referencesBriefRaw.length > 0 ? referencesBriefRaw : NO_REFERENCES_BRIEF;
  // Always persist so the generate stages' `reads` target exists even when
  // discovery is skipped or returned nothing.
  persistRequiredContextOrExit(() => persistReferencesBrief(artifactDir, referencesBrief));
  const referencesFile = referencesBriefPath(artifactDir);

  const importContext = references.length > 0
    ? [
        REFERENCE_PRECEDENCE,
        "Reference sources:",
        userReferenceContext,
        "",
        "Full design-system and reference evidence: read the design-context file.",
      ].join("\n")
    : "No user reference was provided; infer the design direction from the brief, project design context, research, and curated reference inspiration.";

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
    designContextFile,
    referencesFile,
    designModelConfig,
    workflowCwd,
    importContext,
    ui: designContext.ui,
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
    designContextFile,
    referencesFile,
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
