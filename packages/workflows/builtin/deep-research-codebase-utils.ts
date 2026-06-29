import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative } from "node:path";
import type {
  WorkflowOutputMode,
  WorkflowTaskResult,
} from "../src/shared/types.js";

export const DEFAULT_MAX_PARTITIONS = 100;
export const DEFAULT_MAX_CONCURRENCY = 100;
const LOC_PER_PARTITION = 10_000;
const DEFAULT_RESEARCH_DOC_DIR = "research";
const DEEP_RESEARCH_RUN_DIR_PREFIX = ".deep-research-";
const MAX_RESEARCH_DOC_SLUG_LENGTH = 80;
const GIT_LS_FILES_TIMEOUT_MS = 2_000;

type PromptSection = readonly [tag: string, content: string];

export interface DeepResearchCodebaseResult {
  readonly result: string;
  readonly findings: string;
  readonly research_doc_path: string;
  readonly artifact_dir: string;
  readonly manifest_path: string;
  readonly partitions: string[];
  readonly explorer_count: number;
  readonly specialist_count: number;
  readonly max_concurrency: number;
  readonly history: string;
}

export const FILE_ONLY_OUTPUT = "file-only" satisfies WorkflowOutputMode;

export const PLANNER_MODEL_CONFIG = {
  model: "anthropic/claude-fable-5:xhigh",
  fallbackModels: [
    "openai-codex/gpt-5.5:xhigh",
    "github-copilot/gpt-5.5:xhigh",
    "openai/gpt-5.5:xhigh",
    "github-copilot/claude-opus-4.8 (1m):xhigh",
    "anthropic/claude-opus-4-8:xhigh",
    "zai/glm-5.2:xhigh",
    "zai-coding-cn/glm-5.2:xhigh",
    "github-copilot/gemini-3.5-flash (1m):high",
    "google/gemini-3.5-flash:high",
    "google-vertex/gemini-3.5-flash:high",
    "github-copilot/gemini-3.1-pro-preview (1m):high",
    "google/gemini-3.1-pro-preview:high",
    "google-vertex/gemini-3.1-pro-preview:high",
    "openrouter/openai/gpt-5.5:xhigh",
    "openrouter/anthropic/claude-opus-4-8:xhigh",
    "openrouter/z-ai/glm-5.2:xhigh",
    "openrouter/google/gemini-3.5-flash:high",
    "openrouter/google/gemini-3.1-pro-preview:high"

  ],
  excludedTools: ["ask_user_question"],
} as const;

export const EXPLORER_MODEL_CONFIG = {
  model: "openai-codex/gpt-5.4-mini:low",
  fallbackModels: [
    "github-copilot/gpt-5.4-mini:low",
    "openai/gpt-5.4-mini:low",
    "github-copilot/claude-haiku-4.5:low",
    "anthropic/claude-haiku-4-5:low",
    "github-copilot/gemini-3.5-flash (1m):low",
    "google/gemini-3.5-flash:low",
    "google-vertex/gemini-3.5-flash:low",
  ],
  excludedTools: ["ask_user_question"],
} as const;

export function fileOnlyOutput(output: string): {
  output: string;
  outputMode: WorkflowOutputMode;
} {
  return {
    output,
    outputMode: FILE_ONLY_OUTPUT,
  };
}

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

function countNewlineBytes(bytes: Uint8Array): number {
  let total = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 10) total += 1;
  }
  return total;
}

export function countCodebaseLines(cwd = process.cwd()): number {
  try {
    const gitFiles = Bun.spawnSync({
      cmd: ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
      stdout: "pipe",
      stderr: "pipe",
      cwd,
      timeout: GIT_LS_FILES_TIMEOUT_MS,
    });
    const files =
      gitFiles.success && gitFiles.stdout
        ? gitFiles.stdout
            .toString()
            .split("\n")
            .map((line) => line.replace(/\r$/, ""))
            .filter((line) => line.length > 0)
        : [];

    if (files.length === 0) return 0;

    let total = 0;
    for (const file of files) {
      try {
        total += countNewlineBytes(readFileSync(join(cwd, file)));
      } catch {
        // The line count is only a partition-sizing heuristic. Ignore files
        // that disappear, are unreadable, or are not regular files.
      }
    }
    return total;
  } catch {
    return 0;
  }
}

export function calculatePartitionCap(
  requestedMax: number,
  codebaseLines: number,
): number {
  if (!Number.isFinite(codebaseLines) || codebaseLines <= 0)
    return requestedMax;
  return Math.max(
    1,
    Math.min(requestedMax, Math.ceil(codebaseLines / LOC_PER_PARTITION)),
  );
}

