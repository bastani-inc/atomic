/**
 * open-claude-design setup helpers.
 *
 * Capabilities that delegate to the accessible `impeccable` skill
 * (`/skill:impeccable …`), factored into this module so the runner and phases
 * files stay focused:
 *
 *   1. Discovery + init front door: one `discovery` stage runs
 *      `/skill:impeccable shape` and `/skill:impeccable init`, interviews the
 *      user for the design brief/output type/references, then lets impeccable
 *      detect/create/reconcile PRODUCT.md and DESIGN.md in the same stage.
 *   2. Reference discovery: browse five curated galleries (Awwwards,
 *      recent.design, Dribbble, Monet, Motionsites) and synthesize a references
 *      brief the generator heavily emulates.
 *   3. Live interactive QA prompt: drive `/skill:impeccable live` against the
 *      static preview.html so the user picks elements, annotates, and accepts
 *      on-brand variants in the browser. cross-ref: impeccable `reference/live.md`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowTaskResult } from "../src/shared/types.js";
import {
  OUTPUT_TYPES,
  discoveryDecisionFromResult,
  taggedPrompt,
  type DiscoveryDecision,
} from "./open-claude-design-utils.js";

type SetupModelConfig = Record<string, object | string | readonly string[]>;
type SetupDesignContext = {
  task(name: string, options: object): Promise<WorkflowTaskResult>;
};

const GROUNDED_REPORTING =
  "Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.";

// ---------------------------------------------------------------------------
// 0. Discovery + init front door (one workflow stage)
// ---------------------------------------------------------------------------

export type ProjectDesignContextResult = {
  readonly summary: string;
};

export function renderDiscoveryContext(discovery: DiscoveryDecision): string {
  return [
    `Confirmed design brief: ${discovery.brief}`,
    `Output type: ${discovery.output_type}`,
    discovery.references.length > 0
      ? `References to emulate (take precedence over DESIGN.md/PRODUCT.md): ${discovery.references.join(", ")}`
      : "References to emulate: none provided.",
  ].join("\n");
}

function buildDiscoveryInitPrompt(prompt: string): string {
  const outputTypes = OUTPUT_TYPES.join(", ");
  return `/skill:impeccable shape
/skill:impeccable init

${taggedPrompt([
    ["role", "You are an opinionated staff designer running the open-claude-design front door."],
    [
      "objective",
      `In one stage, confirm the design brief, output type, and references for: ${prompt}. Then run impeccable's \`init\` so PRODUCT.md and DESIGN.md are detected, created, or reconciled before design research; do not wait for another init stage.`,
    ],
    [
      "interview",
      [
        "Use `ask_user_question` for important gaps not inferable from the request or repository.",
        `Cover the product and core jobs/screens, one output type (${outputTypes}), and references to emulate (URLs, local paths, screenshots, or design docs).`,
        "Ask 2-3 questions per round and present inferred answers as options rather than facts.",
        "User references are the PRIMARY visual authority and override conflicting DESIGN.md/PRODUCT.md guidance.",
      ].join("\n"),
    ],
    [
      "init_instructions",
      [
        "After confirmation, run `/skill:impeccable init` in this stage. Let impeccable init perform its own PRODUCT.md/DESIGN.md detection rather than relying on runner detection.",
        "Create missing files when needed and reconcile existing ones without silently overwriting them; ask only about genuine gaps.",
        "When headless, infer the most defensible brief/register from the prompt and repository, record explicit `## Gaps / Assumptions`, and do not block.",
      ].join("\n"),
    ],
    [
      "output_format",
      `Return the structured fields \`brief\`, \`output_type\` (one of ${outputTypes}), and \`references\` (verbatim URL/path array, empty when none). In at most 250 words, summarize PRODUCT.md/DESIGN.md changes and assumptions. ${GROUNDED_REPORTING}`,
    ],
  ])}`;
}

export async function runDiscoveryAndInit(args: {
  readonly designContext: SetupDesignContext;
  readonly prompt: string;
  readonly discoveryConfig: SetupModelConfig;
}): Promise<{
  readonly discovery: DiscoveryDecision;
  readonly discoveryContext: string;
  readonly projectContext: ProjectDesignContextResult;
}> {
  const result = await args.designContext.task("discovery", {
    prompt: buildDiscoveryInitPrompt(args.prompt),
    ...args.discoveryConfig,
  });
  const discovery = discoveryDecisionFromResult(result, args.prompt);
  return {
    discovery,
    discoveryContext: renderDiscoveryContext(discovery),
    projectContext: {
      summary: [
        "Ran `/skill:impeccable shape` + `/skill:impeccable init` in the combined discovery stage.",
        (result.text ?? "").trim(),
      ].filter((part) => part.length > 0).join("\n\n"),
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Reference discovery
// ---------------------------------------------------------------------------

/** Curated galleries of beautiful, current reference designs. */
export const REFERENCE_DESIGN_SITES: readonly { readonly name: string; readonly url: string }[] = [
  { name: "Awwwards", url: "https://www.awwwards.com/websites/" },
  { name: "recent.design", url: "https://recent.design/" },
  { name: "Dribbble (recent shots)", url: "https://dribbble.com/shots/recent" },
  { name: "Monet", url: "https://www.monet.design/c" },
  { name: "Motionsites", url: "https://motionsites.ai/" },
];

