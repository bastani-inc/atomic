/**
 * open-claude-design setup helpers.
 *
 * Three additive capabilities that all delegate to the accessible `impeccable`
 * skill (`/skill:impeccable …`), factored into this module so the runner and
 * phases files stay under the 500-line file-length gate:
 *
 *   1. Project design context (`init`): always run `/skill:impeccable init`,
 *      which detects PRODUCT.md / DESIGN.md (root, .agents/context/, docs/),
 *      creates whatever is missing, and reconciles existing files against the
 *      discovery brief without clobbering them. cross-ref: impeccable
 *      `reference/init.md`.
 *   2. Reference discovery: browse five curated galleries (Awwwards,
 *      recent.design, Dribbble, Monet, Motionsites) and synthesize a references
 *      brief the generator heavily emulates.
 *   3. Live interactive QA prompt: drive `/skill:impeccable live` against the
 *      static preview.html so the user picks elements, annotates, and accepts
 *      on-brand variants in the browser. cross-ref: impeccable `reference/live.md`.
 */

import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
// 0. Discovery interview (what to build, output type, references)
// ---------------------------------------------------------------------------

function buildDiscoveryPrompt(prompt: string): string {
  const outputTypes = OUTPUT_TYPES.join(", ");
  return `/skill:impeccable shape\n\n${taggedPrompt([
    [
      "role",
      "You are an opinionated staff design engineer running a short design-discovery interview before any code is written.",
    ],
    [
      "objective",
      `Understand exactly what the user wants to build, starting from this request: ${prompt}. Apply the impeccable \`shape\` sub-skill to interview the user and arrive at a confirmed design brief. Do NOT write any files or generate any design yet.`,
    ],
    [
      "interview",
      [
        "Use your structured question tool (AskUserQuestion) to ask the relevant questions you cannot infer from the request or repo.",
        `Cover, at minimum: (a) what they want to build and the core jobs/screens; (b) the output type — one of: ${outputTypes}; (c) any reference designs they want to emulate (URLs, local file paths, screenshots, or design docs).`,
        "Ask 2-3 questions per round and wait for answers; propose inferred answers as options, not finished facts.",
        "Treat the user-provided references as the PRIMARY visual authority for generation — they take precedence over the project's DESIGN.md/PRODUCT.md where they conflict.",
      ].join("\n"),
    ],
    [
      "references_guidance",
      "Collect zero or more references. Each reference is a URL (https://…), a local file path, a screenshot path, or a design-doc path. Keep each one verbatim so later import stages can read it.",
    ],
    [
      "degradation",
      "If you are headless and cannot ask the user, infer the most defensible brief, output type, and references from the request and repo signals; never block the workflow.",
    ],
    [
      "output_format",
      `Return the structured final answer with: \`brief\` (the confirmed, expanded design brief in prose), \`output_type\` (one of ${outputTypes}), and \`references\` (array of verbatim URLs/paths the user wants to emulate; empty array when none).`,
    ],
  ])}`;
}

/**
 * Phase 1. Interview the user (impeccable `shape`) to confirm the design brief,
 * the output type, and the references to emulate before onboarding/generation.
 * Tolerant of headless runs: falls back to the raw prompt and an empty reference
 * set when no structured answer is produced.
 */
export async function runDiscovery(args: {
  readonly designContext: SetupDesignContext;
  readonly prompt: string;
  readonly discoveryConfig: SetupModelConfig;
}): Promise<DiscoveryDecision> {
  const result = await args.designContext.task("discovery", {
    prompt: buildDiscoveryPrompt(args.prompt),
    ...args.discoveryConfig,
  });
  return discoveryDecisionFromResult(result, args.prompt);
}

// ---------------------------------------------------------------------------
// 1. Project design context detection + init
// ---------------------------------------------------------------------------

export type DesignContextDetection = {
  readonly productPath?: string;
  readonly designPath?: string;
  readonly hasProduct: boolean;
  readonly hasDesign: boolean;
  readonly hasBoth: boolean;
};

/** Directories impeccable's init flow checks for PRODUCT.md / DESIGN.md. */
const CONTEXT_DIRS = ["", ".agents/context", "docs"] as const;

function findContextFile(cwd: string, target: "product.md" | "design.md"): string | undefined {
  for (const rel of CONTEXT_DIRS) {
    const dir = rel.length === 0 ? cwd : join(cwd, rel);
    let entries: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.toLowerCase() !== target) continue;
      const full = join(dir, entry);
      try {
        if (statSync(full).isFile()) return full;
      } catch {
        /* ignore unreadable entry */
      }
    }
  }
  return undefined;
}

/**
 * Deterministically report whether PRODUCT.md / DESIGN.md already exist in the
 * project (root, `.agents/context/`, or `docs/`, case-insensitive). Pure read;
 * never writes, never throws.
 */
export function detectDesignContextFiles(cwd: string): DesignContextDetection {
  const productPath = findContextFile(cwd, "product.md");
  const designPath = findContextFile(cwd, "design.md");
  const hasProduct = productPath !== undefined;
  const hasDesign = designPath !== undefined;
  return { productPath, designPath, hasProduct, hasDesign, hasBoth: hasProduct && hasDesign };
}

export type ProjectDesignContextResult = {
  readonly initRan: boolean;
  readonly summary: string;
  readonly detection: DesignContextDetection;
};

function buildInitPrompt(args: {
  readonly prompt: string;
  readonly detection: DesignContextDetection;
  readonly discoveryContext: string;
}): string {
  const productLine = args.detection.hasProduct
    ? `PRODUCT.md already exists at ${args.detection.productPath}; review it and refresh only if the brief reveals a gap — never clobber it without confirming.`
    : "PRODUCT.md does not exist yet; create it.";
  const designLine = args.detection.hasDesign
    ? `DESIGN.md already exists at ${args.detection.designPath}; review it and refresh only if the brief reveals a gap — never clobber it without confirming.`
    : "DESIGN.md does not exist yet; create it (seed it from a few quick questions when there is no code to scan).";
  const missing = [
    args.detection.hasProduct ? undefined : "PRODUCT.md",
    args.detection.hasDesign ? undefined : "DESIGN.md",
  ].filter((value): value is string => value !== undefined);
  const statusLine =
    missing.length > 0
      ? `This project is missing ${missing.join(" and ")} — create the missing file(s) and reconcile any existing one with the brief.`
      : "PRODUCT.md and DESIGN.md already exist — review and reconcile them against the discovery brief, refreshing only what the brief reveals as a gap; never overwrite without confirming.";
  return `/skill:impeccable init\n\n${taggedPrompt([
    [
      "role",
      "You are an opinionated staff design engineer running impeccable's `init` setup for this project.",
    ],
    [
      "objective",
      `Establish or refresh the project's design context BEFORE any design generation for: ${args.prompt}. ${statusLine} Run the impeccable \`init\` flow so every downstream stage designs on-brand instead of producing generic output.`,
    ],
    ["discovery_context", args.discoveryContext],
    [
      "why_this_matters",
      "Impeccable's setup is explicit that skipping the register/brand step produces generic output. PRODUCT.md captures register (brand vs product), target users, purpose, brand personality, anti-references, design principles, and accessibility needs; DESIGN.md captures the visual system (color strategy, typography, components, motion).",
    ],
    [
      "clarifying_questions",
      [
        "Use your structured question tool (AskUserQuestion) to interview the user for design/branding that cannot be inferred from the codebase or the `<discovery_context>` above — do NOT re-ask anything the discovery interview already captured, and do NOT synthesize PRODUCT.md from the design prompt alone.",
        "When PRODUCT.md/DESIGN.md already exist, keep this light: load them, reconcile against the brief, and only ask about genuine gaps instead of re-running the full interview.",
        "Round 1 (when files are missing): confirm register (brand vs product), users/purpose, and the desired outcome.",
        "Round 2 (when files are missing): brand personality (3 words), specific named references, explicit anti-references, and accessibility needs.",
        "Ask 2-3 questions per round and wait for answers; offer inferred answers as hypotheses/options, not finished facts. Do NOT ask about colors/fonts/radii here — those belong to DESIGN.md.",
      ].join("\n"),
    ],
    [
      "files_to_write",
      [
        "Write or refresh PRODUCT.md (strategic) and DESIGN.md (visual system) at the project root, following the impeccable init reference. Never silently overwrite an existing file.",
        productLine,
        designLine,
      ].join("\n"),
    ],
    [
      "degradation",
      "If you are running headless and cannot ask the user, infer the most defensible register/brand from the prompt and any repo signals, write PRODUCT.md/DESIGN.md with an explicit `## Gaps / Assumptions` section, and never block the workflow.",
    ],
    [
      "output_format",
      "Return a short markdown summary: register chosen (brand/product), files written or reconciled (absolute paths), the 3-5 design principles, and any assumptions. Do NOT paste the full file bodies.",
    ],
  ])}`;
}

/**
 * Phase 2. ALWAYS run `/skill:impeccable init`: it creates whatever of
 * PRODUCT.md / DESIGN.md is missing and reconciles existing files against the
 * discovery brief (without clobbering them). Best-effort: a headless / failed
 * init never blocks the workflow.
 */
export async function ensureProjectDesignContext(args: {
  readonly designContext: SetupDesignContext;
  readonly cwd: string;
  readonly prompt: string;
  readonly discoveryContext: string;
  readonly designModelConfig: SetupModelConfig;
}): Promise<ProjectDesignContextResult> {
  const before = detectDesignContextFiles(args.cwd);

  const init = await args.designContext
    .task("init", {
      prompt: buildInitPrompt({
        prompt: args.prompt,
        detection: before,
        discoveryContext: args.discoveryContext,
      }),
      ...args.designModelConfig,
    })
    .catch(() => undefined);

  const after = detectDesignContextFiles(args.cwd);
  const missingBefore = [
    before.hasProduct ? undefined : "PRODUCT.md",
    before.hasDesign ? undefined : "DESIGN.md",
  ]
    .filter((value): value is string => value !== undefined)
    .join(" and ");
  const statusBefore = before.hasBoth
    ? "reviewed existing PRODUCT.md + DESIGN.md against the brief"
    : `created missing ${missingBefore}`;
  return {
    initRan: true,
    detection: after,
    summary: [
      `Ran \`/skill:impeccable init\` (${statusBefore}).`,
      (init?.text ?? "").trim(),
      `Detected after init: PRODUCT.md=${after.productPath ?? "pending"}, DESIGN.md=${after.designPath ?? "pending"}.`,
    ]
      .filter((part) => part.length > 0)
      .join("\n\n"),
  };
}

