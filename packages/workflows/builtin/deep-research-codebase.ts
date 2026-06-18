/**
 * Builtin workflow: deep-research-codebase
 *
 * Re-implements the Atomic SDK builtin topology with the pi workflow task
 * primitives: scout + research-history chain, two parallel specialist waves,
 * and a final aggregator. The local SDK does not expose Atomic's Claude-only
 * callback stage API, so the workflow models that design with ctx.task(),
 * ctx.parallel(), and ctx.chain().
 */

import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative } from "node:path";
import { defineWorkflow } from "../src/workflows/define-workflow.js";
import { Type } from "typebox";
import type {
  WorkflowOutputMode,
  WorkflowTaskResult,
  WorkflowTaskStep,
} from "../src/shared/types.js";

const DEFAULT_MAX_PARTITIONS = 100;
const DEFAULT_MAX_CONCURRENCY = 100;
const LOC_PER_PARTITION = 10_000;
const DEFAULT_RESEARCH_DOC_DIR = "research";
const DEEP_RESEARCH_RUN_DIR_PREFIX = ".deep-research-";
const MAX_RESEARCH_DOC_SLUG_LENGTH = 80;
const GIT_LS_FILES_TIMEOUT_MS = 2_000;

type PromptSection = readonly [tag: string, content: string];

