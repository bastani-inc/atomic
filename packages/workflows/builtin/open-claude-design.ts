/**
 * Builtin workflow: open-claude-design
 *
 * Adapts Atomic SDK's Claude Design workflow to the local workflow SDK:
 * design-system onboarding, reference import, generation, bounded refinement,
 * enforcement, and export/handoff all run through ctx.task()/ctx.parallel().
 *
 * Every stage prompt invokes the specific impeccable sub-skill that maps to
 * its role (see https://github.com/pbakaus/impeccable/tree/main/site/content/skills):
 *
 *   onboarding     → impeccable `document` / `extract` / `audit`
 *   import         → impeccable `extract`
 *   generator      → impeccable `craft` (HTML preview)
 *   user-feedback  → impeccable `critique` (against the live HTML preview)
 *   critique-N     → impeccable `critique`
 *   screenshot-N   → impeccable `audit` + `live`
 *   apply-changes  → impeccable `polish`
 *   pre-export     → impeccable `audit`
 *   forced-fix     → impeccable `harden`
 *   exporter       → impeccable `document` (rich HTML spec)
 *
 * The refinement loop has been re-shaped so that the artifact under review is
 * a real HTML page on disk (`preview.html`). The workflow attempts to open it
 * through the `browser` skill so the user can interactively review;
 * when browser automation is unavailable, the file path is surfaced so the user
 * can open it manually. Before any stage runs, an initial deterministic setup
 * step ensures the browser skill's `browse` CLI is available (`which browse`,
 * then `npm install -g browse` when missing); it is best-effort and never
 * blocks the run. The final exporter produces a rich `spec.html` that
 * embeds the agreed-upon design alongside the implementation handoff.
 */

import { defineWorkflow } from "../src/workflows/define-workflow.js";
import { Type } from "typebox";
import type {
  WorkflowTaskResult,
  WorkflowTaskStep,
} from "../src/shared/types.js";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUTPUT_TYPES = [
  "prototype",
  "wireframe",
  "page",
  "component",
  "theme",
  "tokens",
] as const;
type OutputType = (typeof OUTPUT_TYPES)[number];
const DEFAULT_OUTPUT_TYPE: OutputType = "prototype";
const DEFAULT_MAX_REFINEMENTS = 3;

/**
 * Read-only builtin tools granted to the structured-decision stages
 * (user-feedback refinement gate and pre-export gate) so they can actually
 * inspect the on-disk `preview.html` before emitting their decision. The
 * artifact stays immutable here — writes/edits belong to apply-changes and
 * forced-fix, so this list deliberately excludes write/edit/bash.
 */
const READ_ONLY_TOOLS = ["read", "grep", "ls"] as const;

type PromptSection = readonly [tag: string, content: string];

function taggedPrompt(sections: readonly PromptSection[]): string {
  return sections
    .map(([tag, content]) => {
      const trimmed = content.trim();
      return `<${tag}>\n${trimmed}\n</${tag}>`;
    })
    .join("\n\n");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function normalizeOutputType(value: string | undefined): OutputType {
  return value !== undefined &&
    (OUTPUT_TYPES as readonly string[]).includes(value)
    ? (value as OutputType)
    : DEFAULT_OUTPUT_TYPE;
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function isFileLike(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && !isUrl(trimmed);
}

type RefinementDecision = {
  readonly ready_for_export: boolean;
  readonly rationale: string;
  readonly required_changes: readonly string[];
};

type ExportGateFinding = {
  readonly finding: string;
  readonly evidence: string;
  readonly why_blocking: string;
  readonly must_fix_action: string;
  readonly severity: "P0";
};

type ExportGateDecision = {
  readonly has_blocking_findings: boolean;
  readonly rationale: string;
  readonly blocking_findings: readonly ExportGateFinding[];
};

const refinementDecisionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ready_for_export", "rationale", "required_changes"],
  properties: {
    ready_for_export: { type: "boolean" },
    rationale: { type: "string" },
    required_changes: { type: "array", items: { type: "string" } },
  },
} as const;

const refinementDecisionTool = {
  name: "refinement_decision",
  label: "Refinement Decision",
  description: "Emit the structured design refinement decision.",
  promptSnippet: "Emit the final refinement decision as structured data",
  promptGuidelines: [
    "Call refinement_decision after inspecting the preview and deciding whether another refinement iteration is needed.",
    "This is a terminating structured-output tool; do not emit another assistant response after calling it.",
  ],
  parameters: refinementDecisionSchema,
  async execute(_toolCallId: string, params: RefinementDecision) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(params, null, 2) }],
      details: params,
      terminate: true,
    };
  },
};

const exportGateDecisionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["has_blocking_findings", "rationale", "blocking_findings"],
  properties: {
    has_blocking_findings: { type: "boolean" },
    rationale: { type: "string" },
    blocking_findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["finding", "evidence", "why_blocking", "must_fix_action", "severity"],
        properties: {
          finding: { type: "string" },
          evidence: { type: "string" },
          why_blocking: { type: "string" },
          must_fix_action: { type: "string" },
          severity: { type: "string", enum: ["P0"] },
        },
      },
    },
  },
} as const;

const exportGateDecisionTool = {
  name: "export_gate_decision",
  label: "Export Gate Decision",
  description: "Emit the structured pre-export gate decision.",
  promptSnippet: "Emit the final export gate decision as structured data",
  promptGuidelines: [
    "Call export_gate_decision after auditing the preview for blocking findings.",
    "This is a terminating structured-output tool; do not emit another assistant response after calling it.",
  ],
  parameters: exportGateDecisionSchema,
  async execute(_toolCallId: string, params: ExportGateDecision) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(params, null, 2) }],
      details: params,
      terminate: true,
    };
  },
};

function parseRefinementDecision(text: string): RefinementDecision {
  const parsed = JSON.parse(text) as Partial<RefinementDecision>;
  if (typeof parsed.ready_for_export !== "boolean") {
    throw new Error("open-claude-design refinement decision missing ready_for_export.");
  }
  return {
    ready_for_export: parsed.ready_for_export,
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
    required_changes: Array.isArray(parsed.required_changes)
      ? parsed.required_changes.filter((item): item is string => typeof item === "string")
      : [],
  };
}

function parseExportGateDecision(text: string): ExportGateDecision {
  const parsed = JSON.parse(text) as Partial<ExportGateDecision>;
  if (typeof parsed.has_blocking_findings !== "boolean") {
    throw new Error("open-claude-design export gate decision missing has_blocking_findings.");
  }
  return {
    has_blocking_findings: parsed.has_blocking_findings,
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
    blocking_findings: Array.isArray(parsed.blocking_findings)
      ? parsed.blocking_findings.filter(
          (item): item is ExportGateFinding =>
            typeof item === "object" &&
            item !== null &&
            "finding" in item &&
            "evidence" in item &&
            "why_blocking" in item &&
            "must_fix_action" in item &&
            "severity" in item,
        )
      : [],
  };
}

function joinResults(results: readonly WorkflowTaskResult[]): string {
  return results
    .map((result) => `### ${result.name}\n\n${result.text}`)
    .join("\n\n---\n\n");
}

/**
 * Compute (and best-effort create) a per-run artifact directory.
 * Prefers `<cwd>/.atomic/workflows/open-claude-design/<runId>` so the artifacts
 * stay next to the project and are discoverable by pi. Falls back to the OS
 * tmpdir when the project tree is not writable (CI sandboxes, mocks, etc.).
 */
function prepareArtifactDir(cwd = process.cwd()): {
  readonly runId: string;
  readonly artifactDir: string;
  readonly previewPath: string;
  readonly specPath: string;
} {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
  const candidates = [
    join(cwd, "specs", "design", runId),
    join(tmpdir(), "open-claude-design", runId),
  ];
  for (const candidate of candidates) {
    try {
      mkdirSync(candidate, { recursive: true });
      return {
        runId,
        artifactDir: candidate,
        previewPath: join(candidate, "preview.html"),
        specPath: join(candidate, "spec.html"),
      };
    } catch {
      // try next fallback
    }
  }
  // Last-resort: synthesize paths even if mkdir failed; downstream agents will
  // recreate parents using their Write tool.
  const fallback = join(tmpdir(), "open-claude-design", runId);
  return {
    runId,
    artifactDir: fallback,
    previewPath: join(fallback, "preview.html"),
    specPath: join(fallback, "spec.html"),
  };
}

