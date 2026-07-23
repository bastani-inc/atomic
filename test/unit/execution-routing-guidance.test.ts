import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { DEFAULT_PROMPT_GUIDANCE as workflowGuidance, WORKFLOW_TOOL_DESCRIPTION } from "../../packages/workflows/src/extension/workflow-prompts.js";
import { WorkflowParametersSchema } from "../../packages/workflows/src/extension/workflow-schema.js";
import { DEFAULT_PROMPT_GUIDANCE as subagentGuidance } from "../../packages/subagents/src/extension/prompt-guidance.js";
import { SUBAGENT_TOOL_DESCRIPTION } from "../../packages/subagents/src/extension/tool-description.js";

const repositoryRoot = resolve(import.meta.dir, "../..");

async function readRepositoryFile(path: string): Promise<string> {
  return Bun.file(resolve(repositoryRoot, path)).text();
}

const combinedGuidance = [...workflowGuidance, ...subagentGuidance].join("\n");
const modelVisibleRouting = `${combinedGuidance}\n${WORKFLOW_TOOL_DESCRIPTION}\n${SUBAGENT_TOOL_DESCRIPTION}`;

const workflowDocumentationPaths = [
  "packages/coding-agent/docs/workflows.md",
  "packages/coding-agent/docs/quickstart.md",
  "packages/coding-agent/src/core/atomic-guide-command.ts",
  "packages/workflows/README.md",
  "docs/workflow-playbook.md",
  "README.md",
];

