import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { WorkflowTaskResult } from "../src/shared/types.js";


export const OUTPUT_TYPES = [
  "prototype",
  "wireframe",
  "page",
  "component",
  "theme",
  "tokens",
] as const;
export type OutputType = (typeof OUTPUT_TYPES)[number];
export const DEFAULT_OUTPUT_TYPE: OutputType = "prototype";
export const DEFAULT_MAX_REFINEMENTS = 3;

/**
 * Read-only builtin tools granted to the structured-decision stages
 * (user-feedback refinement gate and pre-export gate) so they can actually
 * inspect the on-disk `preview.html` before emitting their decision. The
 * artifact stays immutable here — writes/edits belong to apply-changes and
 * forced-fix, so this list deliberately excludes write/edit/bash.
 */
export const READ_ONLY_TOOLS = ["read", "grep", "ls"] as const;

type PromptSection = readonly [tag: string, content: string];

export function taggedPrompt(sections: readonly PromptSection[]): string {
  return sections
    .map(([tag, content]) => {
      const trimmed = content.trim();
      return `<${tag}>\n${trimmed}\n</${tag}>`;
    })
    .join("\n\n");
}

export function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function normalizeOutputType(value: string | undefined): OutputType {
  return value !== undefined &&
    (OUTPUT_TYPES as readonly string[]).includes(value)
    ? (value as OutputType)
    : DEFAULT_OUTPUT_TYPE;
}

export function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export function isFileLike(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && !isUrl(trimmed);
}

export type RefinementDecision = {
  readonly ready_for_export: boolean;
  readonly rationale: string;
  readonly required_changes: readonly string[];
};

export type ExportGateFinding = {
  readonly finding: string;
  readonly evidence: string;
  readonly why_blocking: string;
  readonly must_fix_action: string;
  readonly severity: "P0";
};

export type ExportGateDecision = {
  readonly has_blocking_findings: boolean;
  readonly rationale: string;
  readonly blocking_findings: readonly ExportGateFinding[];
};

