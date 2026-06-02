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
 * through `browser-use` so the user can interactively review and annotate;
 * when browser-use is unavailable, the file path is surfaced so the user
 * can open it manually. The final exporter produces a rich `spec.html` that
 * embeds the agreed-upon design alongside the implementation handoff.
 */

import { defineWorkflow } from "../src/workflows/define-workflow.js";
import { Type } from "typebox";
import type {
  WorkflowTaskResult,
  WorkflowTaskStep,
} from "../src/shared/types.js";
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

type PromptSection = readonly [tag: string, content: string];

function taggedPrompt(sections: readonly PromptSection[]): string {
  return sections
    .map(([tag, content]) => `<${tag}>\n${content.trim()}\n</${tag}>`)
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

function refinementComplete(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("refinement complete") ||
    normalized.includes("approved for export") ||
    normalized.trim() === "done"
  );
}

function hasBlockingFindings(text: string): boolean {
  const normalized = text.toLowerCase();
  if (
    normalized.includes("no blocking findings") ||
    normalized.includes("no banned anti-patterns")
  ) {
    return false;
  }
  return (
    normalized.includes("blocking") ||
    normalized.includes("banned anti-pattern") ||
    normalized.includes("must fix")
  );
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
  "Produce a single self-contained HTML5 document. Inline all CSS in a <style> block and inline any JS in a <script> block; no external network requests except Google Fonts when explicitly required.",
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

const BROWSER_USE_BOOTSTRAP_RULES = [
  "Probe for browser-use availability with `browser-use --version` (or `bunx browser-use --version` when relying on an ephemeral Bun execution). Do not install browser-use itself.",
  "If browser-use is available but opening a page fails because Chrome, Chrome for Testing, Chromium, or another browser executable is not installed, first run `browser-use doctor`, then run `browser-use setup` if the doctor output recommends setup, and retry the browser action once.",
  "Only install or configure the missing browser runtime; do not install npm packages, change project dependencies, or repeatedly retry failed setup.",
  "If browser-use is unavailable or browser setup still fails, degrade gracefully and surface the manual file path / URL.",
].join("\n");

export default defineWorkflow("open-claude-design")
  .description(
    "AI-powered design workflow: design-system onboarding → reference import → HTML generation → impeccable-driven refinement → quality gate → rich HTML handoff. Each stage delegates to a specific impeccable sub-skill; the user can iteratively review and annotate the generated HTML through browser-use.",
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
  .run(async (ctx) => {
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
      model: "anthropic/claude-opus-4-8:high",
      fallbackModels: [
        "github-copilot/claude-opus-4.7:high",
        "anthropic/claude-sonnet-4-6:high",
        "github-copilot/claude-sonnet-4.6:high",
      ],
    };

    let designSystem: string;
    let onboarding: readonly WorkflowTaskResult[] = [];

    if (designSystemInput.length > 0) {
      const loaded = await ctx.task("load-design-system", {
        prompt: taggedPrompt([
          [
            "role",
            "You are an impeccable design-system analyst. Apply the impeccable `document` sub-skill to read an existing DESIGN.md / PRODUCT.md (or equivalent) and re-emit it in the six-section Google Stitch DESIGN.md format so the rest of this workflow can rely on it.",
          ],
          [
            "objective",
            `Prepare a six-section DESIGN.md-shaped brief that will steer generation of: ${prompt}`,
          ],
          ["design_system_reference", designSystemInput],
          [
            "impeccable_skill",
            "document — generate a spec-compliant DESIGN.md (Overview, Colors, Typography, Elevation, Components, Do's and Don'ts) in fixed order with fixed names. Headers must be parseable by downstream tools.",
          ],
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
                "You are an impeccable design-system locator. Apply the impeccable `extract` sub-skill to find design-system evidence already living in this codebase.",
              ],
              [
                "objective",
                `Find UI/design-system sources for this request: ${prompt}`,
              ],
              [
                "impeccable_skill",
                "extract — only flag patterns used three or more times with the same intent. Two usages are not a pattern. Identify tokens, components, composition patterns, type styles, and motion patterns.",
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
                "You are an impeccable UI architecture auditor. Apply the impeccable `audit` sub-skill to score the project's UI implementation across five dimensions.",
              ],
              [
                "objective",
                `Audit the project UI constraints that must shape: ${prompt}`,
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
                "You are an impeccable pattern miner. Apply the impeccable `extract` sub-skill to harvest reusable design and component patterns, plus the anti-patterns to avoid.",
              ],
              [
                "objective",
                `Extract reusable patterns and anti-patterns for: ${prompt}`,
              ],
              [
                "impeccable_skill",
                "extract — only extract things used 3+ times with the same intent. Never extract speculatively. Always note migration implications.",
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
            "You are an impeccable design-system author. Apply the impeccable `document` sub-skill to synthesize a project-specific DESIGN.md in the six-section Google Stitch format from the three onboarding analyses.",
          ],
          [
            "objective",
            `Build the project DESIGN.md that will steer generation for: ${prompt}`,
          ],
          [
            "impeccable_skill",
            "document — output the six fixed sections in fixed order: Overview, Colors, Typography, Elevation, Components, Do's and Don'ts. Pick a single named Creative North Star metaphor; use descriptive color names; commit to non-default fonts when justified.",
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
            "You are an impeccable reference extractor for live web pages. Apply the impeccable `extract` sub-skill to pull only the design traits that should transfer into the project — never just clone the source.",
          ],
          [
            "objective",
            `Capture transferable design intent from this reference for: ${prompt}`,
          ],
          ["reference_url", reference],
          [
            "impeccable_skill",
            "extract — separate one-off styling from repeated, intentional patterns. Only carry forward what is used 3+ times or what is structurally load-bearing.",
          ],
          ["browser_use_bootstrap", BROWSER_USE_BOOTSTRAP_RULES],
          [
            "instructions",
            [
              "1. Use browser/screenshot tooling (e.g. browser-use) if available; cite observable evidence rather than guessing.",
              "2. If browser-use is available but opening the reference URL reports a missing browser executable, follow the bootstrap rules and retry once.",
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
            "You are an impeccable reference parser for local design files. Apply the impeccable `extract` sub-skill to lift concrete, citable requirements out of supplied references.",
          ],
          [
            "objective",
            `Extract actionable design requirements for: ${prompt}`,
          ],
          ["reference", reference],
          [
            "impeccable_skill",
            "extract — quote or cite concrete sections/paths; never hallucinate content that is not in the source.",
          ],
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
          "You are an impeccable design-and-build engineer. Apply the impeccable `craft` sub-skill to ship a production-quality HTML artifact that traces back to the synthesized DESIGN.md.",
        ],
        [
          "objective",
          `Generate the first revision of a production-ready ${outputType} for: ${prompt}. Write it to disk as an interactive HTML preview the user can open in a browser.`,
        ],
        [
          "impeccable_skill",
          "craft — four phases: (1) read the brief, (2) load relevant references, (3) build with deliberate ordering (structure → spacing/hierarchy → type/color → states → motion → responsive), (4) iterate visually. Every decision must trace back to the brief.",
        ],
        ["design_system", designSystem],
        ["reference_context", importContext],
        ["preview_artifact_path", previewPath],
        ["html_rules", HTML_PREVIEW_RULES],
        ["anti_slop_rules", ANTI_SLOP_RULES],
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

    // Try to display the freshly generated preview to the user via browser-use.
    await ctx
      .task("preview-display-initial", {
        prompt: taggedPrompt([
          [
            "role",
            "You are a preview presenter. Your job is to make the just-generated HTML artifact visible to the user so they can give feedback.",
          ],
          [
            "objective",
            "Open the HTML preview file in a browser using browser-use and prompt the user for annotated feedback. Gracefully degrade if browser-use is unavailable.",
          ],
          ["preview_path", previewPath],
          ["preview_file_url", previewFileUrl],
          ["browser_use_bootstrap", BROWSER_USE_BOOTSTRAP_RULES],
          [
            "instructions",
            [
              "1. Probe for browser-use availability using the bootstrap rules above.",
              `2. If available, run: \`browser-use open ${previewFileUrl}\`. If that reports a missing browser executable, follow the bootstrap rules and retry once.`,
              "3. Then run `browser-use show --annotate` so the user can draw boxes and leave notes directly on the live page.",
              "4. Once the user finishes annotating, capture the returned annotated snapshot path / notes and surface them in your output.",
              `5. If browser-use is NOT available or browser bootstrap fails, print a clear instruction block telling the user to open the file manually at: ${previewPath} (or via the URL ${previewFileUrl}).`,
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
            "You are an impeccable design reviewer collecting actionable refinement feedback from the user about the rendered HTML preview. Apply the impeccable `critique` sub-skill to decide whether the artifact is ready.",
          ],
          [
            "objective",
            `Decide whether refinement is needed for iteration ${iteration}/${maxRefinements} of: ${prompt}.`,
          ],
          [
            "impeccable_skill",
            "critique — score Nielsen's 10 heuristics 0–4, cognitive-load count 0–8, persona-based passes, cross-check the 25 anti-pattern detector. Produce a prioritized list, not free-form prose.",
          ],
          ["preview_path", previewPath],
          ["preview_file_url", previewFileUrl],
          ["current_design_summary", "{previous}"],
          [
            "instructions",
            [
              "1. If a previous `preview-display-*` step captured annotated user feedback or notes, honor them as the primary signal.",
              "2. Otherwise, you may inspect the HTML file at preview_path directly (read it from disk) and run an impeccable `critique` against it.",
              "3. If the current design is ready for export, reply with the exact phrase `refinement complete — <reason>`.",
              "4. Otherwise, list specific changes needed, ordered by user value and implementation risk. Prefer concrete fixes over subjective taste notes.",
              "5. Never request changes that contradict DESIGN.md unless you explicitly identify and explain the conflict.",
            ].join("\n"),
          ],
          [
            "output_format",
            "Either the literal phrase `refinement complete — <reason>`, OR markdown bullets grouped under `Priority 1`, `Priority 2`, `Priority 3` headings.",
          ],
        ]),
        previous: { name: "current-design", text: latestDesign },
        ...designModelConfig,
      });

      if (refinementComplete(feedback.text)) {
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
                "You are an impeccable design critic. Apply the impeccable `critique` sub-skill to run the formal two-pass review against the live HTML preview.",
              ],
              [
                "objective",
                `Critique the current ${outputType} for: ${prompt}. Produce the formal impeccable critique report.`,
              ],
              [
                "impeccable_skill",
                "critique — two parallel passes: (a) LLM design review with Nielsen heuristic scores (0–4), cognitive-load failure count (0–8), persona scoring, and AI-slop verdict; (b) deterministic detector for the 25 anti-patterns (gradient text, purple palettes, side-tab borders, nested cards, line-length issues, etc.).",
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
                "You are an impeccable visual QA specialist for the rendered HTML preview. Apply the impeccable `audit` plus `live` sub-skills to validate the rendered output against breakpoints, states, and accessibility.",
              ],
              [
                "objective",
                `Validate visual implementation risks for: ${prompt}.`,
              ],
              [
                "impeccable_skill",
                "audit + live — `audit` covers contrast, performance, theming, responsive, anti-patterns with P0–P3 severities; `live` validates against the actual rendered page in a real browser, not the source.",
              ],
              ["preview_path", previewPath],
              ["preview_file_url", previewFileUrl],
              ["current_design_and_feedback", "{previous}"],
              [
                "browser_use_bootstrap",
                BROWSER_USE_BOOTSTRAP_RULES,
              ],
              [
                "instructions",
                [
                  `1. Attempt rendering verification via browser-use: \`browser-use open ${previewFileUrl}\`. If that reports a missing browser executable, follow the bootstrap rules and retry once.`,
                  `2. Then run \`browser-use resize 360 800\`, \`browser-use screenshot ${join(artifactDir, `mobile-${iteration}.png`)}\`, \`browser-use resize 1440 900\`, \`browser-use screenshot ${join(artifactDir, `desktop-${iteration}.png`)}\`.`,
                  "3. Check: contrast (WCAG AA), overflow, spacing rhythm, alignment, breakpoint behavior, empty/loading/error states, keyboard/pointer affordances, focus rings, prefers-reduced-motion.",
                  "4. If browser-use is unavailable or browser bootstrap fails, perform a static design review of the HTML source and mark every finding as `needs-rendering-verification`.",
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
            "You are an impeccable design polisher. Apply the impeccable `polish` — the meticulous final pass between good and great — to revise the HTML preview in place.",
          ],
          [
            "objective",
            `Produce the next ${outputType} revision for: ${prompt}. Update the HTML file in place; do not branch the artifact.`,
          ],
          [
            "impeccable_skill",
            "polish — work methodically across six dimensions: (1) visual alignment/spacing, (2) typography, (3) color/contrast, (4) interaction states, (5) transitions/motion, (6) copy. Refine; do not redesign.",
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
              "You are a preview presenter. Re-open the revised HTML preview so the user can review the latest iteration.",
            ],
            [
              "objective",
              `Show the user the revised preview after iteration ${iteration}/${maxRefinements} and capture any new annotated feedback for the next loop.`,
            ],
            ["preview_path", previewPath],
            ["preview_file_url", previewFileUrl],
            [
              "browser_use_bootstrap",
              BROWSER_USE_BOOTSTRAP_RULES,
            ],
            [
              "instructions",
              [
                `1. If browser-use is available, run \`browser-use open ${previewFileUrl}\`. If that reports a missing browser executable, follow the bootstrap rules and retry once.`,
                "2. Then run `browser-use show --annotate` to invite annotated feedback.",
                `3. If browser-use is unavailable or browser bootstrap fails, surface the path clearly: ${previewPath} (URL: ${previewFileUrl}).`,
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
          "You are an impeccable pre-release gate. Apply the impeccable `audit` sub-skill one final time to block export only for concrete, evidence-backed issues.",
        ],
        [
          "objective",
          `Final quality gate for this ${outputType}: ${prompt}. Decide whether the HTML preview at preview_path is safe to export.`,
        ],
        [
          "impeccable_skill",
          "audit — score Accessibility, Performance, Theming, Responsive, Anti-patterns 0–4. Only P0 (blocks release) findings should be marked blocking here.",
        ],
        ["preview_path", previewPath],
        ["final_design_summary", "{previous}"],
        [
          "instructions",
          [
            "1. Read the HTML at preview_path and score it across all five audit dimensions.",
            "2. Scan for banned anti-patterns, accessibility blockers, severe visual regressions, missing critical states, and handoff gaps.",
            "3. Only mark findings as blocking when they would materially harm implementation or user experience (impeccable P0 severity).",
            "4. If safe to export, use the exact phrase `no blocking findings`.",
            "5. Every blocking finding must include selector-level evidence and a must-fix action.",
          ].join("\n"),
        ],
        [
          "output_format",
          "Either the literal phrase `no blocking findings`, OR a markdown table: Finding | Evidence (selector/line) | Why blocking | Must-fix action | Severity (P0).",
        ],
      ]),
      previous: { name: "final-design", text: latestDesign },
      ...designModelConfig,
    });

    if (hasBlockingFindings(preExport.text)) {
      const forcedFix = await ctx.task("forced-fix", {
        prompt: taggedPrompt([
          [
            "role",
            "You are an impeccable production-readiness hardener. Apply the impeccable `harden` sub-skill to remove blocking findings without redesigning.",
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
          "You are an impeccable design documenter. Apply the impeccable `document` sub-skill to produce a RICH HTML SPEC that bundles the approved preview together with implementation guidance for a design/frontend engineer.",
        ],
        [
          "objective",
          `Export the final ${outputType} for "${prompt}" as a rich HTML spec the engineering team can read directly in a browser. The spec must embed or link the approved preview so reviewers see exactly what is being implemented.`,
        ],
        [
          "impeccable_skill",
          "document — the spec must mirror the six-section DESIGN.md structure (Overview, Colors, Typography, Elevation, Components, Do's and Don'ts), plus implementation-handoff sections specific to this artifact.",
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
        ["anti_slop_rules", ANTI_SLOP_RULES],
        [
          "output_format",
          [
            "Return markdown with headings (NOT the HTML):",
            "1. Spec written to (absolute path)",
            "2. Sections included",
            "3. How to open the spec (browser-use command + manual fallback path)",
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
            "You are a final-spec presenter. Make the rich HTML spec visible to the user.",
          ],
          [
            "objective",
            "Open the final spec.html in a browser via browser-use so the user can review the agreed design and implementation handoff. Degrade gracefully if browser-use is unavailable.",
          ],
          ["spec_path", specPath],
          ["spec_file_url", specFileUrl],
          ["preview_path", previewPath],
          ["preview_file_url", previewFileUrl],
          ["browser_use_bootstrap", BROWSER_USE_BOOTSTRAP_RULES],
          [
            "instructions",
            [
              "1. Probe for browser-use availability using the bootstrap rules above.",
              `2. If available, run \`browser-use open ${specFileUrl}\`. If that reports a missing browser executable, follow the bootstrap rules and retry once.`,
              "3. Then run `browser-use show --annotate` so the user can capture any final notes.",
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
    };
  })
  .compile();
