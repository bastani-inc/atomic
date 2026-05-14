import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import {
  parseWorkflowSdkFlags,
  runWorkflowSdkEntrypoint,
} from "../../src/runs/shared/workflow-sdk-entrypoint.js";
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

describe("workflow SDK non-interactive entrypoint", () => {
  test("parseWorkflowSdkFlags ignores argv without direct workflow flags", () => {
    assert.deepEqual(parseWorkflowSdkFlags(["--headless"]), { handled: false });
  });

  test("parseWorkflowSdkFlags accepts named workflow key=value inputs", () => {
    const parsed = parseWorkflowSdkFlags([
      "--workflow",
      "deep-research-codebase",
      "prompt=map src",
      "max_partitions=2",
      "--workflow-stub-agent",
    ]);

    assert.equal(parsed.handled, true);
    assert.ok(!("error" in parsed));
    assert.equal(parsed.stubAgent, true);
    assert.deepEqual(parsed.spec, {
      mode: "workflow",
      workflow: "deep-research-codebase",
      inputs: { prompt: "map src", max_partitions: 2 },
    });
  });

  test("parseWorkflowSdkFlags accepts named workflow JSON input file as positional arg", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-workflow-sdk-inputs-"));
    const file = join(dir, "inputs.json");
    writeFileSync(file, JSON.stringify({ prompt: "from file" }), "utf8");

    const parsed = parseWorkflowSdkFlags(["--workflow", "deep-research-codebase", file]);

    assert.equal(parsed.handled, true);
    assert.ok(!("error" in parsed));
    assert.deepEqual(parsed.spec, {
      mode: "workflow",
      workflow: "deep-research-codebase",
      inputs: { prompt: "from file" },
    });
  });

  test("parseWorkflowSdkFlags accepts --inputs as named workflow JSON input file flag", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-workflow-sdk-inputs-"));
    const file = join(dir, "inputs.json");
    writeFileSync(file, JSON.stringify({ prompt: "from --inputs" }), "utf8");

    const parsed = parseWorkflowSdkFlags(["--workflow", "deep-research-codebase", "--inputs", file]);

    assert.equal(parsed.handled, true);
    assert.ok(!("error" in parsed));
    assert.deepEqual(parsed.spec, {
      mode: "workflow",
      workflow: "deep-research-codebase",
      inputs: { prompt: "from --inputs" },
    });
  });

  test("parseWorkflowSdkFlags rejects named workflow mixed input sources", () => {
    const parsed = parseWorkflowSdkFlags([
      "--workflow",
      "deep-research-codebase",
      "prompt=map src",
      "--inputs",
      "/tmp/inputs.json",
    ]);

    assert.equal(parsed.handled, true);
    assert.ok("error" in parsed);
    assert.match(parsed.error, /mutually exclusive/);
  });

  test("runs a named workflow through --workflow key=value syntax", async () => {
    const prompts: string[] = [];
    const result = await runWorkflowSdkEntrypoint({
      argv: [
        "--workflow",
        "deep-research-codebase",
        "prompt=map workflow sdk",
        "max_partitions=1",
      ],
      adapterOptions: { createAgentSession: makeSessionFactory(prompts) },
    });

    assert.equal(result.handled, true);
    assert.equal(result.status, "completed");
    assert.equal(result.details.mode, "named");
    assert.equal(result.details.status, "completed");
    assert.equal(result.details.output?.["specialist_count"], 1);
    assert.ok(prompts.some((prompt) => prompt.includes("Research question: map workflow sdk")));
  });

  test("validates named workflow inputs before starting a session", async () => {
    const prompts: string[] = [];
    const result = await runWorkflowSdkEntrypoint({
      argv: [
        "--workflow",
        "deep-research-codebase",
        "prompt=map workflow sdk",
        "max_partitions=not-a-number",
      ],
      adapterOptions: { createAgentSession: makeSessionFactory(prompts) },
    });

    assert.equal(result.handled, true);
    assert.equal(result.status, "failed");
    assert.match(result.error, /Invalid inputs/);
    assert.match(result.error, /max_partitions/);
    assert.deepEqual(prompts, []);
  });

  test("reports missing required input without starting a session", async () => {
    const prompts: string[] = [];
    const result = await runWorkflowSdkEntrypoint({
      argv: ["--workflow", "deep-research-codebase"],
      adapterOptions: { createAgentSession: makeSessionFactory(prompts) },
    });

    assert.equal(result.handled, true);
    assert.equal(result.status, "failed");
    assert.match(result.error, /required input is missing/);
    assert.deepEqual(prompts, []);
  });
});