export const refinementDecisionSchema = Type.Object(
  {
    ready_for_export: Type.Boolean(),
    rationale: Type.String(),
    required_changes: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

const exportGateFindingSchema = Type.Object(
  {
    finding: Type.String(),
    evidence: Type.String(),
    why_blocking: Type.String(),
    must_fix_action: Type.String(),
    severity: Type.Literal("P0"),
  },
  { additionalProperties: false },
);

export const exportGateDecisionSchema = Type.Object(
  {
    has_blocking_findings: Type.Boolean(),
    rationale: Type.String(),
    blocking_findings: Type.Array(exportGateFindingSchema),
  },
  { additionalProperties: false },
);

export function refinementDecisionFromResult(result: WorkflowTaskResult): RefinementDecision {
  const decision = result.structured as RefinementDecision | undefined;
  if (!decision) {
    throw new Error("open-claude-design refinement decision missing structured result.");
  }
  return decision;
}

export function exportGateDecisionFromResult(result: WorkflowTaskResult): ExportGateDecision {
  const decision = result.structured as ExportGateDecision | undefined;
  if (!decision) {
    throw new Error("open-claude-design export gate decision missing structured result.");
  }
  return decision;
}

export type DiscoveryDecision = {
  readonly brief: string;
  readonly output_type: OutputType;
  readonly references: readonly string[];
};

export const discoveryDecisionSchema = Type.Object(
  {
    brief: Type.String(),
    output_type: Type.Union([...OUTPUT_TYPES].map((value) => Type.Literal(value))),
    references: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

/**
 * Parse the discovery stage's structured result, tolerating a missing/invalid
 * structured payload (headless / mock runs) by falling back to the raw prompt as
 * the brief, the default output type, and an empty reference list.
 */
export function discoveryDecisionFromResult(
  result: WorkflowTaskResult,
  fallbackBrief: string,
): DiscoveryDecision {
  const decision = result.structured as Partial<DiscoveryDecision> | undefined;
  const brief =
    typeof decision?.brief === "string" && decision.brief.trim().length > 0
      ? decision.brief.trim()
      : fallbackBrief;
  const references = Array.isArray(decision?.references)
    ? decision.references
        .filter((ref): ref is string => typeof ref === "string")
        .map((ref) => ref.trim())
        .filter((ref) => ref.length > 0)
    : [];
  return {
    brief,
    output_type: normalizeOutputType(decision?.output_type),
    references,
  };
}

export function joinResults(results: readonly WorkflowTaskResult[]): string {
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
export function prepareArtifactDir(cwd = process.cwd()): {
  readonly runId: string;
  readonly artifactDir: string;
  readonly previewPath: string;
  readonly specPath: string;
} {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
  // Under automated tests, prefer the OS tmpdir so a full `d.run()` does not
  // pollute the project's `specs/design/` tree with per-run artifact folders.
  const candidates =
    process.env.NODE_ENV === "test"
      ? [join(tmpdir(), "open-claude-design", runId)]
      : [
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

export const HTML_PREVIEW_RULES = [
  "Produce a single self-contained HTML document. Inline all CSS in a <style> block and inline any JS in a <script> block; no external network requests except Google Fonts when explicitly required.",
  "Embed realistic content that respects the design brief — no Lorem ipsum, no obvious placeholders.",
  "Implement responsive behavior with sensible breakpoints (use container queries or media queries) so the file renders well from 360px up to 1440px.",
  "Cover at minimum: default state, hover/focus state for every interactive element, empty state if relevant, loading state if relevant, error state if relevant.",
  "Use accessible markup: semantic landmarks, labeled form controls, sufficient contrast (WCAG AA), visible focus styles, prefers-reduced-motion respected.",
  "Annotate the file with HTML comments that mark sections, states, and design-system token references so engineers can read the intent quickly.",
].join("\n");

export const ANTI_SLOP_RULES = [
  "Do not produce generic AI-slop palettes (purple/indigo gradients, blue-to-pink, neon glassmorphism stacks, nested card grids).",
  "Avoid the AI design clichés impeccable's anti-pattern catalog calls out: gradient text for emphasis, side-tab borders, three-font headers, decorative shadows on flat-by-default systems.",
  "Commit to a specific aesthetic direction; do not hedge with generic SaaS defaults.",
].join("\n");

/** Reference-import precedence note shared by import, generation, and refinement. */
export const REFERENCE_PRECEDENCE =
  "User-provided references in <reference_context> are the PRIMARY visual authority: when they conflict with DESIGN.md/PRODUCT.md, follow the references. DESIGN.md governs decisions the references do not cover; PRODUCT.md still governs strategic register/voice.";

export type PlaywrightCliStatus = {
  /** Whether the `playwright-cli` command is expected to be available to downstream stages. */
  readonly available: boolean;
  /** True when the command was already on PATH and no install was attempted. */
  readonly alreadyPresent: boolean;
  /** True when this step installed the command via `npm install -g @playwright/cli@latest`. */
  readonly installed: boolean;
  /** Human-readable, single-line outcome surfaced as a workflow output. */
  readonly summary: string;
  /** Raw failure reason when the install could not complete; absent on success. */
  readonly error?: string;
};

/**
 * Initial deterministic setup step (no LLM): ensure the playwright-cli skill's
 * `playwright-cli` command is available before any design stage runs. Mirrors the
 * playwright-cli skill's documented bootstrap (`npx --no-install playwright-cli
 * --version` || `npm install -g @playwright/cli@latest`) but performs it once,
 * deterministically, instead of relying on each stage to probe/install it.
 * The PATH probe always runs, but the actual global install is skipped under
 * automated tests (`NODE_ENV=test`) to avoid slow, networked, environment-
 * mutating side effects.
 *
 * Best-effort by contract: it never throws and never blocks the workflow. When
 * the command cannot be located or installed, downstream stages keep their graceful
 * degradation path (surface the manual preview path / URL).
 */
export function ensurePlaywrightCli(): PlaywrightCliStatus {
  const isWindows = process.platform === "win32";
  const onPath = (): boolean => {
    try {
      const probe = spawnSync(isWindows ? "where" : "which", ["playwright-cli"], {
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
      summary: "playwright-cli already on PATH; skipped install.",
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
        "playwright-cli not found; skipped global install under the test environment.",
      error: "global install skipped during tests",
    };
  }

  try {
    const install = spawnSync("npm", ["install", "-g", "@playwright/cli@latest"], {
      stdio: "ignore",
      timeout: 180_000,
      shell: isWindows,
    });
    if (install.status === 0) {
      return {
        available: true,
        alreadyPresent: false,
        installed: true,
        summary: "Installed playwright-cli via `npm install -g @playwright/cli@latest`.",
      };
    }
    const reason =
      install.error?.message ??
      (typeof install.status === "number"
        ? `npm install -g @playwright/cli@latest exited with code ${install.status}`
        : "npm install -g @playwright/cli@latest did not complete");
    return {
      available: false,
      alreadyPresent: false,
      installed: false,
      summary: `Could not install playwright-cli (${reason}); stages will degrade gracefully.`,
      error: reason,
    };
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error);
    return {
      available: false,
      alreadyPresent: false,
      installed: false,
      summary: `Could not install playwright-cli (${reason}); stages will degrade gracefully.`,
      error: reason,
    };
  }
}

/**
 * Build the per-run browser bootstrap guidance injected into stage prompts.
 * When the deterministic setup step already ensured `playwright-cli` is installed,
 * the guidance tells stages to assume availability and not waste turns
 * reinstalling; otherwise it retains the original probe-and-install fallback.
 */
export function buildPlaywrightCliBootstrapRules(status: PlaywrightCliStatus): string {
  const probeRule = status.available
    ? "The workflow's deterministic setup step already ensured the playwright-cli skill's `playwright-cli` command is installed and on PATH; assume it is available and do NOT reinstall it. Only if a `playwright-cli` command reports it is missing should you re-probe with `which playwright-cli` (or `npx --no-install playwright-cli --version`) and run `npm install -g @playwright/cli@latest` once before retrying. Do not add project dependencies."
    : `The workflow's deterministic setup step attempted to install the playwright-cli skill's \`playwright-cli\` command but it FAILED with: "${status.error ?? "unknown error"}". Treat this as a known starting condition to work around, not a hard blocker. Probe with \`which playwright-cli\` (or \`npx --no-install playwright-cli --version\`) and retry once with \`npm install -g @playwright/cli@latest\`; if it still fails, use the error above to diagnose a workaround (for example: EACCES/permission errors → retry with a user-writable global prefix; missing npm/Node → report it plainly; network/registry errors → surface them). If the command still cannot be made available, degrade gracefully and surface the manual file path / URL. Do not add project dependencies.`;
  return [
    probeRule,
    "Use `playwright-cli open <url>` when a generated local preview should be visible to the user, and use `playwright-cli snapshot` plus `playwright-cli screenshot --filename=<file>` for review evidence.",
    "If a `playwright-cli` command reports a missing browser executable, install the browser once with `npx playwright install chromium` and retry.",
    "If `playwright-cli` is unavailable after three attempts or the browser runtime still fails, degrade gracefully and surface the manual file path / URL.",
  ].join("\n");
}

