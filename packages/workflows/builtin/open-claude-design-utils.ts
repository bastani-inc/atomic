import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
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

/**
 * Whether the browser-centric workflow should exit early instead of generating
 * artifacts no one can review interactively. True only when the playwright-cli
 * browser is unavailable AND we are not under the test harness (`NODE_ENV=test`,
 * which always skips the global install and runs headlessly to completion).
 */
export function shouldEarlyExitForBrowser(
  browserAvailable: boolean,
  nodeEnv: string | undefined,
): boolean {
  return !browserAvailable && nodeEnv !== "test";
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
 * Per-user tmpdir base for run artifacts. Namespacing by username avoids
 * EACCES collisions on shared hosts where another user already owns a plain
 * `<tmpdir>/open-claude-design` directory.
 */
function tmpArtifactBase(): string {
  let user = "default";
  try {
    user = userInfo().username.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  } catch {
    // keep the "default" namespace when the username is unavailable
  }
  return join(tmpdir(), `open-claude-design-${user}`);
}

/**
 * Compute (and best-effort create) a per-run artifact directory.
 * Prefers `<cwd>/.atomic/workflows/open-claude-design/<runId>` so the artifacts
 * stay next to the project and are discoverable by pi. Falls back to a
 * per-user OS tmpdir when the project tree is not writable (CI sandboxes,
 * mocks, etc.).
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
  const tmpCandidates = [
    join(tmpArtifactBase(), runId),
    join(tmpdir(), "open-claude-design", runId),
  ];
  const candidates =
    process.env.NODE_ENV === "test"
      ? tmpCandidates
      : [join(cwd, "specs", "design", runId), ...tmpCandidates];
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
  const fallback = join(tmpArtifactBase(), runId);
  return {
    runId,
    artifactDir: fallback,
    previewPath: join(fallback, "preview.html"),
    specPath: join(fallback, "spec.html"),
  };
}

export const HTML_PREVIEW_RULES = [
  "Produce one self-contained HTML document: inline CSS in <style> and JS in <script>; make no external requests except explicitly required Google Fonts.",
  "Use realistic brief-specific content, not Lorem ipsum or obvious placeholders.",
  "Render well from 360px to 1440px with sensible container or media-query breakpoints.",
  "Include default and hover/focus states for every interactive element, plus empty, loading, and error states where relevant.",
  "Use semantic landmarks, labeled controls, WCAG AA contrast, visible focus, and prefers-reduced-motion.",
  "Add HTML comments marking sections, states, and design-system token references for engineering handoff.",
].join("\n");

export const ANTI_SLOP_RULES = [
  "Avoid generic AI palettes and structures: purple/indigo or blue-to-pink gradients, neon glassmorphism stacks, and nested card grids.",
  "Avoid impeccable catalog clichés: gradient emphasis text, side-tab borders, three-font headers, and decorative shadows in flat-by-default systems.",
  "Commit to a specific aesthetic rather than generic SaaS defaults.",
].join("\n");

/** Reference-import precedence note shared by import, generation, and refinement. */
export const REFERENCE_PRECEDENCE =
  "User references in <reference_context> are the PRIMARY visual authority and override conflicting DESIGN.md/PRODUCT.md guidance. DESIGN.md governs uncovered design decisions; PRODUCT.md still governs strategic register/voice.";

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

/** Build browser guidance for downstream stage prompts. */
export function buildPlaywrightCliBootstrapRules(status: PlaywrightCliStatus): string {
  const probeRule = status.available
    ? "The playwright-cli skill's `playwright-cli` command is on PATH. Do not reinstall it unless a command reports it missing; then probe with `which playwright-cli` (or `npx --no-install playwright-cli --version`), run `npm install -g @playwright/cli@latest` once, and retry. Do not add project dependencies."
    : `The playwright-cli skill's \`playwright-cli\` command failed setup: "${status.error ?? "unknown error"}". Probe with \`which playwright-cli\` (or \`npx --no-install playwright-cli --version\`) and retry once with \`npm install -g @playwright/cli@latest\`. For permission errors, use a user-writable global prefix; report missing npm/Node or network/registry errors plainly. If still unavailable, surface the manual file path / URL. Do not add project dependencies.`;
  return [
    probeRule,
    "Use `playwright-cli open <url>` to show a local preview; use `playwright-cli snapshot` and `playwright-cli screenshot --filename=<file>` for review evidence.",
    "If a `playwright-cli` command reports a missing browser executable, run `npx playwright install chromium` once and retry.",
    "If `playwright-cli` is unavailable after three attempts or the browser runtime still fails, surface the manual file path / URL.",
  ].join("\n");
}

