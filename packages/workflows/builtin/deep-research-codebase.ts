/**
 * Builtin workflow: deep-research-codebase
 *
 * Re-implements the Atomic SDK builtin topology with the pi workflow task
 * primitives: scout + research-history chain, two parallel specialist waves,
 * and a final aggregator. The local SDK does not expose Atomic's Claude-only
 * callback stage API, so the workflow models that design with ctx.task(),
 * ctx.parallel(), and ctx.chain().
 */

import { defineWorkflow } from "../src/index.js";
import type {
  WorkflowTaskResult,
  WorkflowTaskStep,
} from "../src/shared/types.js";

const DEFAULT_MAX_PARTITIONS = 100;
const DEFAULT_MAX_CONCURRENCY = 4;
const LOC_PER_PARTITION = 10_000;

type PromptSection = readonly [tag: string, content: string];

const CODEBASE_SKILLS = {
  locator:
    "codebase-locator — use this skill's search-first discipline when mapping where files, symbols, docs, tests, and configuration live.",
  analyzer:
    "codebase-analyzer — use this skill's evidence-driven deep-read style when explaining behavior, architecture, control flow, data flow, and edge cases.",
  patternFinder:
    "codebase-pattern-finder — use this skill's example-mining approach when separating reusable conventions from one-off details.",
  researchLocator:
    "codebase-research-locator — use this skill's historical-discovery approach when finding prior research, specs, ADRs, issues, and TODOs.",
  researchAnalyzer:
    "codebase-research-analyzer — use this skill's synthesis approach when extracting decisions, constraints, stale assumptions, and open questions from prior research.",
  onlineResearcher:
    "codebase-online-researcher — use this skill's source-citing approach when external documentation or ecosystem behavior materially affects the answer.",
} as const;

function codebaseSkillGuidance(
  ...skills: readonly (keyof typeof CODEBASE_SKILLS)[]
): string {
  return skills.map((skill) => CODEBASE_SKILLS[skill]).join("\n");
}