const HTML_PREVIEW_RULES = [
  "Produce a single self-contained HTML document. Inline all CSS in a <style> block and inline any JS in a <script> block; no external network requests except Google Fonts when explicitly required.",
  "Embed realistic content that respects the design brief — no Lorem ipsum, no obvious placeholders.",
  "Implement responsive behavior with sensible breakpoints (use container queries or media queries) so the file renders well from 360px up to 1440px.",
  "Cover at minimum: default state, hover/focus state for every interactive element, empty state if relevant, loading state if relevant, error state if relevant.",
  "Use accessible markup: semantic landmarks, labeled form controls, sufficient contrast (WCAG AA), visible focus styles, prefers-reduced-motion respected.",
  "Annotate the file with HTML comments that mark sections, states, and design-system token references so engineers can read the intent quickly.",
].join("\n");

const ANTI_SLOP_RULES = [
  "Do not produce generic AI-slop palettes (purple/indigo gradients, blue-to-pink, neon glassmorphism stacks, nested card grids).",
  "Avoid the AI design clichés impeccable's anti-pattern catalog calls out: gradient text for emphasis, side-tab borders, three-font headers, decorative shadows on flat-by-default systems.",
  "Commit to a specific aesthetic direction; do not hedge with generic SaaS defaults.",
].join("\n");

type BrowseCliStatus = {
  /** Whether the `browse` CLI is expected to be available to downstream stages. */
  readonly available: boolean;
  /** True when the CLI was already on PATH and no install was attempted. */
  readonly alreadyPresent: boolean;
  /** True when this step installed the CLI via `npm install -g browse`. */
  readonly installed: boolean;
  /** Human-readable, single-line outcome surfaced as a workflow output. */
  readonly summary: string;
  /** Raw failure reason when the install could not complete; absent on success. */
  readonly error?: string;
};

/**
 * Initial deterministic setup step (no LLM): ensure the browser skill's `browse`
 * CLI is available before any design stage runs. Mirrors the browser skill's
 * documented bootstrap (`which browse || npm install -g browse`) but performs it
 * once, deterministically, instead of relying on each stage to probe/install it.
 * The PATH probe always runs, but the actual global install is skipped under
 * automated tests (`NODE_ENV=test`) to avoid slow, networked, environment-
 * mutating side effects.
 *
 * Best-effort by contract: it never throws and never blocks the workflow. When
 * the CLI cannot be located or installed, downstream stages keep their graceful
 * degradation path (surface the manual preview path / URL).
 */
function ensureBrowseCli(): BrowseCliStatus {
  const isWindows = process.platform === "win32";
  const onPath = (): boolean => {
    try {
      const probe = spawnSync(isWindows ? "where" : "which", ["browse"], {
        stdio: "ignore",
        timeout: 15_000,
        shell: isWindows,
      });
      return probe.status === 0;
    } catch {
      return false;
    }
  };

  if (onPath()) {
    return {
      available: true,
      alreadyPresent: true,
      installed: false,
      summary: "browse CLI already on PATH; skipped install.",
    };
  }

  // Never perform a real global `npm install` during automated tests: it is
  // slow, network-dependent, and would mutate the test runner's global
  // environment. The PATH probe above and the prompt guidance below are still
  // exercised; only the install side effect is skipped.
  if (process.env.NODE_ENV === "test") {
    return {
      available: false,
      alreadyPresent: false,
      installed: false,
      summary:
        "browse CLI not found; skipped global install under the test environment.",
      error: "global install skipped during tests",
    };
  }

  try {
    const install = spawnSync("npm", ["install", "-g", "browse"], {
      stdio: "ignore",
      timeout: 180_000,
      shell: isWindows,
    });
    if (install.status === 0) {
      return {
        available: true,
        alreadyPresent: false,
        installed: true,
        summary: "Installed browse CLI via `npm install -g browse`.",
      };
    }
    const reason =
      install.error?.message ??
      (typeof install.status === "number"
        ? `npm install -g browse exited with code ${install.status}`
        : "npm install -g browse did not complete");
    return {
      available: false,
      alreadyPresent: false,
      installed: false,
      summary: `Could not install browse CLI (${reason}); stages will degrade gracefully.`,
      error: reason,
    };
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error);
    return {
      available: false,
      alreadyPresent: false,
      installed: false,
      summary: `Could not install browse CLI (${reason}); stages will degrade gracefully.`,
      error: reason,
    };
  }
}

