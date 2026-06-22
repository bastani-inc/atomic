/**
 * open-claude-design setup helpers.
 *
 * Capabilities that delegate to the accessible `impeccable` skill
 * (`/skill:impeccable …`), factored into this module so the runner and phases
 * files stay under the 500-line file-length gate:
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
    [
      "role",
      "You are an opinionated staff designer running the open-claude-design front door.",
    ],
    [
      "objective",
      `In ONE workflow stage, first shape the request into a confirmed design brief, output type, and reference list for: ${prompt}. Then immediately run impeccable's \`init\` setup so PRODUCT.md and DESIGN.md are detected, created, or reconciled before downstream design research. Do not ask for or wait on a separate init stage.`,
    ],
    [
      "interview",
      [
        "Use your `ask_user_question` tool for important gaps you cannot infer from the request or repo.",
        `Cover: (a) what to build and core jobs/screens; (b) output type — one of ${outputTypes}; (c) references to emulate (URLs, local paths, screenshots, or design docs).`,
        "Ask 2-3 questions per round; propose inferred answers as options, not finished facts.",
        "User-provided references are the PRIMARY visual authority and take precedence over DESIGN.md/PRODUCT.md where they conflict.",
      ].join("\n"),
    ],
    [
      "init_instructions",
      [
        "After the brief is confirmed, run `/skill:impeccable init` in this same stage.",
        "Let impeccable init perform its own PRODUCT.md/DESIGN.md detection; do not rely on precomputed detection from the workflow runner.",
        "Create missing PRODUCT.md and/or DESIGN.md when needed, and reconcile existing files against the confirmed brief. Never silently overwrite existing files.",
        "When the files already exist, keep it light: load them, reconcile against the brief, and only ask about genuine gaps.",
        "If headless, infer the most defensible brief/register from the prompt and repo signals, write explicit `## Gaps / Assumptions`, and never block.",
      ].join("\n"),
    ],
    [
      "output_format",
      `Return the structured final answer with: \`brief\` (confirmed expanded design brief), \`output_type\` (one of ${outputTypes}), and \`references\` (array of verbatim URLs/paths; empty array when none). In your visible summary, also include PRODUCT.md/DESIGN.md files written or reconciled and any assumptions.`,
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

export function buildReferenceDiscoveryPrompt(args: {
  readonly prompt: string;
  readonly outputType: string;
  readonly designContextHint: string;
  readonly artifactDir: string;
  readonly browserBootstrapRules: string;
}): string {
  const siteList = REFERENCE_DESIGN_SITES.map(
    (site, index) => `${index + 1}. ${site.name} — ${site.url}`,
  ).join("\n");
  return taggedPrompt([
    [
      "role",
      "You are an opinionated staff design engineer and design researcher curating best-in-class, current visual references.",
    ],
    [
      "objective",
      `Find beautiful, current reference designs the team can heavily reference to build a stunning ${args.outputType} for: ${args.prompt}. Open each gallery, CLICK THROUGH to the actual design pages of interest, and — ideally — record a scroll-through video of each page so its ANIMATIONS are captured (with a full-page screenshot as a supplement/fallback) plus its real destination URL. Apply the impeccable \`extract\` sub-skill to lift concrete, citable design traits — never vague adjectives.`,
    ],
    ["reference_galleries", siteList],
    ["design_context", args.designContextHint],
    ["browser_use_guidelines", args.browserBootstrapRules],
    ["screenshot_dir", args.artifactDir],
    [
      "instructions",
      [
        "1. Use the playwright-cli skill to open each gallery above; if `playwright-cli` reports a missing browser executable, follow the bootstrap rules and retry once.",
        "2. On each gallery, scan the thumbnail grid and pick 1-3 designs of interest whose aesthetic fits this brief.",
        "3. CLICK INTO each chosen design to open its ACTUAL page — the live site or project detail the thumbnail links to (for example the gallery's 'visit site' / shot-detail link). Do NOT capture the gallery grid or the thumbnail; navigate to the real design page first.",
        `4. Capture the design's MOTION, not just a still: record a scroll-through video of the ENTIRE page so scroll-triggered animations, parallax, reveals, and transitions are captured. Start with \`playwright-cli video-start ${join(args.artifactDir, "ref-<site>-<n>.webm")}\`, then scroll smoothly from top to bottom — a \`playwright-cli run-code\` script that scrolls in small increments with short waits, or repeated \`playwright-cli mousewheel 0 600\` with pauses — so animations fire and lazy content loads, then \`playwright-cli video-stop\`.`,
        `5. ALSO take a FULL-PAGE still as a supplement/fallback: \`playwright-cli screenshot --full-page --filename=${join(args.artifactDir, "ref-<site>-<n>.png")}\`. If video recording is unavailable, the full-page screenshot is the minimum.`,
        "6. Record the FULL destination URL you actually landed on (the live site / project URL, not the gallery listing URL), plus the work's title and author.",
        "7. For every reference, extract the CONCRETE transferable trait (layout topology, type pairing, color strategy, spacing rhythm) AND the MOTION vocabulary you saw in the recording (entrance animations, scroll reveals, easing, parallax, hover/active states) — cite what you observed on the real page, not what you imagine.",
        "8. For on-brand fit, consult the project's DESIGN.md / PRODUCT.md and the ds-* discovery evidence in <design_context>; prefer references that fit, and flag any that would require departing from the project's system.",
        "9. After curating the strongest options, use ask_user_question to ask the user which reference direction they prefer. Offer 2-4 concise choices drawn from the best references/directions and include a clear `None of these fit` choice when appropriate.",
        "10. If the user says none of the discovered references align with their preference, ask them to provide a reference image, screenshot, URL, or local file path for best results, and include that request and any answer in the final brief.",
        "11. If `playwright-cli` is unavailable or a site blocks automation, fall back to web search / page fetch to reach the actual design pages, and clearly mark any reference you could not capture with a recording or full-page screenshot.",
        "12. Never fabricate references or visual claims; if a gallery yielded nothing usable, say so.",
      ].join("\n"),
    ],
    [
      "output_format",
      [
        "Markdown sections:",
        "1. Curated references (table: Source gallery | Work (title/author) | Full page URL (destination) | Scroll-through video path | Full-page screenshot path | Transferable trait (incl. motion) | On-brand?)",
        "2. User preference check: which curated direction/reference the user preferred, or that none aligned and a reference image/screenshot/URL/path was requested for best results.",
        "3. Synthesis: the 3-5 strongest directions to emulate for THIS design, ranked by fit, calling out motion/animation worth reproducing.",
        "4. What to avoid (anti-references observed on the real pages).",
        "5. Verification notes (which references have a scroll-through recording and/or full-page screenshot of the actual design page vs search-only).",
      ].join("\n"),
    ],
  ]);
}

/** Persist the curated references brief to `<artifactDir>/references.md`. Best-effort. */
export function persistReferencesBrief(artifactDir: string, brief: string): void {
  try {
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, "references.md"), `${brief}\n`);
  } catch {
    /* best-effort durability; never block the workflow */
  }
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
    : `the revised preview after iteration ${args.iteration}/${args.maxRefinements}`;
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
        "2. For each element the user picks, follow the live contract: read any annotation screenshot, extract the page identity FIRST, then generate three DISTINCT on-brand variants and let the user accept one. Accepted variants are written into the preview HTML in place; do NOT branch the artifact.",
        "3. Also handle the live `steer` path for page-level direction the user types/speaks, and treat any freeform prompt as the ceiling on direction.",
        "4. Keep iterating until the user signals they are done with this round.",
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
    [
      "role",
      "You are an opinionated staff design engineer running impeccable's interactive `live` QA so the user can iterate on the design in a real browser.",
    ],
    ["objective", objective],
    ["preview_path", args.previewPath],
    ["preview_file_url", args.previewFileUrl],
    ["browser_use_guidelines", args.browserBootstrapRules],
    ["interactive_live_qa", interactiveQa],
    [
      "graceful_degradation",
      [
        `If \`/skill:impeccable live\` cannot boot (no dev server/HMR for the static file, missing config, or sandbox limits), fall back to opening the preview directly: \`playwright-cli open ${args.previewFileUrl}\`, then \`playwright-cli snapshot\`${isFinal ? "" : " and `playwright-cli show --annotate` so the user can draw/type notes on the page"}. If a \`playwright-cli\` command reports a missing browser executable, follow the bootstrap rules and retry once.`,
        `If \`playwright-cli\` is also unavailable, print a clear instruction block telling the user to open the file manually at ${args.previewPath} (or ${args.previewFileUrl}).`,
        "Never block the workflow on unavailable tooling; always exit with a non-empty status string.",
      ].join("\n"),
    ],
    ["output_format", outputFormat],
  ]);
}