export const NO_REFERENCES_BRIEF =
  "Reference discovery was skipped. Generate from the project design system and the prompt; do not fabricate external references.";

/** Artifact filenames for large stage-to-stage context handoffs (issue #2121). */
export const DESIGN_CONTEXT_FILENAME = "design-context.md";
export const REFERENCES_BRIEF_FILENAME = "references.md";

export function designContextPath(artifactDir: string): string {
  return join(artifactDir, DESIGN_CONTEXT_FILENAME);
}

export function referencesBriefPath(artifactDir: string): string {
  return join(artifactDir, REFERENCES_BRIEF_FILENAME);
}

export function buildReferenceDiscoveryPrompt(args: {
  readonly prompt: string;
  readonly outputType: string;
  readonly designContextFile: string;
  readonly artifactDir: string;
  readonly browserBootstrapRules: string;
}): string {
  const siteList = REFERENCE_DESIGN_SITES.map(
    (site, index) => `${index + 1}. ${site.name} — ${site.url}`,
  ).join("\n");
  return taggedPrompt([
    ["reference_galleries", siteList],
    [
      "design_context_file",
      `Read the file at ${args.designContextFile} for the project design context (PRODUCT.md/DESIGN.md summary) and the ds-* discovery evidence before curating. Do not proceed from assumptions when the file is readable; if it is missing, say so and curate from the brief alone.`,
    ],
    ["browser_use_guidelines", args.browserBootstrapRules],
    ["screenshot_dir", args.artifactDir],
    [
      "role",
      "You are an opinionated staff design engineer curating current, best-in-class visual references.",
    ],
    [
      "objective",
      `Curate references for a ${args.outputType} serving: ${args.prompt}. Open actual design pages, capture motion with scroll-through video when possible and a full-page screenshot as fallback, record destination URLs, and apply impeccable \`extract\` to report concrete observed traits.`,
    ],
    [
      "instructions",
      [
        "Use the playwright-cli skill to open each gallery; if `playwright-cli` reports a missing browser executable, follow the bootstrap rules and retry once.",
        "From each gallery, choose 1-3 fitting designs and CLICK INTO each actual live or project-detail page; do not capture only the grid or thumbnail.",
        `Capture motion across the entire page: start \`playwright-cli video-start ${join(args.artifactDir, "ref-<site>-<n>.webm")}\`, scroll smoothly in small increments with waits (using \`playwright-cli run-code\` or repeated \`playwright-cli mousewheel 0 600\`) so animations fire and lazy content loads, then run \`playwright-cli video-stop\`.`,
        `Also run \`playwright-cli screenshot --full-page --filename=${join(args.artifactDir, "ref-<site>-<n>.png")}\`; this still is the minimum when video is unavailable.`,
        "Record the actual destination URL, title, and author. For each reference, cite observed layout, typography, color, spacing, and motion traits rather than inferred traits.",
        "Assess fit against DESIGN.md, PRODUCT.md, and the ds-* discovery evidence in the design-context file; prefer on-brand references and flag departures.",
        "Use ask_user_question to ask which reference direction they prefer, offering 2-4 strongest options plus `None of these fit`. If none fit, ask them to provide a reference image, screenshot, URL, or local file path and record the answer.",
        "If `playwright-cli` is unavailable or automation is blocked, use web search / page fetch to reach actual pages and mark missing recordings or screenshots. Never fabricate references or visual claims; report galleries with no usable result.",
      ].join("\n"),
    ],
    [
      "output_format",
      [
        "In at most 900 words, return these Markdown sections:",
        "1. Curated references (table: Source gallery | Work (title/author) | Full page URL (destination) | Scroll-through video path | Full-page screenshot path | Transferable trait (incl. motion) | On-brand?)",
        "2. User preference check (selected direction, or none plus the requested/provided reference)",
        "3. Synthesis (3-5 strongest directions ranked by fit, including motion to reproduce)",
        "4. What to avoid (observed anti-references)",
        "5. Verification notes (actual-page video/screenshot versus search-only)",
        GROUNDED_REPORTING,
      ].join("\n"),
    ],
  ]);
}

