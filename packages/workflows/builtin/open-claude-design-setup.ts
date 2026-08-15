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
// 2. Live interactive QA prompt (the user-feedback review session)
// ---------------------------------------------------------------------------


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
 * Choices for the deterministic gate raised before the live review session.
 * The first entry starts the session; the second accepts the current design
 * and skips straight to export.
 */
export const LIVE_REVIEW_GATE_OPTIONS = [
  "Start live review",
  "Skip remaining review rounds and export as-is",
] as const;

/**
 * Message for the deterministic run-level prompt raised before the live
 * review session. The browser long-poll never sets `awaiting_input`, so
 * without this gate the run is indistinguishable from active compute while it
 * waits on a human (issue #2060). Raising a `ctx.ui` prompt sets the run-level
 * pending prompt, which fires the needs-attention badge and carries the
 * preview URL to the root session deterministically.
 */
export function buildLiveReviewGateMessage(args: {
  readonly round: number;
  readonly previewPath: string;
  readonly previewFileUrl: string;
}): string {
  return [
    `Design review session ${args.round} is ready for your browser review.`,
    "",
    `Preview file: ${args.previewPath}`,
    `Preview URL: ${args.previewFileUrl}`,
    "",
    `"${LIVE_REVIEW_GATE_OPTIONS[0]}" opens an interactive browser session; the session-start stage prints the live http:// review URL as soon as its server is up (attach with /workflow connect to see it, or open the preview URL above directly).`,
    "The session is unbounded: pick elements, accept variants, and steer for as long as you like, and everything you accept lands in the preview as you go.",
    "",
    "YOU end the review, and nothing else does. It keeps waiting through any amount of silence.",
    "End it by clicking exit in the Impeccable overlay, closing the browser tab, or saying \"exit live\".",
    "The moment you do, the design you are looking at is exported. There is no further round and no confirmation, so end the session only when the preview is what you want handed off.",
    `"${LIVE_REVIEW_GATE_OPTIONS[1]}" accepts the current design and proceeds to export without opening a session.`,
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
