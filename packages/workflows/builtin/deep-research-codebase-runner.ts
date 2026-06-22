import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  WorkflowRunContext,
  WorkflowSerializableValue,
  WorkflowTaskStep,
} from "../src/shared/types.js";
import {
  DEFAULT_MAX_CONCURRENCY, DEFAULT_MAX_PARTITIONS, EXPLORER_MODEL_CONFIG,
  PLANNER_MODEL_CONFIG, calculatePartitionCap, countCodebaseLines,
  createArtifactRoot, defaultResearchDocPath, displayRelativePath,
  fileOnlyOutput, findResult, manifestArtifactPaths, parsePartitions,
  positiveInteger, readArtifactText, specialistHandoffFromArtifacts,
  taggedPrompt, writeManifest, writeResearchDoc,
  type DeepResearchCodebaseResult,
} from "./deep-research-codebase-utils.js";

type DeepResearchCodebaseInputs = {
  readonly prompt: string;
  readonly max_partitions?: number;
  readonly max_concurrency?: number;
} & Record<string, WorkflowSerializableValue>;

export async function runDeepResearchCodebase(
  ctx: WorkflowRunContext<DeepResearchCodebaseInputs>,
): Promise<DeepResearchCodebaseResult> {
const inputs = ctx.inputs;
const prompt = inputs.prompt;
const requestedMaxPartitions = positiveInteger(inputs.max_partitions, DEFAULT_MAX_PARTITIONS);
const maxConcurrency = positiveInteger(inputs.max_concurrency, DEFAULT_MAX_CONCURRENCY);
const startedAt = new Date();
const workflowCwd = ctx.cwd ?? process.cwd();
const finalResearchDocPath = defaultResearchDocPath(prompt, workflowCwd, startedAt);
const codebaseLines = countCodebaseLines(workflowCwd);
const partitionCap = calculatePartitionCap(requestedMaxPartitions, codebaseLines);
const { runId, artifactRoot } = await createArtifactRoot(startedAt, workflowCwd);
const artifactPathsByStage = new Map<string, string>();
const addArtifact = (stage: string, path: string) => {
  artifactPathsByStage.set(stage, path);
  return path;
};
const displayWorkflowPath = (path: string): string =>
  displayRelativePath(path, workflowCwd);
const displayWorkflowPaths = (paths: readonly string[]): string =>
  paths.map(displayWorkflowPath).join(", ");

const scoutPath = addArtifact("codebase-scout", join(artifactRoot, "00-codebase-scout.md"));
const partitionPlanPath = addArtifact("partition", join(artifactRoot, "01-partition-plan.md"));
const historyLocatorPath = addArtifact("history-locator", join(artifactRoot, "01-history-locator.md"));
const historyAnalyzerPath = addArtifact("history-analyzer", join(artifactRoot, "02-history-analyzer.md"));

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
      ...PLANNER_MODEL_CONFIG,
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
      ...EXPLORER_MODEL_CONFIG,
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
      ...PLANNER_MODEL_CONFIG,
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
  ...PLANNER_MODEL_CONFIG,
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
        ...EXPLORER_MODEL_CONFIG,
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
        ...EXPLORER_MODEL_CONFIG,
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
        ...EXPLORER_MODEL_CONFIG,
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
        ...EXPLORER_MODEL_CONFIG,
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
  ...EXPLORER_MODEL_CONFIG,
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
}