/**
 * Write a context artifact that downstream stages consume via `reads`.
 * These files are required stage inputs, not best-effort durability copies:
 * a swallowed write failure would let reference-discovery, generate, and
 * exporter stages dispatch against nonexistent design/reference context, so
 * a failure propagates and stops the workflow (issue #2121, Greptile P1).
 */
function writeRequiredContextArtifact(
  artifactDir: string,
  filePath: string,
  content: string,
  label: string,
): void {
  try {
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(filePath, `${content}\n`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `open-claude-design: failed to write the required ${label} artifact at ${filePath}. Downstream stages read this file via \`reads\` and must not run without it (${detail})`,
      { cause: error },
    );
  }
}

/**
 * Persist the curated references brief to `<artifactDir>/references.md`.
 * Downstream generate stages consume this file via `reads` instead of an
 * inline prompt embed; a write failure propagates (issue #2121).
 */
export function persistReferencesBrief(artifactDir: string, brief: string): void {
  writeRequiredContextArtifact(artifactDir, referencesBriefPath(artifactDir), brief, "references-brief");
}

/**
 * Persist the composed project design context (impeccable init summary plus
 * ds-* discovery evidence) to `<artifactDir>/design-context.md`.
 * Reference-discovery, generate, and exporter stages consume this file via
 * `reads` instead of an inline prompt embed, so one oversized research result
 * cannot become an oversized single prompt message. A write failure
 * propagates rather than letting those stages run without their design
 * context (issue #2121).
 */
export function persistDesignContext(artifactDir: string, content: string): void {
  writeRequiredContextArtifact(artifactDir, designContextPath(artifactDir), content, "design-context");
}

// ---------------------------------------------------------------------------
// 2. Live interactive QA prompt (user-feedback display/review stages)
// ---------------------------------------------------------------------------

/**
 * Build the interactive-QA prompt for the `user-feedback-*` stages. Drives
 * `/skill:impeccable live` against the static preview so the user can pick
 * elements in the browser, annotate, and accept on-brand variants; degrades to
 * `playwright-cli show --annotate` and finally to a manual file path. The output
 * labels (`user_notes`, `annotated_snapshot`, `live_changes`) are parsed by the
 * generate/user-feedback loop.
 */
export function buildLivePreviewDisplayPrompt(args: {
  readonly previewPath: string;
  readonly previewFileUrl: string;
  readonly browserBootstrapRules: string;
  readonly iteration?: number;
  readonly maxRefinements?: number;
  readonly final?: boolean;
}): string {
  const isInitial = args.iteration === undefined;
  const isFinal = args.final === true;
  const label = isInitial
    ? "the just-generated HTML artifact"
    : "the revised preview";
  const objective = isFinal
    ? `Show the user ${label} as the FINAL refinement pass and let them review it in the browser. This is the last automated iteration, so do NOT solicit change requests this run cannot apply — if the user wants further changes, tell them to re-run \`/workflow open-claude-design\`. Drive \`/skill:impeccable live\` for viewing/QA when possible; degrade gracefully.`
    : `Make ${label} visible to the user, run an interactive design-QA session against it, then capture the user's feedback for the refinement loop. Drive \`/skill:impeccable live\` against the static preview when possible; degrade gracefully when browser automation is unavailable.`;
  const interactiveQa = isFinal
    ? [
        `1. Open the preview for a final review: run \`/skill:impeccable live\` (or \`playwright-cli open ${args.previewFileUrl}\`) so the user can inspect ${label} in the browser.`,
        "2. Make clear this is the final automated refinement pass. Do NOT promise to apply further annotations; instead, tell the user exactly how to re-run the workflow to iterate again.",
      ].join("\n")
    : [
        `1. Run \`/skill:impeccable live\` targeted at the preview file so the user can pick elements in the browser, annotate them, and compare on-brand variants. The preview is a single static HTML file at ${args.previewPath}; point live at it (configure \`.impeccable/live/config.json\` for that file or pass \`--target ${args.previewPath}\` per the live reference) and open ${args.previewFileUrl} in the browser.`,
        `2. The moment the live review is reachable — and BEFORE starting any long-poll wait — print the exact review URL in plain text: the live \`http://\` URL when the live server is up, plus ${args.previewFileUrl} as the manual fallback. Anyone attaching to this stage mid-run must see where the review is happening from your first lines of output.`,
        "3. For each element the user picks, follow the live contract: read any annotation screenshot, extract the page identity FIRST, then generate three DISTINCT on-brand variants and let the user accept one. Accepted variants are written into the preview HTML in place; do NOT branch the artifact.",
        "4. Also handle the live `steer` path for page-level direction the user types/speaks, and treat any freeform prompt as the ceiling on direction.",
        "5. Keep iterating until the user signals they are done with this round.",
      ].join("\n");
  const outputFormat = isFinal
    ? [
        "Markdown with: `display_method` (live | playwright-annotate | manual), `preview_path`, and `next_action_hint` (how to re-run the workflow for further changes).",
        "Do NOT collect `user_notes` or `live_changes`: this final pass cannot apply them, so don't invite feedback that would go nowhere.",
      ].join("\n")
    : [
        "Markdown with these exact labels so the refinement loop can parse the captured feedback:",
        "`display_method` (live | playwright-annotate | manual)",
        "`preview_path`",
        "`live_changes` (summary of every element/variant the user ACCEPTED in the live session; `none` when no live edits were made)",
        "`annotated_snapshot` (path to any annotated screenshot, if captured)",
        "`user_notes` (the user's verbatim notes/annotations for the next iteration; `none` when the user gave no notes)",
        "`next_action_hint`",
      ].join("\n");
  return taggedPrompt([
    ["preview_path", args.previewPath],
    ["preview_file_url", args.previewFileUrl],
    ["browser_use_guidelines", args.browserBootstrapRules],
    [
      "role",
      "You are an opinionated staff design engineer running interactive `live` QA in a real browser.",
    ],
    ["objective", objective],
    ["interactive_live_qa", interactiveQa],
    [
      "graceful_degradation",
      [
        `If \`/skill:impeccable live\` cannot boot, open the preview with \`playwright-cli open ${args.previewFileUrl}\`, then run \`playwright-cli snapshot\`${isFinal ? "" : " and `playwright-cli show --annotate` for user notes"}. If the browser executable is missing, follow the bootstrap rules and retry once.`,
        `If \`playwright-cli\` is unavailable, tell the user to open ${args.previewPath} or ${args.previewFileUrl} manually.`,
        "Unavailable tooling must not block the workflow; return a non-empty status.",
      ].join("\n"),
    ],
    ["output_format", `${outputFormat}\nKeep the report under 250 words. ${GROUNDED_REPORTING}`],
  ]);
}