interface DeepResearchCodebaseResult {
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

const FILE_ONLY_OUTPUT = "file-only" satisfies WorkflowOutputMode;

function taggedPrompt(sections: readonly PromptSection[]): string {
  return sections
    .map(([tag, content]) => {
      const trimmed = content.trim();
      return `<${tag}>\n${trimmed}\n</${tag}>`;
    })
    .join("\n\n");
}

function positiveInteger(value: number | undefined, fallback: number): number {
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

function countCodebaseLines(cwd = process.cwd()): number {
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

function calculatePartitionCap(
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

function parsePartitions(text: string, cap: number): string[] {
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

function defaultResearchDocPath(
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

async function createArtifactRoot(
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

async function writeManifest(
  path: string,
  manifest: DeepResearchManifest,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function writeResearchDoc(
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

async function readArtifactText(
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

async function specialistHandoffFromArtifacts(
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

function manifestArtifactPaths(
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

function findResult(
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

function displayRelativePath(path: string, fromCwd: string): string {
  if (!isAbsolute(path)) return displayPath(path);
  const relativePath = relative(fromCwd, path);
  if (relativePath.length === 0) return ".";
  if (!relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return displayPath(relativePath);
  }
  return displayPath(path);
}

export default defineWorkflow("deep-research-codebase")
  .description(
    "Scout + research-history chain → parallel specialist waves → aggregator for deep codebase research.",
  )
  .input("prompt", Type.String({ description: "Research question or investigation focus for the codebase." }))
  .input("max_partitions", Type.Number({
    default: DEFAULT_MAX_PARTITIONS,
    description:
      "Maximum number of codebase partitions to explore in parallel. Actual partitions scale by one per 10K LoC, capped by this value.",
  }))
  .input("max_concurrency", Type.Number({
    default: DEFAULT_MAX_CONCURRENCY,
    description: "Maximum number of workflow stages to run concurrently during deep research.",
  }))
  .output("result", Type.Optional(Type.String({ description: "Final Markdown research report text, matching findings." })))
  .output("findings", Type.Optional(Type.String({ description: "Final Markdown research report text." })))
  .output("research_doc_path", Type.Optional(Type.String({ description: "Public report path under research/<date>-<topic>.md." })))
  .output("artifact_dir", Type.Optional(Type.String({ description: "Hidden per-run handoff directory containing deep-research artifacts." })))
  .output("manifest_path", Type.Optional(Type.String({ description: "Manifest JSON path inside the hidden artifact directory." })))
  .output("partitions", Type.Optional(Type.Array(Type.String(), { description: "Codebase partitions the specialists explored." })))
  .output("explorer_count", Type.Optional(Type.Number({ description: "Number of partition explorer groups used." })))
  .output("specialist_count", Type.Optional(Type.Number({ description: "Number of specialist stages run across the research waves." })))
  .output("max_concurrency", Type.Optional(Type.Number({ description: "Concurrency limit used for the run." })))
  .output("history", Type.Optional(Type.String({ description: "Prior-research/history overview included in the final synthesis." })))
  .run(async (ctx) => {
    const inputs = ctx.inputs;
    const prompt = inputs.prompt;
    const requestedMaxPartitions = positiveInteger(
      inputs.max_partitions,
      DEFAULT_MAX_PARTITIONS,
    );
    const maxConcurrency = positiveInteger(
      inputs.max_concurrency,
      DEFAULT_MAX_CONCURRENCY,
    );
    const startedAt = new Date();
    const workflowCwd = ctx.cwd ?? process.cwd();
    const finalResearchDocPath = defaultResearchDocPath(prompt, workflowCwd, startedAt);
    const codebaseLines = countCodebaseLines(workflowCwd);
    const partitionCap = calculatePartitionCap(
      requestedMaxPartitions,
      codebaseLines,
    );
    const { runId, artifactRoot } = await createArtifactRoot(startedAt, workflowCwd);
    const artifactPathsByStage = new Map<string, string>();
    const addArtifact = (stage: string, path: string) => {
      artifactPathsByStage.set(stage, path);
      return path;
    };
    const fileOnlyOutput = (
      output: string,
    ): {
      output: string;
      outputMode: WorkflowOutputMode;
    } => ({
      output,
      outputMode: FILE_ONLY_OUTPUT,
    });
    const displayWorkflowPath = (path: string): string =>
      displayRelativePath(path, workflowCwd);
    const displayWorkflowPaths = (paths: readonly string[]): string =>
      paths.map(displayWorkflowPath).join(", ");

    const scoutPath = addArtifact(
      "codebase-scout",
      join(artifactRoot, "00-codebase-scout.md"),
    );
    const partitionPlanPath = addArtifact(
      "partition",
      join(artifactRoot, "01-partition-plan.md"),
    );
    const historyLocatorPath = addArtifact(
      "history-locator",
      join(artifactRoot, "01-history-locator.md"),
    );
    const historyAnalyzerPath = addArtifact(
      "history-analyzer",
      join(artifactRoot, "02-history-analyzer.md"),
    );

    const plannerModelConfig = {
      model: "anthropic/claude-fable-5:xhigh",
      fallbackModels: [
        "openai-codex/gpt-5.5:xhigh",
        "github-copilot/gpt-5.5:xhigh",
        "openai/gpt-5.5:xhigh",
        "github-copilot/claude-opus-4.8 (1m):xhigh",
        "anthropic/claude-opus-4-8:xhigh"
      ],
      excludedTools: ["ask_user_question"],
    };

    const explorerModelConfig = {
      model: "openai-codex/gpt-5.4-mini:low",
      fallbackModels: [
        "github-copilot/gpt-5.4-mini:low",
        "openai/gpt-5.4-mini:low",
        "github-copilot/claude-haiku-4.5:low",
        "anthropic/claude-haiku-4-5:low",
      ],
      excludedTools: ["ask_user_question"],
    };

    const initialDiscovery = await ctx.parallel(
      [
        {
          name: "codebase-scout",
          task: taggedPrompt([
            [
              "role",
              "You are a senior codebase research scout preparing work for specialist agents.",
            ],
            ["objective", `Map the repository using parallel codebase-locator, codebase-analyzer, and codebase-pattern-finder subagents. Research question: ${prompt}`],
            [
              "instructions",
              [
                "Identify the subsystems, files, tests, docs, and runtime/configuration areas most likely to answer the question.",
                `Propose at most ${partitionCap} independent investigation partitions that can be assigned to parallel specialists.`,
                "Ground codebase claims in concrete paths, symbols, commands, or docs when possible.",
                "If evidence is missing or uncertain, say so explicitly instead of guessing.",
              ].join("\n"),
            ],
            [
              "output_format",
              [
                "Markdown with these headings:",
                "1. Executive orientation",
                "2. Key paths and why they matter",
                "3. Suggested partitions",
                "4. Known unknowns / risks",
              ].join("\n"),
            ],
          ]),
          ...fileOnlyOutput(scoutPath),
          ...plannerModelConfig,
        },
        {
          name: "history-locator",
          task: taggedPrompt([
            ["role", "You locate prior project research and decision history."],
            [
              "objective",
              "Find existing docs, specs, ADRs, issues/PR notes, TODOs, and research artifacts relevant to the task using parallel codebase-research-locator subagents.",
            ],
            ["task", "{task}"],
            [
              "instructions",
              [
                "Search broadly before narrowing.",
                "Prefer exact file paths, section names, and short relevance notes.",
                "Separate strong evidence from weak/possibly stale evidence.",
                "If no prior research exists, state that plainly and list where you looked.",
              ].join("\n"),
            ],
            [
              "output_format",
              "A markdown table with columns: Path, Evidence, Relevance, Confidence.",
            ],
          ]),
          ...fileOnlyOutput(historyLocatorPath),
          ...explorerModelConfig,
        },
      ],
      { task: prompt, concurrency: maxConcurrency },
    );

    const scout =
      findResult(initialDiscovery, "codebase-scout") ?? initialDiscovery[0]!;
    const historyLocator =
      findResult(initialDiscovery, "history-locator") ?? initialDiscovery[1]!;
    await ctx.chain(
      [
        {
          name: "history-analyzer",
          task: taggedPrompt([
            [
              "role",
              "You synthesize prior project research for downstream investigators.",
            ],
            [
              "objective",
              `Extract reusable historical context using parallel codebase-research-analyzer subagents. Research question: ${prompt}`,
            ],
            ["prior_research_locator_output", "{previous}"],
            [
              "instructions",
              [
                "Cluster related prior decisions and unresolved questions.",
                "Identify which findings are still likely valid and which may be stale.",
                "Quote or cite paths from the locator output for every important claim.",
                "Do not invent history that is not supported by the locator output.",
              ].join("\n"),
            ],
            [
              "output_format",
              [
                "Markdown with headings:",
                "1. Prior decisions",
                "2. Relevant research artifacts",
                "3. Open questions",
                "4. How this should steer the new investigation",
              ].join("\n"),
            ],
          ]),
          previous: historyLocator,
          reads: [historyLocatorPath],
          ...fileOnlyOutput(historyAnalyzerPath),
          ...plannerModelConfig,
        },
      ],
      { task: prompt },
    );

    const partitionPlan = await ctx.task("partition", {
      prompt: taggedPrompt([
        ["role", "You turn scout research into clean work partitions."],
        [
          "objective",
          `Return at most ${partitionCap} independent partitions for this research question: ${prompt}. Use parallel codebase-locator, codebase-analyzer, and codebase-pattern-finder subagents.`,
        ],
        ["scout_output", "{previous}"],
        [
          "instructions",
          [
            "Each partition must be concrete enough for one specialist to investigate independently.",
            "Prefer boundaries based on files, subsystems, runtime layers, or documented concepts.",
            "Do not include bullets, numbering, markdown fences, explanations, or duplicate partitions.",
          ].join("\n"),
        ],
        ["output_format", "Plain text only: one partition per line."],
      ]),
      previous: scout,
      output: partitionPlanPath,
      reads: [scoutPath],
      ...plannerModelConfig,
    });

    const partitions = parsePartitions(partitionPlan.text, partitionCap);
    const locatorArtifactPaths = new Map<number, string>();

    const wave1Steps: WorkflowTaskStep[] = partitions.flatMap(
      (partition, index) => {
        const i = index + 1;
        const locatorPath = addArtifact(
          `locator-${i}`,
          join(artifactRoot, `locator-${i}.md`),
        );
        const patternFinderPath = addArtifact(
          `pattern-finder-${i}`,
          join(artifactRoot, `pattern-finder-${i}.md`),
        );
        locatorArtifactPaths.set(i, locatorPath);
        return [
          {
            name: `locator-${i}`,
            task: taggedPrompt([
              ["role", "You are a codebase locator specialist."],
              ["assignment", `Partition ${i}/${partitions.length}: ${partition}`],
              ["research_question", prompt],
              [
                "scout_context",
                `Read the scout artifact before making evidence claims: ${displayWorkflowPath(scoutPath)}\nCompact saved-output reference: {previous}`,
              ],
              [
                "instructions",
                [
                  "Find the highest-signal files, tests, docs, commands, configs, and symbols for this partition.",
                  "Use parallel codebase-locator subagents to explore different areas of the partition.",
                  "Explain why each path matters for the research question.",
                  "Prioritize exact paths and symbol names over broad descriptions.",
                  "Flag areas that look relevant but could not be verified.",
                ].join("\n"),
              ],
              [
                "output_format",
                [
                  "Markdown with headings:",
                  "1. Must-read paths",
                  "2. Supporting paths",
                  "3. Entry points / symbols",
                  "4. Gaps or uncertainty",
                ].join("\n"),
              ],
            ]),
            previous: scout,
            reads: [scoutPath],
            ...fileOnlyOutput(locatorPath),
            ...explorerModelConfig,
          },
          {
            name: `pattern-finder-${i}`,
            task: taggedPrompt([
              ["role", "You are a codebase pattern-finding specialist."],
              ["assignment", `Partition ${i}/${partitions.length}: ${partition}`],
              ["research_question", prompt],
              [
                "scout_context",
                `Read the scout artifact before making evidence claims: ${displayWorkflowPath(scoutPath)}\nCompact saved-output reference: {previous}`,
              ],
              [
                "instructions",
                [
                  "Identify recurring implementation patterns, abstractions, naming conventions, and anti-patterns in this partition using parallel codebase-pattern-finder subagents.",
                  "Use concrete examples with paths, symbols, or test names.",
                  "Distinguish established conventions from one-off implementation details.",
                  "Avoid generic advice that is not grounded in the repository.",
                ].join("\n"),
              ],
              [
                "output_format",
                [
                  "Markdown with headings:",
                  "1. Established patterns",
                  "2. Variations / exceptions",
                  "3. Anti-patterns or risks",
                  "4. Evidence index",
                ].join("\n"),
              ],
            ]),
            previous: scout,
            reads: [scoutPath],
            ...fileOnlyOutput(patternFinderPath),
            ...explorerModelConfig,
          },
        ];
      },
    );

    const wave1 = await ctx.parallel(wave1Steps, {
      task: prompt,
      concurrency: maxConcurrency,
    });

    const wave2Steps: WorkflowTaskStep[] = partitions.flatMap(
      (partition, index) => {
        const i = index + 1;
        const locator = findResult(wave1, `locator-${i}`);
        const locatorPath =
          locator === undefined ? undefined : locatorArtifactPaths.get(i);
        const analyzerReads =
          locatorPath === undefined ? [scoutPath] : [scoutPath, locatorPath];
        const onlineResearcherReads =
          locatorPath === undefined ? [scoutPath] : [locatorPath];
        const onlineResearcherLocalContext =
          locatorPath === undefined
            ? `Read scout context before researching: ${displayWorkflowPath(scoutPath)}\nCompact saved-output reference: {previous}`
            : `Read local artifact context before researching: ${displayWorkflowPath(locatorPath)}\nCompact saved-output reference: {previous}`;
        const analyzerPath = addArtifact(
          `analyzer-${i}`,
          join(artifactRoot, `analyzer-${i}.md`),
        );
        const onlineResearcherPath = addArtifact(
          `online-${i}`,
          join(artifactRoot, `online-${i}.md`),
        );
        return [
          {
            name: `analyzer-${i}`,
            task: taggedPrompt([
              ["role", "You are a codebase behavior and architecture analyzer."],
              ["assignment", `Partition ${i}/${partitions.length}: ${partition}`],
              ["research_question", prompt],
              [
                "context",
                `Read these artifacts before analyzing: ${displayWorkflowPaths(analyzerReads)}\nCompact saved-output reference: {previous}`,
              ],
              [
                "instructions",
                [
                  "Analyze behavior, control flow, data flow, lifecycle, error handling, and test coverage for this partition using parallel codebase-analyzer subagents.",
                  "Build on the locator output; do not repeat file discovery except where needed as evidence.",
                  "Call out edge cases, invariants, and coupling to other partitions.",
                  "If evidence is incomplete, explain what remains unknown and how to verify it.",
                ].join("\n"),
              ],
              [
                "output_format",
                [
                  "Markdown with headings:",
                  "1. Behavioral model",
                  "2. Key flows and invariants",
                  "3. Tests / validation",
                  "4. Risks, unknowns, and verification steps",
                ].join("\n"),
              ],
            ]),
            previous: locator === undefined ? scout : [scout, locator],
            reads: analyzerReads,
            ...fileOnlyOutput(analyzerPath),
            ...explorerModelConfig,
          },
          {
            name: `online-researcher-${i}`,
            task: taggedPrompt([
              [
                "role",
                "You are an ecosystem and documentation research specialist.",
              ],
              ["assignment", `Partition ${i}/${partitions.length}: ${partition}`],
              ["research_question", prompt],
              ["local_context", onlineResearcherLocalContext],
              [
                "instructions",
                [
                  "Identify external library/framework behavior, standards, or docs that materially affect the local interpretation.",
                  "Use parallel codebase-online-researcher subagents to explore different angles of external research.",
                  "Cite sources, package names, API names, versions, or documentation titles when available.",
                  "Explain how each external fact applies to this repository.",
                  "If external research is unnecessary or unavailable, say so and focus on local implications.",
                ].join("\n"),
              ],
              [
                "output_format",
                [
                  "Markdown with headings:",
                  "1. Relevant external facts",
                  "2. Local implications",
                  "3. Version/API assumptions",
                  "4. Unverified or unnecessary research",
                ].join("\n"),
              ],
            ]),
            previous: locator === undefined ? scout : locator,
            reads: onlineResearcherReads,
            ...fileOnlyOutput(onlineResearcherPath),
            ...explorerModelConfig,
          },
        ];
      },
    );

    const wave2 = await ctx.parallel(wave2Steps, {
      task: prompt,
      concurrency: maxConcurrency,
    });
    const historyOverview = await readArtifactText(historyAnalyzerPath, "");
    const explorerPaths = await Promise.all(
      partitions.map(async (partition, index) => {
        const i = index + 1;
        const explorerPath = addArtifact(
          `explorer-${i}`,
          join(artifactRoot, `explorer-${i}.md`),
        );
        const explorer = await specialistHandoffFromArtifacts(
          partition,
          index,
          artifactPathsByStage,
        );
        await writeFile(explorerPath, explorer, "utf8");
        return explorerPath;
      }),
    );
    const aggregatorReadPaths = [
      scoutPath,
      partitionPlanPath,
      ...(historyOverview === "" ? [] : [historyAnalyzerPath]),
      ...explorerPaths,
    ];

    const aggregate = await ctx.task("aggregator", {
      prompt: taggedPrompt([
        ["role", "You are the final deep-research aggregator."],
        ["objective", `Answer the research question comprehensively: ${prompt}`],
        [
          "context_artifacts",
          [
            `Read the scout artifact at ${displayWorkflowPath(scoutPath)}.`,
            `Read the partition plan artifact at ${displayWorkflowPath(partitionPlanPath)}.`,
            historyOverview === ""
              ? "No prior research overview artifact is available."
              : `Read the prior research overview artifact at ${displayWorkflowPath(historyAnalyzerPath)}.`,
          ].join("\n"),
        ],
        [
          "prior_research_overview",
          historyOverview === ""
            ? "(no prior research found)"
            : `Read the prior research overview artifact at ${displayWorkflowPath(historyAnalyzerPath)}.`,
        ],
        [
          "specialist_reports",
          `Read the complete explorer handoff artifact(s) at ${displayWorkflowPaths(explorerPaths)}. They preserve every partition's Locator, Pattern Finder, Analyzer, and Online Researcher output from the original inline specialist handoff while keeping this prompt bounded.`,
        ],
        [
          "instructions",
          [
            "Synthesize; do not merely concatenate specialist reports.",
            "Use the supplied input files as the source of detailed scout, partition, history, and specialist evidence instead of relying on inline transcripts.",
            "Prioritize claims supported by concrete paths, symbols, tests, docs, or cited external references.",
            "Resolve contradictions explicitly and preserve important uncertainty.",
            "Avoid inventing facts not supported by the supplied reports; state unknowns instead.",
            "Use parallel codebase-analyzer, codebase-research-analyzer, and codebase-online-researcher subagents as needed to verify claims or fill critical gaps in the supplied reports.",
            "End with actionable next steps for a developer who will use this research.",
          ].join("\n"),
        ],
        [
          "output_format",
          [
            "Markdown with headings:",
            "1. Executive answer",
            "2. Architecture / behavior findings",
            "3. Evidence by partition",
            "4. Risks and unknowns",
            "5. Recommended next steps",
          ].join("\n"),
        ],
      ]),
      reads: aggregatorReadPaths,
      ...explorerModelConfig,
    });

    const writtenResearchDocPath = await writeResearchDoc(
      finalResearchDocPath,
      aggregate.text,
    );
    const manifestPath = join(artifactRoot, "manifest.json");
    const completedAt = new Date();
    await writeManifest(manifestPath, {
      runId,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      researchQuestion: prompt,
      finalAsset: displayWorkflowPath(writtenResearchDocPath),
      artifacts: manifestArtifactPaths(
        artifactPathsByStage,
        manifestPath,
        displayWorkflowPath,
      ),
    });

    const result: DeepResearchCodebaseResult = {
      result: aggregate.text,
      findings: aggregate.text,
      research_doc_path: displayWorkflowPath(writtenResearchDocPath),
      artifact_dir: displayWorkflowPath(artifactRoot),
      manifest_path: displayWorkflowPath(manifestPath),
      partitions: [...partitions],
      explorer_count: partitions.length,
      specialist_count: wave1.length + wave2.length,
      max_concurrency: maxConcurrency,
      history: historyOverview,
    };
    return result;
  })
  .compile();