/**
 * Build the per-run browser bootstrap guidance injected into stage prompts.
 * When the deterministic setup step already ensured `browse` is installed, the
 * guidance tells stages to assume availability and not waste turns reinstalling;
 * otherwise it retains the original probe-and-install fallback.
 */
function buildBrowserBootstrapRules(status: BrowseCliStatus): string {
  const probeRule = status.available
    ? "The workflow's deterministic setup step already ensured the browser skill's `browse` CLI is installed and on PATH; assume it is available and do NOT reinstall it. Only if a `browse` command reports the executable as missing should you re-probe with `which browse` and run `npm install -g browse` once before retrying. Do not add project dependencies."
    : `The workflow's deterministic setup step attempted to install the browser skill's \`browse\` CLI but it FAILED with: "${status.error ?? "unknown error"}". Treat this as a known starting condition to work around, not a hard blocker. Probe with \`which browse\` and retry once with \`npm install -g browse\`; if it still fails, use the error above to diagnose a workaround (for example: EACCES/permission errors → retry with a user-writable global prefix; missing npm/Node → report it plainly; network/registry errors → surface them). If the CLI still cannot be made available, degrade gracefully and surface the manual file path / URL. Do not add project dependencies.`;
  return [
    probeRule,
    "Use `browse open <url> --local --headed` when a generated local preview should be visible to the user, and use `browse snapshot` plus `browse screenshot --path <file>` for review evidence.",
    "If `browse` is unavailable after three attempts or the browser runtime still fails, degrade gracefully and surface the manual file path / URL.",
  ].join("\n");
}

