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
  "packages/workflows/README.md",
  "docs/workflow-playbook.md",
];

const subagentDocumentationPaths = [
  "packages/coding-agent/docs/subagents.md",
  "packages/subagents/README.md",
  "packages/subagents/skills/subagent/SKILL.md",
];

describe("intent-first execution routing", () => {
  test("presents a complementary least-orchestration hierarchy", () => {
    for (const phrase of [
      "interactive, exploratory, conceptual, and conversation-led work inline",
      "single subagent",
      "bounded subagent chain/parallel",
      "parent remains in control",
      "well-defined autonomous job",
      "long-running or background-oriented",
      "Multiple steps, files, tests, validation commands, or parallelism alone do not require a workflow",
    ]) {
      expect(modelVisibleRouting).toContain(phrase);
    }
  });

  test("treats loop and stop-condition phrasing as a key workflow signal", () => {
    for (const phrase of [
      "loop or stop-condition phrasing as a key workflow signal",
      "do X until Y",
      "repeat until",
      "iterate until",
      "review/fix until passing",
      "run checks and fix until green",
      "keep going until done",
      "prefer a workflow so the stop condition, retries, evidence, and convergence are tracked",
    ]) {
      expect(modelVisibleRouting).toContain(phrase);
    }
  });

  test("describes every supported workflow source and one-off/custom shapes accurately", () => {
    for (const phrase of [
      "builtin, project, user, or package",
      "task`",
      "tasks`",
      "chain`",
      "custom TypeScript `workflow({...})`",
      "reload workflow resources",
      "workflow tool does not have a create action",
    ]) {
      expect(modelVisibleRouting).toContain(phrase);
    }
  });

  test("removes universal workflow, subagent, debugger, async, and escalation policies", () => {
    for (const oldPolicy of [
      "default execution path for any non-trivial task",
      "Decide the execution mode before your first tool call",
      "roughly ten or more tool calls",
      "all non-trivial operations should be delegated",
      "spawn a debugger subagent first",
      "Prefer async mode for every subagent launch",
    ]) {
      expect(modelVisibleRouting).not.toContain(oldPolicy);
    }
  });

  test("keeps builtin workflow orchestration selective and bounded", async () => {
    const ralphPrompt = (await Promise.all([
      "packages/workflows/builtin/ralph-runner.ts",
      "packages/workflows/builtin/ralph-core.ts",
    ].map(readRepositoryFile))).join("\n");

    for (const phrase of [
      "Use subagents selectively for bounded specialist work",
      "Concise direct work",
      "parent remains in control",
    ]) {
      expect(ralphPrompt).toContain(phrase);
    }

    for (const universalDelegationPolicy of [
      "All non-trivial operations must be delegated",
      "all non-trivial operations should be delegated",
      "You are not the direct implementer",
      "A valid response must be grounded in actual subagent work",
      "spawn the necessary subagents",
    ]) {
      expect(ralphPrompt).not.toContain(universalDelegationPolicy);
    }
  });

  test("retains lifecycle, no-polling, transcript, and artifact handoff guidance", () => {
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

  test("keeps synchronized help and workflow docs intent-first without complexity-only routing", async () => {
    const surfaces = await Promise.all([
      "packages/coding-agent/src/core/atomic-guide-command.ts",
      "packages/coding-agent/docs/quickstart.md",
      "README.md",
      ...workflowDocumentationPaths,
    ].map(readRepositoryFile));
    const synchronizedRouting = surfaces.join("\n");

    for (const phrase of [
      "autonomous",
      "durable",
      "parent remains in control",
      "Task size alone",
      "builtin, project, user, or package",
      "custom TypeScript",
      "key workflow signal",
      "keep going until done",
      "always author a custom TypeScript",
      "inline with normal coding tools",
    ]) {
      expect(synchronizedRouting).toContain(phrase);
    }

    for (const obsoleteWorkflowPolicy of [
      "For small-to-medium scoped changes",
      "For larger migrations, broad refactors",
      "For smaller one-off tasks, use `/workflow goal`",
      "typical planned flow is `/skill:research-codebase` → `/skill:create-spec` → `/workflow ralph`",
      "Focused workflow for small-to-medium changes",
      "Heavier prompt-engineering → research → orchestrate → review workflow for larger migrations",
      "small-to-medium scoped changes when you can name the work surface",
      "larger migrations, new features, broad refactors, and multi-package changes",
      "reserve direct debugger/subagent calls for narrow diagnosis or truly tiny deterministic fixes",
      "for bounded scoped work with explicit validation",
      "task has non-trivial scope",
      "A typical planned flow is `/skill:research-codebase` → `/skill:create-spec` → `/workflow ralph`",
      "Implement a small-to-medium scope change",
      "Research and execute a larger migration, broad refactor, or multi-package change",
      "For smaller one-off tasks, use `goal`",
      "workflow tool's create action",
      "`action: \"create\"` to create a workflow",
    ]) {
      expect(synchronizedRouting).not.toContain(obsoleteWorkflowPolicy);
    }
  });

  test("keeps synchronized subagent docs selective and bounded", async () => {
    const subagentDocumentation = (await Promise.all(
      subagentDocumentationPaths.map(readRepositoryFile),
    )).join("\n");

    for (const phrase of [
      "parent remains in control",
      "interactive",
      "bounded",
      "async",
      "debugger",
    ]) {
      expect(subagentDocumentation).toContain(phrase);
    }

    for (const obsoleteSubagentPolicy of [
      "all non-trivial operations should be delegated",
      "using subagents at the start of all non-trivial work",
      "spawn a debugger subagent first",
      "Always use the debugger",
      "Prefer async mode for every subagent launch",
      "always launch subagents asynchronously",
      "clarification is mandatory before delegation",
    ]) {
      expect(subagentDocumentation).not.toContain(obsoleteSubagentPolicy);
    }
  });
});
