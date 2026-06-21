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
 * through the `playwright-cli` skill so the user can interactively review;
 * when browser automation is unavailable, the file path is surfaced so the user
 * can open it manually. Before any stage runs, an initial deterministic setup
 * step ensures the playwright-cli skill's `playwright-cli` command is available
 * (`npx --no-install playwright-cli --version`, then
 * `npm install -g @playwright/cli@latest` when missing); it is best-effort and
 * never blocks the run. The final exporter produces a rich `spec.html` that
 * embeds the agreed-upon design alongside the implementation handoff.
 */

import { defineWorkflow } from "../src/workflows/define-workflow.js";
import { Type } from "typebox";
import { runOpenClaudeDesignWorkflow } from "./open-claude-design-runner.js";
import {
  DEFAULT_MAX_REFINEMENTS,
  DEFAULT_OUTPUT_TYPE,
  OUTPUT_TYPES,
} from "./open-claude-design-utils.js";

export default defineWorkflow("open-claude-design")
  .description(
    "AI-powered design workflow: design-system onboarding → reference import → HTML generation → impeccable-driven refinement → quality gate → rich HTML handoff. Each stage delegates to a specific impeccable sub-skill; the user can iteratively review the generated HTML through the playwright-cli skill.",
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
  .output("playwright_cli_status", Type.Optional(Type.String({ description: "Outcome of the initial deterministic step that ensures the playwright-cli skill's `playwright-cli` command is installed." })))
  .run(runOpenClaudeDesignWorkflow)
  .compile();