describe("workflow-first execution routing", () => {
  test("restores workflows as the default for non-trivial verifiable work", () => {
    for (const phrase of [
      "default execution path for any non-trivial task",
      "inherent structure plus an objective you can make verifiable",
      "implementation, build, debug/diagnosis, bug-fix, migration, new-feature",
      "multiple steps, dependencies, handoffs, uncertainty",
      "Only skip workflows for tiny, deterministic, low-risk",
    ]) {
      expect(modelVisibleRouting).toContain(phrase);
    }
  });

  test("requires an early routing decision and prevents inline drift", () => {
    for (const phrase of [
      "Decide the execution mode before your first tool call",
      "Reconnaissance counts as inline execution",
      "Budget reconnaissance",
      "roughly ten exploratory tool calls",
      "Sunk inline research transfers through files",
    ]) {
      expect(modelVisibleRouting).toContain(phrase);
    }
  });

  test("treats loop and stop-condition phrasing as a strong workflow signal", () => {
    for (const phrase of [
      "loop or stop-condition wording as a strong workflow signal",
      "do X until Y",
      "repeat until",
      "iterate until",
      "review/fix until passing",
      "run checks and fix until green",
      "keep going until done",
      "approval gate or evidence requirement",
    ]) {
      expect(modelVisibleRouting).toContain(phrase);
    }
  });

  test("supports named and rich inline TypeScript workflows", () => {
    for (const phrase of [
      "builtin, project, user, or package",
      "custom TypeScript `workflow({...})` inline",
      "reload workflow resources",
      "Do not force-fit",
      "deterministic branching",
      "dynamic fan-out",
      "child workflows",
      "structured outputs",
      "human-in-the-loop prompts",
      "explicit stop conditions",
    ]) {
      expect(modelVisibleRouting).toContain(phrase);
    }
  });

  test("teaches compositional imports and nested builtin workflows", () => {
    for (const phrase of [
      "Workflow definitions are normal TypeScript modules",
      "@bastani/workflows/builtin",
      "ctx.workflow(childDefinition, { inputs, stageName })",
      "Imported children may nest more workflows",
      "maxDepth",
      "expanded parent graph",
      "Pass definitions, not registry-name strings or paths",
      "deepResearchCodebase",
      "conditionally nest `goal` or `ralph`",
      "wrap `openClaudeDesign`",
      "consuming only declared outputs",
    ]) {
      expect(modelVisibleRouting).toContain(phrase);
    }
  });

  test("guides authored workflows to checkpoint workflow-owned side effects", () => {
    const authoringGuidance = workflowGuidance.join("\n");
    for (const phrase of [
      "Prefer `ctx.tool(name, args, fn)`",
      "filesystem writes",
      "network mutations",
      "external API actions",
      "durably checkpointed",
      "resume replays that result without rerunning `fn`",
      "pure computation and side-effect-free transformations as ordinary TypeScript",
      "Do not wrap agent-stage internals or every function call indiscriminately",
      "side effects orchestrated directly by the workflow definition",
    ]) {
      expect(authoringGuidance).toContain(phrase);
    }
  });

  test("requires consulting the model-selection guide and configured catalog when pinning stage models", () => {
    const authoringGuidance = workflowGuidance.join("\n");
    for (const phrase of [
      "packages/coding-agent/docs/models/model-selection.md",
      'workflow({ action: "models" })',
      "returned `fullId` values as model strings",
      "availableThinkingLevels",
      "treat an absent or empty `availableThinkingLevels` as no suffix support",
      "try another guide-recommended model that is present in the catalog",
      "leave the stage unpinned rather than inventing a substitute",
      "state that no configured models were returned, and do not fabricate model IDs",
      "Do not inspect or infer credentials, environment variables, auth files, token validity, entitlements",
      "`isCurrent` marks the active selection, not a quality recommendation",
    ]) {
      expect(authoringGuidance).toContain(phrase);
    }
  });

  test("teaches documented starter patterns and concrete dynamic examples", () => {
    for (const phrase of [
      "Classify-and-act",
      "Fan-out-and-synthesize",
      "Adversarial verification",
      "Generate-and-filter",
      "Tournament",
      "Loop until done",
      "classify a request and dispatch category-specific stages",
      "fan out per package",
      "fresh-context verifiers",
      "tournament-rank",
      "max-iteration escape hatch",
    ]) {
      expect(modelVisibleRouting).toContain(phrase);
    }
  });

  test("requires a pre-launch coverage pass and one composed execution shape", () => {
    for (const phrase of [
      "workflow-architecture pass",
      "implementation lifecycle needs",
      "whole-codebase research needs",
      "exact API/type/build contracts",
      "schema or generated-artifact contracts",
      "state transitions/lifecycle behavior",
      "requirement/risk | required evidence | workflow/stage that produces it | gap",
      "covers the lifecycle and produces evidence for every material requirement/risk",
      'Do not treat "has reviewers" as proof that a task-specific risk is covered',
      "first named workflow launch commits the execution shape for the turn",
      "chain unrelated top-level workflow launches",
      "design one custom parent before launch",
      "Choose the cheapest graph",
      "Avoid decorative composition and duplicated research or review loops",
      "state the selected graph",
      "why one broad builtin is sufficient or insufficient",
      "evidence each major stage produces",
      "stop/repair conditions",
      "simple direct match may use one sentence",
    ]) {
      expect(modelVisibleRouting).toContain(phrase);
    }
  });

  test("retains every risk-based routing signal in model-visible guidance", () => {
    for (const phrase of [
      "broad repository uncertainty",
      "`deep-research-codebase`",
      "independent slices → Fan-out-and-synthesize",
      "plausible-but-wrong contract risk → Adversarial verification",
      "competing architectures or implementations → Generate-and-filter or Tournament",
      "explicit repeat-until condition → Loop until done",
      "implementation lifecycle → `goal` or `ralph`, potentially as a child",
      "exact API/build/schema requirements → dedicated deterministic gates",
    ]) {
      expect(modelVisibleRouting).toContain(phrase);
    }
  });

  test("requires skeptical reviewer plans and authoritative verifier loops", () => {
    for (const phrase of [
      "fresh-context grumpy/skeptical-but-fair reviewer",
      "without invented requirements",
      "structured verifier plan",
      "exact probe, inputs, command/assertion, expected success condition, and requirement/risk covered",
      "direct task-specific `ctx.tool(...)` gates",
      "model select high-value probes through structured output",
      "compile, test, schema generation/validation, runtime, or artifact-inspection checks",
      "Actual tool results—not model self-report",
      "consolidated evidence-backed repair findings",
      "implementation child repairs them",
      "bounded pass, repair, failure, and iteration-limit conditions",
      "keep pure transformations as ordinary TypeScript",
      "do not wrap every model-stage action in a tool call",
      "how model-selected plans become tool executions",
      "how failures reach bounded repair",
    ]) {
      expect(modelVisibleRouting).toContain(phrase);
    }
  });

  test("mirrors risk/evidence routing and verifier-loop guidance in workflow docs", async () => {
    const documentation = await readRepositoryFile("packages/coding-agent/docs/workflows.md");

    for (const phrase of [
      "pre-launch workflow architecture",
      "requirement/risk | required evidence | workflow/stage that produces it | gap",
      'Do not treat "has reviewers" as proof that a task-specific risk is covered',
      "Does an installed graph supply complete coverage?",
      "Broad repository uncertainty points to `deep-research-codebase`",
      "implementation lifecycle to Goal or Ralph, potentially as a child",
      "first named workflow launch commits the execution shape for the turn",
      "one custom parent",
      "Choose the cheapest complete graph",
      "grumpy/skeptical-but-fair reviewer",
      "without inventing requirements",
      "structured verifier plan",
      "direct task-specific `ctx.tool(...)` gates",
      "model select high-value probes in structured output",
      "The model must not self-report outcomes",
      "actual tool results",
      "consolidated, evidence-backed, bounded repair payload",
      "rerun the deterministic verifier tools",
      "pure transformations as ordinary TypeScript",
      "do not wrap every model-stage action in a tool call",
      "custom-loop pre-launch declaration",
    ]) {
      expect(documentation).toContain(phrase);
    }
  });

  test("routes worktree isolation through declared named-workflow inputs", () => {
    for (const phrase of [
      "Natural-language instructions to create or use a worktree do not enable runner isolation",
      "named workflow must declare and implement any worktree inputs",
      "inspect its inputs before launching",
    ]) {
      expect(combinedGuidance).toContain(phrase);
    }
  });

  test("removes direct execution options from the workflow tool boundary", () => {
    const properties = WorkflowParametersSchema.properties as Record<string, unknown>;
    for (const removed of ["task", "tasks", "chain", "cwd", "worktree", "gitWorktreeDir", "concurrency", "failFast"]) {
      expect(properties).not.toHaveProperty(removed);
    }
  });

  test("keeps workflow lifecycle, transcript, and artifact handoff guidance", () => {
    for (const phrase of [
      "lifecycle notice",
      "Do not use sleep/status polling loops",
      "sessionFile",
      "transcriptPath",
      "files/artifacts",
      "Read the file at <path>",
    ]) {
      expect(combinedGuidance).toContain(phrase);
    }
  });

  test("documents that named workflow launches run in the background", () => {
    for (const phrase of [
      "In interactive chat, named workflow launches run in the background",
      "`/workflow connect <run>`",
      "see agents working",
      "chat with and steer each stage",
      "Inspection and control calls",
      "`status`, `stages`, `stage`, `transcript`, `send`, `pause`, `resume`, `interrupt`, `quit`",
    ]) {
      expect(combinedGuidance).toContain(phrase);
    }
  });

  test("keeps subagents complementary without universal delegation", () => {
    for (const phrase of [
      "focused specialist work inside workflows",
      "workflows are the default for non-trivial structured work",
      "single subagent",
      "chain",
      "parallel tasks",
      "debugger subagent for actual failures",
    ]) {
      expect(modelVisibleRouting).toContain(phrase);
    }

    for (const obsoletePolicy of [
      "all non-trivial operations should be delegated",
      "spawn a debugger subagent first",
      "Prefer async mode for every subagent launch",
    ]) {
      expect(modelVisibleRouting).not.toContain(obsoletePolicy);
    }
  });

  test("restores Ralph's builtin subagent-orchestrator prompts", async () => {
    const ralphPrompts = (await Promise.all([
      "packages/workflows/builtin/ralph-core.ts",
      "packages/workflows/builtin/ralph-runner.ts",
    ].map(readRepositoryFile))).join("\n");

    for (const phrase of [
      "You are a sub-agent orchestrator",
      "You are not the direct implementer",
      "All non-trivial operations must be delegated to subagents",
      "spawn the necessary subagents",
      "A valid response must be grounded in actual subagent work",
      "After subagents have done the work",
      "subagents spawned and what each completed",
    ]) {
      expect(ralphPrompts).toContain(phrase);
    }

    for (const revertedPhrase of [
      "Use subagents selectively for bounded specialist work",
      "Concise direct work is appropriate",
      "or none when direct work was sufficient",
    ]) {
      expect(ralphPrompts).not.toContain(revertedPhrase);
    }
  });

  test("synchronizes workflow-first docs with custom workflow authoring", async () => {
    const documentation = (await Promise.all(workflowDocumentationPaths.map(readRepositoryFile))).join("\n");

    for (const phrase of [
      "Default to a workflow",
      "non-trivial",
      "verifiable objective",
      "custom TypeScript",
      "workflow({...})",
      "dynamic fan-out",
      "adversarial verification",
      "bounded loop",
      "@bastani/workflows/builtin",
      "ctx.workflow(...)",
      "Nested children",
      "maxDepth",
    ]) {
      expect(documentation).toContain(phrase);
    }

    for (const regressionPhrase of [
      "Multiple steps, files, tests, validation, or parallelism alone do not require a workflow",
      "there is no fixed tool-call escalation threshold",
      "workflow tool's create action",
      "`action: \"create\"` to create a workflow",
    ]) {
      expect(documentation).not.toContain(regressionPhrase);
    }
  });

  test("synchronizes side-effect guidance across workflow authoring references", async () => {
    for (const path of [
      "packages/coding-agent/docs/workflows.md",
      "packages/workflows/README.md",
    ]) {
      const documentation = await readRepositoryFile(path);
      for (const phrase of [
        "ctx.tool(name, args, fn)",
        "workflow-owned",
        "filesystem writes",
        "network mutations",
        "external API actions",
        "without rerunning",
        "pure computation",
        "agent-stage internals",
        "every function call",
      ]) {
        expect(documentation, path).toContain(phrase);
      }
    }
  });
});