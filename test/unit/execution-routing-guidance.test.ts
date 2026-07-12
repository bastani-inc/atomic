import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { DEFAULT_PROMPT_GUIDANCE as workflowGuidance, WORKFLOW_TOOL_DESCRIPTION } from "../../packages/workflows/src/extension/workflow-prompts.js";
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

  test("supports named, direct, and rich inline TypeScript workflows", () => {
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

  test("requires interactive workflow launches to run in the background", () => {
    for (const phrase of [
      "In interactive chat, launch every workflow in the background",
      "Named workflow launches are already detached",
      "direct `task`, `tasks`, and `chain` launches must set top-level `async: true`",
      "This applies only to launches, not inspection or control calls",
      "`status`, `stages`, `stage`, `transcript`, `send`, `pause`, `resume`, `interrupt`, `kill`",
      "only when the user explicitly requests it or it is technically required",
      "tell the user before launching it",
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
});
