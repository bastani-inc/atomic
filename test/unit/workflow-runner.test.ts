import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { runWorkflow } from "../../src/runs/shared/workflow-runner.js";
import type { StageSessionRuntime } from "../../src/runs/foreground/stage-runner.js";

function makeSessionFactory(seen: string[]) {
  return async (_options?: CreateAgentSessionOptions): Promise<{ session: StageSessionRuntime }> => {
    let lastAssistantText: string | undefined;
    const session: StageSessionRuntime = {
      async prompt(text: string): Promise<string> {
        seen.push(text);
        lastAssistantText = `sdk:${text}`;
        return lastAssistantText;
      },
      async steer(_text: string): Promise<void> {},
      async followUp(_text: string): Promise<void> {},
      subscribe(): () => void {
        return () => {};
      },
      sessionFile: undefined,
      sessionId: `test-sdk-${crypto.randomUUID()}`,
      async setModel(_model): Promise<void> {},
      setThinkingLevel(_level): void {},
      async cycleModel() {
        return undefined;
      },
      cycleThinkingLevel() {
        return undefined;
      },
      agent: Object.create(null) as StageSessionRuntime["agent"],
      model: undefined,
      thinkingLevel: "off",
      messages: [] as StageSessionRuntime["messages"],
      isStreaming: false as StageSessionRuntime["isStreaming"],
      async navigateTree(): ReturnType<StageSessionRuntime["navigateTree"]> {
        return { cancelled: true };
      },
      async compact(): ReturnType<StageSessionRuntime["compact"]> {
        return { summary: "", firstKeptEntryId: "", tokensBefore: 0 };
      },
      abortCompaction(): void {},
      async abort(): Promise<void> {},
      dispose(): void {},
      getLastAssistantText(): string | undefined {
        return lastAssistantText;
      },
    };
    return { session };
  };
}

describe("programmatic workflow runner", () => {
  test("runs a named workflow from an explicit definition object", async () => {
    const prompts: string[] = [];
    const result = await runWorkflow(
      {
        mode: "workflow",
        workflow: "deep-research-codebase",
        inputs: { prompt: "map workflow sdk", max_partitions: 1 },
      },
      { adapterOptions: { createAgentSession: makeSessionFactory(prompts) } },
    );

    assert.equal(result.mode, "named");
    assert.equal(result.status, "completed");
    assert.equal(result.output?.["specialist_count"], 4);
    assert.ok(prompts.some((prompt) => prompt.includes("Research question: map workflow sdk")));
  });

  test("validates named workflow inputs before starting a session", async () => {
    const prompts: string[] = [];

    await assert.rejects(
      runWorkflow(
        {
          mode: "workflow",
          workflow: "deep-research-codebase",
          inputs: { prompt: "map workflow sdk", max_partitions: "not-a-number" },
        },
        { adapterOptions: { createAgentSession: makeSessionFactory(prompts) } },
      ),
      /Invalid inputs[\s\S]*max_partitions/,
    );
    assert.deepEqual(prompts, []);
  });

  test("reports missing required input without starting a session", async () => {
    const prompts: string[] = [];

    await assert.rejects(
      runWorkflow(
        { mode: "workflow", workflow: "deep-research-codebase" },
        { adapterOptions: { createAgentSession: makeSessionFactory(prompts) } },
      ),
      /required input is missing/,
    );
    assert.deepEqual(prompts, []);
  });

  test("reports unknown workflows with the discovered workflow list", async () => {
    await assert.rejects(
      runWorkflow({ mode: "workflow", workflow: "missing-workflow" }, { stubAgent: true }),
      /Workflow not found: "missing-workflow"/,
    );
  });
});