// ---------------------------------------------------------------------------
// 2. Reference discovery
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
        "8. For on-brand fit, consult the project's DESIGN.md / PRODUCT.md on disk (see <design_context> for where they live); prefer references that fit, and flag any that would require departing from the project's system.",
        "9. If `playwright-cli` is unavailable or a site blocks automation, fall back to web search / page fetch to reach the actual design pages, and clearly mark any reference you could not capture with a recording or full-page screenshot.",
        "10. Never fabricate references or visual claims; if a gallery yielded nothing usable, say so.",
      ].join("\n"),
    ],
    [
      "output_format",
      [
        "Markdown sections:",
        "1. Curated references (table: Source gallery | Work (title/author) | Full page URL (destination) | Scroll-through video path | Full-page screenshot path | Transferable trait (incl. motion) | On-brand?)",
        "2. Synthesis: the 3-5 strongest directions to emulate for THIS design, ranked by fit, calling out motion/animation worth reproducing.",
        "3. What to avoid (anti-references observed on the real pages).",
        "4. Verification notes (which references have a scroll-through recording and/or full-page screenshot of the actual design page vs search-only).",
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
// 3. Live interactive QA prompt (shared by initial + per-iteration display)
// ---------------------------------------------------------------------------

/**
 * Build the interactive-QA prompt for the `preview-display-*` stages. Drives
 * `/skill:impeccable live` against the static preview so the user can pick
 * elements in the browser, annotate, and accept on-brand variants; degrades to
 * `playwright-cli show --annotate` and finally to a manual file path. The output
 * labels (`user_notes`, `annotated_snapshot`, `live_changes`) are parsed by the
 * refinement feedback threading.
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