export function parsePartitions(text: string, cap: number): string[] {
  const partitions = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length > 0 && !/^```/.test(line))
    .slice(0, cap);

  return partitions.length > 0 ? partitions : ["core codebase architecture"];
}

function slugifyResearchTopic(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_RESEARCH_DOC_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "deep-research-codebase";
}

export function defaultResearchDocPath(
  prompt: string,
  cwd = process.cwd(),
  now = new Date(),
): string {
  const date = now.toISOString().slice(0, 10);
  return join(
    cwd,
    DEFAULT_RESEARCH_DOC_DIR,
    `${date}-${slugifyResearchTopic(prompt)}.md`,
  );
}

function sanitizeRunId(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "run";
}

function timestampRunId(now: Date): string {
  return sanitizeRunId(now.toISOString().replace(/[:.]/g, "-"));
}

function suffixedPath(path: string, suffix: number): string {
  const extension = extname(path);
  const stem = extension.length === 0 ? path : path.slice(0, -extension.length);
  return `${stem}-${suffix}${extension}`;
}

function isFileExistsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { readonly code?: string }).code === "EEXIST"
  );
}

interface DeepResearchArtifactRoot {
  readonly runId: string;
  readonly artifactRoot: string;
}

export async function createArtifactRoot(
  startedAt: Date,
  cwd = process.cwd(),
): Promise<DeepResearchArtifactRoot> {
  const researchDocDir = join(cwd, DEFAULT_RESEARCH_DOC_DIR);
  await mkdir(researchDocDir, { recursive: true });
  const baseRunId = timestampRunId(startedAt);
  for (let suffix = 0; ; suffix += 1) {
    const runId = suffix === 0 ? baseRunId : `${baseRunId}-${suffix + 1}`;
    const artifactRoot = join(
      researchDocDir,
      `${DEEP_RESEARCH_RUN_DIR_PREFIX}${runId}`,
    );
    try {
      await mkdir(artifactRoot, { recursive: false });
      return { runId, artifactRoot };
    } catch (error) {
      if (isFileExistsError(error)) continue;
      throw error;
    }
  }
}

interface DeepResearchManifest {
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly researchQuestion: string;
  readonly finalAsset: string;
  readonly artifacts: Record<string, string>;
}

export async function writeManifest(
  path: string,
  manifest: DeepResearchManifest,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export async function writeResearchDoc(
  path: string,
  content: string,
): Promise<string> {
  await mkdir(dirname(path), { recursive: true });

  for (let suffix = 0; ; suffix += 1) {
    const candidate = suffix === 0 ? path : suffixedPath(path, suffix + 1);
    try {
      await writeFile(candidate, content, { encoding: "utf8", flag: "wx" });
      return candidate;
    } catch (error) {
      if (isFileExistsError(error)) continue;
      throw error;
    }
  }
}

export async function readArtifactText(
  path: string | undefined,
  fallback: string,
): Promise<string> {
  if (path === undefined) return fallback;
  try {
    return await readFile(path, "utf8");
  } catch {
    return fallback;
  }
}

export async function specialistHandoffFromArtifacts(
  partition: string,
  index: number,
  artifactPathsByStage: ReadonlyMap<string, string>,
): Promise<string> {
  const i = index + 1;
  const locator = await readArtifactText(
    artifactPathsByStage.get(`locator-${i}`),
    "(no locator output)",
  );
  const patterns = await readArtifactText(
    artifactPathsByStage.get(`pattern-finder-${i}`),
    "(no pattern output)",
  );
  const analyzer = await readArtifactText(
    artifactPathsByStage.get(`analyzer-${i}`),
    "(no analyzer output)",
  );
  const online = await readArtifactText(
    artifactPathsByStage.get(`online-${i}`),
    "(no online research output)",
  );
  return [
    `## Partition ${i}: ${partition}`,
    `### Locator\n${locator}`,
    `### Pattern Finder\n${patterns}`,
    `### Analyzer\n${analyzer}`,
    `### Online Researcher\n${online}`,
  ].join("\n\n");
}

export function manifestArtifactPaths(
  artifactPathsByStage: ReadonlyMap<string, string>,
  manifestPath: string,
  display: (path: string) => string,
): Record<string, string> {
  const artifacts: Record<string, string> = {};
  for (const [stage, path] of artifactPathsByStage) {
    artifacts[stage] = display(path);
  }
  artifacts.manifest = display(manifestPath);
  return artifacts;
}

export function findResult(
  results: readonly WorkflowTaskResult[],
  name: string,
): WorkflowTaskResult | undefined {
  return results.find(
    (result) => result.name === name || result.stageName === name,
  );
}

function displayPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function displayRelativePath(path: string, fromCwd: string): string {
  if (!isAbsolute(path)) return displayPath(path);
  const relativePath = relative(fromCwd, path);
  if (relativePath.length === 0) return ".";
  if (!relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return displayPath(relativePath);
  }
  return displayPath(path);
}

