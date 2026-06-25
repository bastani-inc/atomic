/**
 * Builtin workflow: open-claude-design
 *
 * Adapts Atomic SDK's Claude Design workflow to the local workflow SDK:
 * combined discovery/init, design-system/reference research, generation, bounded
 * refinement, export, and final display run through ctx.task()/ctx.parallel().
 *
 * Every stage prompt invokes the specific impeccable sub-skill that maps to
 * its role (see https://github.com/pbakaus/impeccable/tree/main/site/content/skills):
 *
 *   onboarding     → impeccable `document` / `extract` / `audit`
 *   import         → impeccable `extract`
 *   generate-N     → impeccable `craft` / `polish` (HTML preview)
 *   user-feedback  → impeccable `live` (browser review + user notes)
 *   exporter       → impeccable `document` (rich HTML spec)
 *   final-display  → opens/surfaces the exported HTML spec
 */

import { Type } from "typebox";
import { workflow } from "../src/authoring/workflow.js";
import { runOpenClaudeDesignWorkflow } from "./open-claude-design-runner.js";
import {
  DEFAULT_MAX_REFINEMENTS,
} from "./open-claude-design-utils.js";

export default workflow({
  name: "open-claude-design",
  description: "AI-powered design workflow: combined discovery/init → design-system/reference research → curated reference discovery → HTML generation → live-driven refinement → rich HTML handoff. The discovery stage asks what to build, the output type, and which references to emulate, then runs impeccable init for PRODUCT.md/DESIGN.md (references take precedence over project context). The user iteratively reviews the generated HTML.",
  inputs: {
    prompt: Type.String({
      description: "What to design (for example, a dashboard, page, component, or prototype). The discovery stage refines this into a confirmed brief and asks for the output type and references.",
    }),
    discover_references: Type.Boolean({
      default: true,
      description:
        "Discover beautiful, current reference designs from notable design websites (Awwwards, recent.design, Dribbble, Monet, Motionsites) and feed them to generation. Set false to skip the network/browser reference pass.",
    }),
    max_refinements: Type.Number({
      default: DEFAULT_MAX_REFINEMENTS,
      description: `Maximum generate/user-feedback loop iterations (default ${DEFAULT_MAX_REFINEMENTS}).`,
    }),
  },
  outputs: {
    output_type: Type.Optional(Type.String({ description: "Kind of design artifact produced." })),
    design_system: Type.Optional(Type.String({ description: "Design system source used for generation: the project-derived design system." })),
    artifact: Type.Optional(Type.String({ description: "Latest final design summary from the approved preview artifact." })),
    handoff: Type.Optional(Type.String({ description: "Final rich HTML spec and implementation handoff summary." })),
    approved_for_export: Type.Optional(Type.Boolean({ description: "Whether refinement completed before export." })),
    refinements_completed: Type.Optional(Type.Number({ description: "Number of refinement iterations completed." })),
    import_context: Type.Optional(Type.String({ description: "Reference-import context used during generation." })),
    run_id: Type.Optional(Type.String({ description: "Per-run design workflow artifact identifier." })),
    artifact_dir: Type.Optional(Type.String({ description: "Directory containing preview and spec artifacts." })),
    preview_path: Type.Optional(Type.String({ description: "Absolute path to the generated preview.html file." })),
    preview_file_url: Type.Optional(Type.String({ description: "file:// URL for the generated preview.html file." })),
    spec_path: Type.Optional(Type.String({ description: "Absolute path to the generated spec.html file." })),
    spec_file_url: Type.Optional(Type.String({ description: "file:// URL for the generated spec.html file." })),
    playwright_cli_status: Type.Optional(Type.String({ description: "Outcome of the initial deterministic step that ensures the playwright-cli skill's `playwright-cli` command is installed." })),
  },
  run: async (ctx) => await runOpenClaudeDesignWorkflow(ctx),
});