function taggedPrompt(sections: readonly PromptSection[]): string {
  return sections
    .map(([tag, content]) => `<${tag}>\n${content.trim()}\n</${tag}>`)
    .join("\n\n");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function countCodebaseLines(): number {
  try {
    const gitFiles = Bun.spawnSync({
      cmd: ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const files =
      gitFiles.success && gitFiles.stdout
        ? gitFiles.stdout
            .toString()
            .split("\n")
            .filter((line) => line.length > 0)
        : [];

    if (files.length === 0) return 0;

    let total = 0;
    const batchSize = 200;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      const wc = Bun.spawnSync({
        cmd: ["wc", "-l", "--", ...batch],
        stdout: "pipe",
        stderr: "pipe",
      });
      if (!wc.stdout) continue;

      for (const line of wc.stdout.toString().split("\n")) {
        const match = line.match(/^\s*(\d+)\s+(.+)$/);
        const countText = match?.[1];
        const path = match?.[2]?.trim();
        if (countText === undefined || path === undefined || path === "total")
          continue;
        total += Number.parseInt(countText, 10);
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

function findResult(
  results: readonly WorkflowTaskResult[],
  name: string,
): WorkflowTaskResult | undefined {
  return results.find(
    (result) => result.name === name || result.stageName === name,
  );
}

function specialistSummary(
  partitions: readonly string[],
  wave1: readonly WorkflowTaskResult[],
  wave2: readonly WorkflowTaskResult[],
): string {
  return partitions
    .map((partition, index) => {
      const i = index + 1;
      const locator =
        findResult(wave1, `locator-${i}`)?.text ?? "(no locator output)";
      const patterns =
        findResult(wave1, `pattern-finder-${i}`)?.text ?? "(no pattern output)";
      const analyzer =
        findResult(wave2, `analyzer-${i}`)?.text ?? "(no analyzer output)";
      const online =
        findResult(wave2, `online-researcher-${i}`)?.text ??
        "(no online research output)";
      return [
        `## Partition ${i}: ${partition}`,
        `### Locator\n${locator}`,
        `### Pattern Finder\n${patterns}`,
        `### Analyzer\n${analyzer}`,
        `### Online Researcher\n${online}`,
      ].join("\n\n");
    })
    .join("\n\n---\n\n");
}

export default defineWorkflow("deep-research-codebase")
  .description(
    "Scout + research-history chain → parallel specialist waves → aggregator for deep codebase research.",
  )
  .input("prompt", {
    type: "text",
    required: true,
    description: "Research question or investigation focus for the codebase.",
  })
  .input("max_partitions", {
    type: "number",
    default: DEFAULT_MAX_PARTITIONS,
    description:
      "Maximum number of codebase partitions to explore in parallel. Actual partitions scale by one per 10K LoC, capped by this value.",
  })
  .input("max_concurrency", {
    type: "number",
    default: DEFAULT_MAX_CONCURRENCY,
    description:
      "Maximum number of workflow stages to run concurrently during deep research.",
  })
  .run(async (ctx) => {
    const inputs = ctx.inputs as {
      prompt?: string;
      max_partitions?: number;
      max_concurrency?: number;
    };
    const prompt = inputs.prompt ?? "";
    const requestedMaxPartitions = positiveInteger(
      inputs.max_partitions,
      DEFAULT_MAX_PARTITIONS,
    );
    const maxConcurrency = positiveInteger(
      inputs.max_concurrency,
      DEFAULT_MAX_CONCURRENCY,
    );
    const codebaseLines = countCodebaseLines();
    const partitionCap = calculatePartitionCap(
      requestedMaxPartitions,
      codebaseLines,
    );

    let noAskQuestionToolSet = [
      "read",
      "bash",
      "edit",
      "write",
      "todo",
      "subagent",
      "web_search",
      "code_search",
      "fetch_content",
      "get_search_content",
      "intercom",
    ];

    let plannerModelConfig = {
      model: "openai/gpt-5.5",
      fallbackModels: [
        "openai-codex/gpt-5.5",
        "github-copilot/gpt-5.5",
        "anthropic/claude-opus-4-7",
        "github-copilot/claude-opus-4.7",
      ],
      thinkingLevel: "high" as const,
      tools: noAskQuestionToolSet,
    };

    let explorerModelConfig = {
      model: "openai/gpt-5.4-mini",
      fallbackModels: [
        "openai-codex/gpt-5.4-mini",
        "github-copilot/gpt-5.4-mini",
        "anthropic/claude-haiku-4-5",
        "github-copilot/claude-haiku-4.5",
      ],
      thinkingLevel: "low" as const,
      tools: noAskQuestionToolSet,
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
            ["objective", `Map the repository. Research question: ${prompt}`],
            [
              "codebase_skills",
              codebaseSkillGuidance("locator", "analyzer", "patternFinder"),
            ],
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
          ...plannerModelConfig,
        },
        {
          name: "history-locator",
          task: taggedPrompt([
            ["role", "You locate prior project research and decision history."],
            [
              "objective",
              "Find existing docs, specs, ADRs, issues/PR notes, TODOs, and research artifacts relevant to the task.",
            ],
            ["task", "{task}"],
            ["codebase_skills", codebaseSkillGuidance("researchLocator")],
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
          ...explorerModelConfig,
        },
      ],
      { task: prompt, concurrency: maxConcurrency },
    );

    const scout =
      findResult(initialDiscovery, "codebase-scout") ?? initialDiscovery[0]!;
    const historyLocator =
      findResult(initialDiscovery, "history-locator") ?? initialDiscovery[1]!;
    const history = await ctx.chain(
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
              `Extract reusable historical context. Research question: ${prompt}`,
            ],
            ["prior_research_locator_output", "{previous}"],
            ["codebase_skills", codebaseSkillGuidance("researchAnalyzer")],
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
          `Return at most ${partitionCap} independent partitions for this research question: ${prompt}`,
        ],
        ["scout_output", "{previous}"],
        [
          "codebase_skills",
          codebaseSkillGuidance("locator", "analyzer", "patternFinder"),
        ],
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
      ...plannerModelConfig,
    });

    const partitions = parsePartitions(partitionPlan.text, partitionCap);

    const wave1Steps: WorkflowTaskStep[] = partitions.flatMap(
      (partition, index) => {
        const i = index + 1;
        return [
          {
            name: `locator-${i}`,
            task: taggedPrompt([
              ["role", "You are a codebase locator specialist."],
              [
                "assignment",
                `Partition ${i}/${partitions.length}: ${partition}`,
              ],
              ["research_question", prompt],
              ["scout_context", "{previous}"],
              ["codebase_skills", codebaseSkillGuidance("locator")],
              [
                "instructions",
                [
                  "Find the highest-signal files, tests, docs, commands, configs, and symbols for this partition.",
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
            ...explorerModelConfig,
          },
          {
            name: `pattern-finder-${i}`,
            task: taggedPrompt([
              ["role", "You are a codebase pattern-finding specialist."],
              [
                "assignment",
                `Partition ${i}/${partitions.length}: ${partition}`,
              ],
              ["research_question", prompt],
              ["scout_context", "{previous}"],
              ["codebase_skills", codebaseSkillGuidance("patternFinder")],
              [
                "instructions",
                [
                  "Identify recurring implementation patterns, abstractions, naming conventions, and anti-patterns in this partition.",
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
        return [
          {
            name: `analyzer-${i}`,
            task: taggedPrompt([
              [
                "role",
                "You are a codebase behavior and architecture analyzer.",
              ],
              [
                "assignment",
                `Partition ${i}/${partitions.length}: ${partition}`,
              ],
              ["research_question", prompt],
              ["context", "{previous}"],
              ["codebase_skills", codebaseSkillGuidance("analyzer")],
              [
                "instructions",
                [
                  "Analyze behavior, control flow, data flow, lifecycle, error handling, and test coverage for this partition.",
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
            ...explorerModelConfig,
          },
          {
            name: `online-researcher-${i}`,
            task: taggedPrompt([
              [
                "role",
                "You are an ecosystem and documentation research specialist.",
              ],
              [
                "assignment",
                `Partition ${i}/${partitions.length}: ${partition}`,
              ],
              ["research_question", prompt],
              ["local_context", "{previous}"],
              ["codebase_skills", codebaseSkillGuidance("onlineResearcher")],
              [
                "instructions",
                [
                  "Identify external library/framework behavior, standards, or docs that materially affect the local interpretation.",
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
            ...explorerModelConfig,
          },
        ];
      },
    );

    const wave2 = await ctx.parallel(wave2Steps, {
      task: prompt,
      concurrency: maxConcurrency,
    });
    const historyOverview = history.at(-1)?.text ?? "";
    const specialistReports = specialistSummary(partitions, wave1, wave2);

    const aggregate = await ctx.task("aggregator", {
      prompt: taggedPrompt([
        ["role", "You are the final deep-research aggregator."],
        [
          "objective",
          `Answer the research question comprehensively: ${prompt}`,
        ],
        [
          "prior_research_overview",
          historyOverview || "(no prior research found)",
        ],
        ["specialist_reports", specialistReports],
        [
          "codebase_skills",
          codebaseSkillGuidance(
            "analyzer",
            "researchAnalyzer",
            "onlineResearcher",
          ),
        ],
        [
          "instructions",
          [
            "Synthesize; do not merely concatenate specialist reports.",
            "Prioritize claims supported by concrete paths, symbols, tests, docs, or cited external references.",
            "Resolve contradictions explicitly and preserve important uncertainty.",
            "Avoid inventing facts not supported by the supplied reports; state unknowns instead.",
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
      previous: [scout, partitionPlan, ...wave1, ...wave2],
      ...explorerModelConfig,
    });

    return {
      findings: aggregate.text,
      partitions,
      explorer_count: partitions.length,
      specialist_count: wave1.length + wave2.length,
      max_concurrency: maxConcurrency,
      history: historyOverview,
    };
  })
  .compile();