// ---------------------------------------------------------------------------
// 3. Deterministic live-review gate (run-level HIL prompt, issue #2060)
// ---------------------------------------------------------------------------

/**
 * Minimal structural slice of `ctx.ui` the live-review gate needs. Kept
 * structural so the runner/phases modules stay decoupled from the full
 * WorkflowRunContext type.
 */
export type LiveReviewGateUi = {
  select<T extends string>(message: string, options: readonly T[]): Promise<T>;
};

/**
 * Choices for the deterministic gate raised before every `user-feedback-*`
 * stage. The first entry starts the browser review round; the second accepts
 * the current design and skips straight to export.
 */
export const LIVE_REVIEW_GATE_OPTIONS = [
  "Start live review",
  "Skip remaining review rounds and export as-is",
] as const;

/**
 * Message for the deterministic run-level prompt raised before each
 * `user-feedback-*` stage. The stage's browser long-poll never sets
 * `awaiting_input`, so without this gate the run is indistinguishable from
 * active compute while it waits on a human (issue #2060). Raising a `ctx.ui`
 * prompt sets the run-level pending prompt, which fires the needs-attention
 * badge and carries the preview URL to the root session deterministically.
 */
export function buildLiveReviewGateMessage(args: {
  readonly iteration: number;
  readonly maxRefinements: number;
  readonly previewPath: string;
  readonly previewFileUrl: string;
}): string {
  return [
    `Design review round ${args.iteration} of ${args.maxRefinements} is ready for your browser review.`,
    "",
    `Preview file: ${args.previewPath}`,
    `Preview URL: ${args.previewFileUrl}`,
    "",
    `"${LIVE_REVIEW_GATE_OPTIONS[0]}" opens an interactive browser session; the user-feedback stage prints the live http:// review URL as soon as its server is up (attach with /workflow connect to see it, or open the preview URL above directly).`,
    `"${LIVE_REVIEW_GATE_OPTIONS[1]}" accepts the current design and proceeds to export.`,
  ].join("\n");
}

/**
 * True only for the executor's unavailable-UI rejections (no UI adapter, or
 * headless/non-interactive mode; see `executor-hil.ts` `makeRejectingUIContext`
 * and the prompt-node unavailable errors). The live-review gate degrades to
 * running the review for exactly these; every other rejection — interruption,
 * durable checkpoint persistence failure, exit — must propagate so the
 * workflow stops instead of opening a review against an invalid run state.
 */
export function isUiUnavailableRejection(error: unknown): boolean {
  return error instanceof Error && /ctx\.ui\.\w+ (?:prompt node )?is unavailable/.test(error.message);
}