export default defineWorkflow("open-claude-design")
  .description(
    "AI-powered design workflow: design-system onboarding → reference import → HTML generation → impeccable-driven refinement → quality gate → rich HTML handoff. Each stage delegates to a specific impeccable sub-skill; the user can iteratively review the generated HTML through the browser skill.",
  )
  .input("prompt", Type.String({
    description: "What to design (for example, a dashboard, page, component, or prototype).",
  }))
  .input("reference", Type.Optional(Type.String({
    description: "URL, file path, screenshot path, or design doc to import as a reference.",
  })))
  .input("output_type", Type.Union(
    [...OUTPUT_TYPES].map((value) => Type.Literal(value)),
    { default: DEFAULT_OUTPUT_TYPE, description: "Kind of design artifact to produce." },
  ))
  .input("design_system", Type.Optional(Type.String({
    description:
      "Path(s) or description of an existing design system (DESIGN.md, PRODUCT.md, etc.); skips onboarding when provided.",
  })))
  .input("max_refinements", Type.Number({
    default: DEFAULT_MAX_REFINEMENTS,
    description: `Maximum critique/apply refinement iterations (default ${DEFAULT_MAX_REFINEMENTS}).`,
  }))
  .output("output_type", Type.Optional(Type.String({ description: "Kind of design artifact produced." })))
  .output("design_system", Type.Optional(Type.String({ description: "Design system source used for generation: supplied input or project-derived design system." })))
  .output("artifact", Type.Optional(Type.String({ description: "Latest final design summary from the approved preview artifact." })))
  .output("handoff", Type.Optional(Type.String({ description: "Final rich HTML spec and implementation handoff summary." })))
  .output("approved_for_export", Type.Optional(Type.Boolean({ description: "Whether refinement completed before the final export gate." })))
  .output("refinements_completed", Type.Optional(Type.Number({ description: "Number of refinement iterations completed." })))
  .output("import_context", Type.Optional(Type.String({ description: "Reference-import context used during generation." })))
  .output("run_id", Type.Optional(Type.String({ description: "Per-run design workflow artifact identifier." })))
  .output("artifact_dir", Type.Optional(Type.String({ description: "Directory containing preview and spec artifacts." })))
  .output("preview_path", Type.Optional(Type.String({ description: "Absolute path to the generated preview.html file." })))
  .output("preview_file_url", Type.Optional(Type.String({ description: "file:// URL for the generated preview.html file." })))
  .output("spec_path", Type.Optional(Type.String({ description: "Absolute path to the generated spec.html file." })))
  .output("spec_file_url", Type.Optional(Type.String({ description: "file:// URL for the generated spec.html file." })))
  .output("browse_cli_status", Type.Optional(Type.String({ description: "Outcome of the initial deterministic step that ensures the browser skill's `browse` CLI is installed." })))
  .run(async (ctx) => {
    // Initial deterministic setup step (no LLM): ensure the browser skill's
    // `browse` CLI is installed before any design stage runs. Best-effort —
    // a failed install never blocks the workflow; downstream stages keep their
    // graceful-degradation fallback (surface the manual preview path / URL).
    const browseCli = ensureBrowseCli();
    const browserBootstrapRules = buildBrowserBootstrapRules(browseCli);

    const inputs = ctx.inputs;

    const prompt = inputs.prompt;
    const reference = inputs.reference?.trim() ?? "";
    const outputType = normalizeOutputType(inputs.output_type);
    const designSystemInput = (inputs.design_system ?? "").trim();
    const maxRefinements = positiveInteger(
      inputs.max_refinements,
      DEFAULT_MAX_REFINEMENTS,
    );

    const { runId, artifactDir, previewPath, specPath } = prepareArtifactDir(
      ctx.cwd,
    );
    const previewFileUrl = `file://${previewPath}`;
    const specFileUrl = `file://${specPath}`;

    const designModelConfig = {
      model: "anthropic/claude-fable-5:xhigh",
      fallbackModels: [
          "github-copilot/claude-opus-4.8:xhigh",
          "anthropic/claude-opus-4-8:xhigh",
          "github-copilot/claude-sonnet-4.6:high",
          "anthropic/claude-sonnet-4-6:high",
      ],
    };
    const refinementDecisionConfig = {
      ...designModelConfig,
      tools: [...READ_ONLY_TOOLS, refinementDecisionTool.name],
      customTools: [refinementDecisionTool],
    };
    const exportGateDecisionConfig = {
      ...designModelConfig,
      tools: [...READ_ONLY_TOOLS, exportGateDecisionTool.name],
      customTools: [exportGateDecisionTool],
    };

    let designSystem: string;
    let onboarding: readonly WorkflowTaskResult[] = [];

    if (designSystemInput.length > 0) {
      const loaded = await ctx.task("load-design-system", {
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
      onboarding = await ctx.parallel(
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

      const builder = await ctx.task("design-system-builder", {
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
              "1. Use browser/screenshot tooling (for example the browser skill's `browse` CLI) if available; cite observable evidence rather than guessing.",
              "2. If `browse` is available but opening the reference URL reports a missing browser executable, follow the bootstrap rules and retry once.",
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
        ? await ctx.parallel(importSteps, { task: prompt })
        : [];
    const importContext =
      imports.length > 0
        ? joinResults(imports)
        : "No external reference was provided; infer the design direction from the prompt and project design system.";

    const generated = await ctx.task("generator", {
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
    await ctx
      .task("preview-display-initial", {
        prompt: taggedPrompt([
          [
            "role",
            "You are an opinionated staff design engineer.",
          ],
          [
            "objective",
            "Your job is to make the just-generated HTML artifact visible to the user so they can give feedback. Open the HTML preview file using the browser skill's `browse` CLI when available, then prompt the user for feedback. Gracefully degrade if browser automation is unavailable.",
          ],
          ["preview_path", previewPath],
          ["preview_file_url", previewFileUrl],
          ["browser_use_guidelines", browserBootstrapRules],
          [
            "instructions",
            [
              "1. Probe for `browse` availability using the bootstrap rules above.",
              `2. If available, run: \`browse open ${previewFileUrl} --local --headed\`. If that reports a missing browser executable, follow the bootstrap rules and retry once.`,
              "3. Then run `browse snapshot` and use any available annotation/review flow from the active browser environment; if none exists, ask the user to review the visible page or manual file path and provide notes inline.",
              "4. Capture any annotation artifact path, screenshot path, or user notes and surface them in your output.",
              `5. If \`browse\` is NOT available or browser bootstrap fails, print a clear instruction block telling the user to open the file manually at: ${previewPath} (or via the URL ${previewFileUrl}).`,
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

    for (let iteration = 1; iteration <= maxRefinements; iteration += 1) {
      refinementCount = iteration;

      const feedback = await ctx.task(`user-feedback-${iteration}`, {
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
              "3. Decide whether the current design is ready for export using the refinement_decision structured-output tool.",
              "4. If refinement is still needed, put specific changes in required_changes ordered by user value and implementation risk.",
              "5. Never request changes that contradict DESIGN.md unless you explicitly identify and explain the conflict.",
            ].join("\n"),
          ],
          [
            "output_format",
            [
              "Call the refinement_decision tool after your inspection.",
              "Set ready_for_export=true only when the current preview needs no further refinement before export.",
              "Set ready_for_export=false and populate required_changes when another polish iteration is needed.",
            ].join("\n"),
          ],
        ]),
        previous: { name: "current-design", text: latestDesign },
        ...refinementDecisionConfig,
      });

      const feedbackDecision = parseRefinementDecision(feedback.text);
      if (feedbackDecision.ready_for_export) {
        approvedForExport = true;
        break;
      }

      const validation = await ctx.parallel(
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
                  `1. Attempt rendering verification via the browser skill: \`browse open ${previewFileUrl} --local\`. If that reports a missing browser executable, follow the bootstrap rules and retry once.`,
                  `2. Then run \`browse viewport 360 800\`, \`browse screenshot --path ${join(artifactDir, `mobile-${iteration}.png`)}\`, \`browse viewport 1440 900\`, \`browse screenshot --path ${join(artifactDir, `desktop-${iteration}.png`)}\`.`,
                  "3. Check: contrast (WCAG AA), overflow, spacing rhythm, alignment, breakpoint behavior, empty/loading/error states, keyboard/pointer affordances, focus rings, prefers-reduced-motion.",
                  "4. If `browse` is unavailable or browser bootstrap fails, perform a static design review of the HTML source and mark every finding as `needs-rendering-verification`.",
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

      const applied = await ctx.task(`apply-changes-${iteration}`, {
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
      await ctx
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
                `1. If \`browse\` is available, run \`browse open ${previewFileUrl} --local --headed\`. If that reports a missing browser executable, follow the bootstrap rules and retry once.`,
                "2. Then run `browse snapshot` and use any available annotation/review flow from the active browser environment; otherwise ask the user to provide feedback inline.",
                `3. If \`browse\` is unavailable or browser bootstrap fails, surface the path clearly: ${previewPath} (URL: ${previewFileUrl}).`,
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

    const preExport = await ctx.task("pre-export-scan", {
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
            "4. Decide whether export is blocked using the export_gate_decision structured-output tool.",
            "5. Every blocking finding must include selector-level evidence and a must-fix action.",
          ].join("\n"),
        ],
        [
          "output_format",
          [
            "Call the export_gate_decision tool after the audit.",
            "Set has_blocking_findings=true only when one or more P0 findings block export.",
            "Populate blocking_findings with every blocking P0 issue; leave it empty when export is safe.",
          ].join("\n"),
        ],
      ]),
      previous: { name: "final-design", text: latestDesign },
      ...exportGateDecisionConfig,
    });

    const exportGateDecision = parseExportGateDecision(preExport.text);
    if (exportGateDecision.has_blocking_findings) {
      const forcedFix = await ctx.task("forced-fix", {
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

    const handoff = await ctx.task("exporter", {
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
            "3. How to open the spec (browse command + manual fallback path)",
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
    await ctx
      .task("final-display", {
        prompt: taggedPrompt([
          [
            "role",
            "You are an opinionated staff design engineer.",
          ],
          [
            "objective",
            "Make the rich HTML spec visible to the user. Open the final spec.html with the browser skill's `browse` CLI so the user can review the agreed design and implementation handoff. Degrade gracefully if browser automation is unavailable.",
          ],
          ["spec_path", specPath],
          ["spec_file_url", specFileUrl],
          ["preview_path", previewPath],
          ["preview_file_url", previewFileUrl],
          ["browser_use_guidelines", browserBootstrapRules],
          [
            "instructions",
            [
              "1. Probe for `browse` availability using the bootstrap rules above.",
              `2. If available, run \`browse open ${specFileUrl} --local --headed\`. If that reports a missing browser executable, follow the bootstrap rules and retry once.`,
              "3. Then run `browse snapshot` and use any available annotation/review flow from the active browser environment so the user can capture any final notes.",
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
      browse_cli_status: browseCli.summary,
    };
  })
  .compile();
